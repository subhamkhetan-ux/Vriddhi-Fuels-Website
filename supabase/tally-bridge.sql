-- Apply AFTER tally-schema.sql, in the TALLY project's SQL editor.
-- Idempotent. No service-role key is used by the Windows bridge.
begin;

create table if not exists public.tally_bridge_config (
  id int primary key default 1 check (id=1),
  active boolean not null default false,
  company_guid text,
  ready boolean not null default false,
  push_enabled boolean not null default true
);
insert into public.tally_bridge_config(id) values(1) on conflict do nothing;
create table if not exists public.tally_bridge_pairings (
  code_hash bytea primary key, expires_at timestamptz not null,
  created_by uuid not null, used_at timestamptz
);
create table if not exists public.tally_bridge_devices (
  id uuid primary key default gen_random_uuid(), token_hash bytea unique not null,
  label text not null, company_guid text not null,
  revoked boolean not null default false, last_seen timestamptz,
  instance uuid, instance_until timestamptz,
  health text not null default 'starting', detail text not null default '',
  version text not null default '', created_at timestamptz not null default now()
);
create unique index if not exists tally_bridge_one_device on public.tally_bridge_devices((true)) where not revoked;
alter table public.tally_vouchers add column if not exists bridge_revision bigint not null default 0;
alter table public.tally_vouchers add column if not exists bridge_guid text;
alter table public.tally_vouchers add column if not exists bridge_alter bigint;
alter table public.tally_vouchers add column if not exists bridge_state text not null default 'unlinked';
create unique index if not exists tally_bridge_voucher_guid on public.tally_vouchers(bridge_guid) where bridge_guid is not null;

create table if not exists public.tally_bridge_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('voucher','report')),
  voucher_id uuid references public.tally_vouchers(id), revision bigint,
  payload jsonb not null, state text not null default 'pending'
    check(state in ('pending','leased','writing','done','conflict','error','superseded')),
  lease_token uuid, lease_until timestamptz, attempts int not null default 0,
  write_started boolean not null default false,
  detail text not null default '', result jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(voucher_id,revision)
);
alter table public.tally_bridge_jobs add column if not exists write_started boolean not null default false;
create index if not exists tally_bridge_jobs_queue on public.tally_bridge_jobs(state,created_at);
create table if not exists public.tally_bridge_objects (
  kind text not null, guid text not null, alter_id bigint not null,
  master_id bigint not null, data jsonb not null,
  deleted boolean not null default false, updated_at timestamptz not null default now(),
  primary key(kind,guid)
);
create table if not exists public.tally_bridge_reports (
  report_key text primary key, params jsonb not null,
  content text not null, fetched_at timestamptz not null default now()
);

-- Private tables: only tightly scoped SECURITY DEFINER RPCs can access them.
do $$ declare t text; begin
  foreach t in array array['tally_bridge_config','tally_bridge_pairings','tally_bridge_devices',
    'tally_bridge_jobs','tally_bridge_objects','tally_bridge_reports'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
  end loop;
end $$;

create or replace function public._tb_hash(p text) returns bytea
language sql immutable set search_path=pg_catalog as $$ select sha256(convert_to(p,'UTF8')) $$;

create or replace function public._tb_device(p_token text, p_instance uuid default null)
returns public.tally_bridge_devices language plpgsql security definer set search_path=public,pg_temp as $$
declare d tally_bridge_devices;
begin
  select * into d from tally_bridge_devices where token_hash=_tb_hash(p_token) and not revoked for update;
  if d.id is null then raise exception 'Bridge credential invalid or revoked'; end if;
  if p_instance is not null and (d.instance is distinct from p_instance or d.instance_until < now()) then
    raise exception 'Bridge instance lease expired';
  end if;
  return d;
end $$;

create or replace function public.tally_bridge_pair_code() returns jsonb
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare code text;
begin
  perform _tally_auth();
  -- Never reveal an existing token; each code is single-use and expires.
  code := encode(_tb_hash(gen_random_uuid()::text || gen_random_uuid()::text),'hex');
  delete from tally_bridge_pairings where used_at is not null or expires_at < now();
  insert into tally_bridge_pairings values(_tb_hash(code),now()+interval '10 minutes',auth.uid(),null);
  update tally_bridge_config set active=true where id=1;
  update tally_settings set auto_clear=false where id=1;
  return jsonb_build_object('code',code,'expires_at',now()+interval '10 minutes',
    'company',(select company from tally_settings where id=1));
end $$;

create or replace function public.tally_bridge_pair(p_code text,p_token text,p_company text,p_guid text,p_label text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg tally_bridge_config; pair tally_bridge_pairings; did uuid;
begin
  if length(p_token)<>64 or p_token !~ '^[0-9a-f]+$' or length(p_guid) not between 8 and 128 then
    raise exception 'Invalid device identity';
  end if;
  select * into cfg from tally_bridge_config where id=1 for update;
  select * into pair from tally_bridge_pairings where code_hash=_tb_hash(p_code) for update;
  if pair.code_hash is null or pair.used_at is not null or pair.expires_at < now() then raise exception 'Pairing code expired or used'; end if;
  if p_company is distinct from (select company from tally_settings where id=1) then raise exception 'Company name does not match app Settings'; end if;
  if cfg.company_guid is not null and cfg.company_guid<>p_guid then raise exception 'Different company GUID: financial-year migration requires administrator review'; end if;
  update tally_bridge_devices set revoked=true where not revoked;
  insert into tally_bridge_devices(token_hash,label,company_guid) values(_tb_hash(p_token),left(p_label,100),p_guid) returning id into did;
  update tally_bridge_pairings set used_at=now() where code_hash=pair.code_hash;
  update tally_bridge_config set active=true,company_guid=p_guid,ready=false where id=1;
  return jsonb_build_object('device_id',did,'company_guid',p_guid);
end $$;

create or replace function public.tally_bridge_heartbeat(p_token text,p_instance uuid,p_health text,p_detail text,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d tally_bridge_devices;
begin
  if p_instance is null then raise exception 'Worker instance is required'; end if;
  d := _tb_device(p_token);
  if d.instance is distinct from p_instance and d.instance_until > now() then raise exception 'Another bridge process is running'; end if;
  update tally_bridge_devices set instance=p_instance,instance_until=now()+interval '90 seconds',
    last_seen=now(),health=left(p_health,40),detail=left(p_detail,300),version=left(p_version,40) where id=d.id;
  return (select to_jsonb(c) || jsonb_build_object('company',s.company,'refresh_guids',
    coalesce((select jsonb_agg(bridge_guid) from tally_vouchers where bridge_state='awaiting_tally'),'[]'::jsonb))
    from tally_bridge_config c cross join tally_settings s where c.id=1 and s.id=1);
end $$;

create or replace function public._tb_business(v public.tally_vouchers) returns jsonb
language sql immutable set search_path=pg_catalog as $$
  select jsonb_build_object('series',v.series,'number',v.number,'date',v.date,'party',v.party,
    'vehicle',v.vehicle,'qty',v.qty,'rate',v.rate,'item_amt',v.item_amt,'party_amt',v.party_amt,'roff',v.roff)
$$;

create or replace function public._tb_queue(v public.tally_vouchers) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update tally_bridge_jobs set state='superseded',updated_at=now()
    where voucher_id=v.id and state in ('pending','leased','error','conflict');
  insert into tally_bridge_jobs(kind,voucher_id,revision,payload)
    values('voucher',v.id,v.bridge_revision,_tb_business(v) || jsonb_build_object(
      'id',v.id,'guid',v.bridge_guid,'expected_alter',v.bridge_alter,
      'gst',coalesce((select to_jsonb(p)-'name' from tally_parties p where name=v.party),'{}'::jsonb)))
    on conflict(voucher_id,revision) do nothing;
end $$;

create or replace function public._tb_voucher_before() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare active boolean; changed boolean;
begin
  if current_setting('vriddhi.bridge_ingest',true)='yes' then
    if TG_OP='DELETE' then return old; else return new; end if;
  end if;
  select c.active into active from tally_bridge_config c where id=1;
  if TG_OP='DELETE' then
    if old.bridge_guid is not null or exists(select 1 from tally_bridge_jobs where voucher_id=old.id) then
      raise exception 'This voucher has bridge history. Cancel it in Tally Prime; cloud history cannot be erased.';
    end if;
    return old;
  end if;
  changed := TG_OP='INSERT';
  if TG_OP='UPDATE' then changed := _tb_business(new) is distinct from _tb_business(old); end if;
  if active and changed then
    if TG_OP='UPDATE' then
      if old.bridge_state in ('conflict','deleted','unsupported') then raise exception 'Resolve this voucher in Tally Prime before editing it here'; end if;
      if exists(select 1 from tally_bridge_jobs where voucher_id=old.id and state='writing') then raise exception 'Tally is confirming this voucher. Try again after confirmation.'; end if;
      if old.bridge_guid is not null and (new.series,new.number) is distinct from (old.series,old.number) then raise exception 'A linked invoice cannot change series or number'; end if;
    end if;
    new.bridge_revision := coalesce(old.bridge_revision,0)+1;
    new.bridge_state := 'queued';
  end if;
  return new;
end $$;
create or replace function public._tb_voucher_after() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if current_setting('vriddhi.bridge_ingest',true)='yes' then return new; end if;
  if new.bridge_state='queued' and (TG_OP='INSERT' or new.bridge_revision<>old.bridge_revision) then perform _tb_queue(new); end if;
  return new;
end $$;
drop trigger if exists tally_bridge_voucher_before on public.tally_vouchers;
create trigger tally_bridge_voucher_before before insert or update or delete on public.tally_vouchers for each row execute function public._tb_voucher_before();
drop trigger if exists tally_bridge_voucher_after on public.tally_vouchers;
create trigger tally_bridge_voucher_after after insert or update on public.tally_vouchers for each row execute function public._tb_voucher_after();

create or replace function public._tb_settings_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from tally_bridge_config where active) then
    if new.auto_clear then raise exception 'Auto-clear is unavailable while the Tally bridge retains sync history'; end if;
    if new.company<>old.company and exists(select 1 from tally_bridge_config where company_guid is not null) then
      raise exception 'Company is paired to Tally. Financial-year changes require administrator review.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tally_bridge_settings_guard on public.tally_settings;
create trigger tally_bridge_settings_guard before update on public.tally_settings for each row execute function public._tb_settings_guard();

create or replace function public.tally_bridge_claim(p_token text,p_instance uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare j tally_bridge_jobs; ready boolean; enabled boolean; recover boolean;
begin
  if p_instance is null then raise exception 'Worker instance is required'; end if;
  perform _tb_device(p_token,p_instance);
  select c.ready,c.push_enabled into ready,enabled from tally_bridge_config c where id=1;
  select * into j from tally_bridge_jobs
    where (kind='report' or (ready and enabled) or state='writing')
      and (state='pending' or (state in ('leased','writing') and lease_until<now()))
    order by (state='writing') desc,created_at limit 1 for update skip locked;
  if j.id is null then return null; end if;
  recover := j.state='writing';
  update tally_bridge_jobs set state=case when recover then 'writing' else 'leased' end,
    lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now()
    where id=j.id returning * into j;
  return to_jsonb(j)||jsonb_build_object('recover_only',recover);
end $$;

create or replace function public.tally_bridge_begin_write(p_token text,p_instance uuid,p_job uuid,p_lease uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j tally_bridge_jobs;
begin
  if p_instance is null then raise exception 'Worker instance is required'; end if;
  perform _tb_device(p_token,p_instance);
  -- Lock voucher BEFORE job: same order as the voucher trigger, avoiding deadlocks.
  perform 1 from tally_vouchers where id=(select voucher_id from tally_bridge_jobs where id=p_job) for update;
  select * into j from tally_bridge_jobs where id=p_job for update;
  if j.kind<>'voucher' or j.state<>'leased' or j.lease_token is distinct from p_lease or j.lease_until<now()
    or j.revision is distinct from (select bridge_revision from tally_vouchers where id=j.voucher_id) then
    raise exception 'Voucher changed or job lease expired';
  end if;
  if not (select ready and push_enabled from tally_bridge_config where id=1) then raise exception 'Posting is paused'; end if;
  update tally_bridge_jobs set state='writing',write_started=true,updated_at=now() where id=j.id;
  update tally_vouchers set bridge_state='confirming' where id=j.voucher_id;
end $$;

create or replace function public.tally_bridge_finish(p_token text,p_instance uuid,p_job uuid,p_lease uuid,p_state text,p_result jsonb,p_detail text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j tally_bridge_jobs;
begin
  if p_instance is null then raise exception 'Worker instance is required'; end if;
  perform _tb_device(p_token,p_instance);
  perform 1 from tally_vouchers where id=(select voucher_id from tally_bridge_jobs where id=p_job) for update;
  select * into j from tally_bridge_jobs where id=p_job for update;
  if j.state='done' then return; end if; -- acknowledgement may have been lost in transit
  if j.lease_token is distinct from p_lease or j.state not in ('leased','writing') then raise exception 'Job lease changed'; end if;
  if p_state not in ('done','conflict','error') then raise exception 'Invalid outcome'; end if;
  if j.kind='voucher' and p_state='done' then
    if length(coalesce(p_result->>'guid',''))<8 or coalesce((p_result->>'alter_id')::bigint,0)<1 then raise exception 'Read-back identity required'; end if;
    if (select bridge_revision from tally_vouchers where id=j.voucher_id)<>j.revision then raise exception 'Voucher revision changed'; end if;
    update tally_vouchers set bridge_guid=p_result->>'guid',bridge_alter=(p_result->>'alter_id')::bigint,
      bridge_state='synced',status='history',exported_at=now() where id=j.voucher_id;
    perform _tally_bump_baselines(array[j.voucher_id]);
  elsif j.kind='voucher' then
    update tally_vouchers set bridge_state=case when j.write_started then 'conflict' else 'needs_edit' end where id=j.voucher_id;
  elsif p_state='done' then
    if length(coalesce(p_result->>'content','')) not between 1 and 2000000 then raise exception 'Invalid report size'; end if;
    insert into tally_bridge_reports(report_key,params,content) values(j.payload->>'key',j.payload,p_result->>'content')
      on conflict(report_key) do update set content=excluded.content,params=excluded.params,fetched_at=now();
    p_result := '{}'::jsonb; -- report HTML is stored once
  end if;
  update tally_bridge_jobs set state=p_state,result=p_result,detail=left(p_detail,500),updated_at=now() where id=j.id;
end $$;

create or replace function public.tally_bridge_ingest(p_token text,p_instance uuid,p_objects jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare o jsonb; a jsonb; v tally_vouchers; old_alter bigint; k text; g text; incoming bigint; pending boolean;
begin
  if p_instance is null then raise exception 'Worker instance is required'; end if;
  perform _tb_device(p_token,p_instance);
  if jsonb_typeof(p_objects)<>'array' or jsonb_array_length(p_objects)>100 or octet_length(p_objects::text)>4000000 then raise exception 'Invalid sync batch'; end if;
  perform set_config('vriddhi.bridge_ingest','yes',true);
  for o in select value from jsonb_array_elements(p_objects) loop
    k:=o->>'kind'; g:=o->>'guid'; incoming:=(o->>'alter_id')::bigint;
    if k not in ('Voucher','Ledger','Group','StockItem','StockGroup','Unit','Godown','VoucherType','CostCentre','Currency')
      or length(g) not between 1 and 128 or incoming<0 then raise exception 'Invalid object'; end if;
    select alter_id into old_alter from tally_bridge_objects where kind=k and guid=g;
    if old_alter is not null and incoming<old_alter then raise exception 'Tally version moved backwards; restore needs reconciliation'; end if;
    insert into tally_bridge_objects(kind,guid,alter_id,master_id,data,deleted)
      values(k,g,incoming,(o->>'master_id')::bigint,o->'data',coalesce((o->>'deleted')::boolean,false))
      on conflict(kind,guid) do update set alter_id=excluded.alter_id,master_id=excluded.master_id,
        data=excluded.data,deleted=excluded.deleted,updated_at=now();
    if k='Ledger' and coalesce((o->>'deleted')::boolean,false)=false and o->'data'->>'name' is not null
      and coalesce((o->'data'->>'is_debtor')::boolean,false) then
      insert into tally_parties(name,gstin,reg_type,state,place_of_supply,pincode,country)
        values(o->'data'->>'name',o->'data'->>'gstin',o->'data'->>'reg_type',o->'data'->>'state',o->'data'->>'place_of_supply',o->'data'->>'pincode',o->'data'->>'country')
        on conflict(name) do update set gstin=excluded.gstin,reg_type=excluded.reg_type,state=excluded.state,
          place_of_supply=excluded.place_of_supply,pincode=excluded.pincode,country=excluded.country;
    end if;
    if k<>'Voucher' then continue; end if;
    -- Reserve numbers observed in Tally even when their allocations cannot fit the fuel editor.
    update tally_series set baseline=o->'data'->>'number'
      where key=case o->'data'->>'voucher_type' when 'HSD CREDIT' then 'hsd' when 'MS CREDIT' then 'ms' when 'XG CREDIT' then 'xg' end
      and _tally_numpart(o->'data'->>'number')>_tally_numpart(baseline);
    select * into v from tally_vouchers where bridge_guid=g for update;
    a := o->'data'->'app_voucher';
    if v.id is null and a is not null and a<>'null'::jsonb then
      select * into v from tally_vouchers where series=a->>'series' and number=a->>'number' for update;
      if v.id is not null and v.bridge_guid is distinct from g then
        -- A pending/manual invoice with this number is never silently overwritten.
        continue;
      end if;
    end if;
    if v.id is not null then
      if exists(select 1 from tally_bridge_jobs where voucher_id=v.id and state='writing') then continue; end if;
      pending := v.bridge_state in ('queued','conflict','confirming','needs_edit');
      if pending and (incoming is distinct from v.bridge_alter or coalesce((o->>'deleted')::boolean,false)) then
        update tally_vouchers set bridge_state='conflict' where id=v.id;
        update tally_bridge_jobs set state='conflict',detail='Tally and web versions differ. Review in Tally Prime.',updated_at=now()
          where voucher_id=v.id and state in ('pending','leased','error');
        continue;
      elsif pending then continue;
      end if;
      if coalesce((o->>'deleted')::boolean,false) or coalesce((o->'data'->>'cancelled')::boolean,false) then
        update tally_vouchers set bridge_state='deleted',bridge_alter=incoming where id=v.id;
        continue;
      end if;
      if a is null or a='null'::jsonb then
        update tally_vouchers set bridge_state='unsupported',bridge_alter=incoming where id=v.id;
        continue;
      end if;
    end if;
    if a is null or a='null'::jsonb or coalesce((o->>'deleted')::boolean,false) then continue; end if;
    if a->>'series' not in ('hsd','ms','xg') or (a->>'qty')::numeric<=0
      or abs((a->>'party_amt')::numeric-(a->>'item_amt')::numeric-(a->>'roff')::numeric)>0.01 then raise exception 'Invalid fuel voucher'; end if;
    if v.id is null then
      insert into tally_vouchers(series,number,date,party,vehicle,qty,rate,item_amt,party_amt,roff,status,source,bridge_guid,bridge_alter,bridge_state)
        values(a->>'series',a->>'number',(a->>'date')::date,a->>'party',coalesce(a->>'vehicle',''),
          (a->>'qty')::numeric,(a->>'rate')::numeric,(a->>'item_amt')::numeric,(a->>'party_amt')::numeric,(a->>'roff')::numeric,
          'history','tally',g,incoming,'synced') returning * into v;
    else
      update tally_vouchers set date=(a->>'date')::date,party=a->>'party',vehicle=coalesce(a->>'vehicle',''),
        qty=(a->>'qty')::numeric,rate=(a->>'rate')::numeric,item_amt=(a->>'item_amt')::numeric,
        party_amt=(a->>'party_amt')::numeric,roff=(a->>'roff')::numeric,bridge_guid=g,bridge_alter=incoming,
        bridge_state='synced',status='history',updated_at=now() where id=v.id;
    end if;
    perform _tally_bump_baselines(array[v.id]);
  end loop;
  perform set_config('vriddhi.bridge_ingest','no',true);
end $$;

create or replace function public.tally_bridge_ready(p_token text,p_instance uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_instance is null then raise exception 'Worker instance is required'; end if;
  perform _tb_device(p_token,p_instance);
  update tally_bridge_config set ready=true where id=1;
end $$;

create or replace function public.tally_bridge_status() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform _tally_auth();
  return jsonb_build_object('config',(select to_jsonb(c) from tally_bridge_config c where id=1),
    'device',(select jsonb_build_object('id',id,'label',label,'last_seen',last_seen,'health',health,'detail',detail,'version',version)
      from tally_bridge_devices where not revoked),
    'pending',(select count(*) from tally_bridge_jobs where state in ('pending','leased','writing')),
    'attention',(select count(*) from tally_bridge_jobs where state in ('conflict','error')),
    'objects',(select count(*) from tally_bridge_objects where not deleted),
    'jobs',coalesce((select jsonb_agg(x) from (select id,kind,voucher_id,state,write_started,detail,updated_at,payload->>'number' as number,
      payload->>'report' as report,payload->>'guid' as linked_guid from tally_bridge_jobs where state<>'superseded'
      order by (state in ('conflict','error')) desc,updated_at desc limit 40) x),'[]'::jsonb));
end $$;

create or replace function public.tally_bridge_control(p_action text,p_voucher uuid default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v tally_vouchers; o tally_bridge_objects; sk text;
begin
  perform _tally_auth();
  if p_action='pause' then update tally_bridge_config set push_enabled=false where id=1;
  elsif p_action='resume' then update tally_bridge_config set push_enabled=true where id=1;
  elsif p_action='revoke' then
    update tally_bridge_devices set revoked=true where not revoked;
    update tally_bridge_config set ready=false,push_enabled=false where id=1;
    delete from tally_bridge_pairings;
  elsif p_action='queue' then
    if not (select active from tally_bridge_config where id=1) then raise exception 'Pair a PC first'; end if;
    select * into v from tally_vouchers where id=p_voucher for update;
    if v.id is null or v.bridge_state<>'unlinked' then raise exception 'Only unlinked vouchers can be queued'; end if;
    update tally_vouchers set bridge_state='queued',bridge_revision=bridge_revision+1 where id=v.id;
  elsif p_action='retry' then
    select * into v from tally_vouchers where id=p_voucher for update;
    if v.id is null or v.bridge_state not in ('conflict','needs_edit') or not exists(select 1 from tally_bridge_jobs
      where voucher_id=v.id and revision=v.bridge_revision and state in ('conflict','error') and not write_started)
      then raise exception 'This posting may have reached Tally. Use Recheck Tally.'; end if;
    update tally_bridge_jobs set state='pending',lease_token=null,lease_until=null,updated_at=now()
      where voucher_id=v.id and revision=v.bridge_revision and state in ('conflict','error') and not write_started;
    update tally_vouchers set bridge_state='queued' where id=v.id;
  elsif p_action='renumber' then
    select series into sk from tally_vouchers where id=p_voucher;
    perform pg_advisory_xact_lock(hashtext('tally_series_'||sk));
    select * into v from tally_vouchers where id=p_voucher for update;
    if v.id is null or v.series<>sk or v.bridge_guid is not null or v.bridge_state<>'needs_edit'
      or exists(select 1 from tally_bridge_jobs where voucher_id=v.id and write_started) then
      raise exception 'Only a new voucher that has never been posted can receive a new number';
    end if;
    update tally_vouchers set number=_tally_next_number(v.series),status='pending',updated_at=now() where id=v.id;
  elsif p_action='recheck' then
    select * into v from tally_vouchers where id=p_voucher for update;
    if v.id is null or v.bridge_state not in ('conflict','needs_edit') then raise exception 'Only conflicted vouchers can be rechecked'; end if;
    update tally_bridge_jobs set state='writing',lease_until=now()-interval '1 second',updated_at=now()
      where voucher_id=v.id and revision=v.bridge_revision and state in ('conflict','error');
    update tally_vouchers set bridge_state='confirming' where id=v.id;
  elsif p_action='use_tally' then
    select * into v from tally_vouchers where id=p_voucher for update;
    if v.id is null or v.bridge_guid is null or v.bridge_state not in ('conflict','needs_edit')
      or exists(select 1 from tally_bridge_jobs where voucher_id=v.id and state='writing') then
      raise exception 'Resolve the uncertain posting in Tally Prime first';
    end if;
    select * into o from tally_bridge_objects where kind='Voucher' and guid=v.bridge_guid;
    if o.guid is null then raise exception 'Wait for a fresh Tally snapshot'; end if;
    update tally_bridge_jobs set state='superseded',updated_at=now() where voucher_id=v.id and state in ('conflict','error','pending','leased');
    -- The worker's next snapshot applies Tally's version. Local edit stays visible until then.
    update tally_vouchers set bridge_state='awaiting_tally' where id=v.id;
  else raise exception 'Unknown action'; end if;
end $$;

create or replace function public.tally_bridge_report(p_report text,p_from date,p_to date,p_ledger text default '',p_refresh boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare params jsonb; k text; j tally_bridge_jobs; cached tally_bridge_reports;
begin
  perform _tally_auth();
  if p_report not in ('daybook','ledger','trial_balance','balance_sheet','profit_loss','receivables','payables','stock','cash_bank')
    or p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 or length(p_ledger)>250
    or (p_report='ledger' and length(trim(p_ledger))=0) then raise exception 'Invalid report or period'; end if;
  params:=jsonb_build_object('report',p_report,'from',p_from,'to',p_to,'ledger',case when p_report='ledger' then p_ledger else '' end);
  k:=encode(_tb_hash(params::text),'hex');
  perform pg_advisory_xact_lock(hashtext(k));
  select * into cached from tally_bridge_reports where report_key=k;
  select * into j from tally_bridge_jobs where kind='report' and payload->>'key'=k order by created_at desc limit 1;
  if p_refresh and (j.id is null or j.state not in ('pending','leased')) then
    insert into tally_bridge_jobs(kind,payload) values('report',params||jsonb_build_object('key',k)) returning * into j;
  end if;
  return jsonb_build_object('key',k,'content',cached.content,'fetched_at',cached.fetched_at,'state',j.state,'detail',j.detail,'params',params);
end $$;

create or replace function public.tally_bridge_browse(p_kind text,p_search text default '',p_offset int default 0)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform _tally_auth();
  if p_offset<0 or p_offset>1000000 or length(p_search)>100 then raise exception 'Invalid search'; end if;
  return coalesce((select jsonb_agg(x) from (select kind,guid,alter_id,deleted,updated_at,data-'xml' as data
    from tally_bridge_objects where kind=p_kind and
      (coalesce(data->>'name','') ilike '%'||p_search||'%' or coalesce(data->>'number','') ilike '%'||p_search||'%'
        or coalesce(data->>'party','') ilike '%'||p_search||'%')
    order by updated_at desc,guid limit 50 offset p_offset) x),'[]'::jsonb);
end $$;

create or replace function public.tally_bridge_object(p_kind text,p_guid text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform _tally_auth();
  return (select to_jsonb(o) from tally_bridge_objects o where kind=p_kind and guid=p_guid);
end $$;

-- Keep the manual-import guard in sync with tally-schema.sql.
create or replace function public.tally_import_daybook(p_vouchers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r          jsonb;
  added      jsonb := '{"hsd":0,"ms":0,"xg":0}'::jsonb;
  updated    int := 0;
  sk         text;
  new_p      int := 0;
  best       text;
  v_inserted boolean;
begin
  perform _tally_auth();
  if to_regclass('public.tally_bridge_config') is not null then
    if exists(select 1 from public.tally_bridge_config where active) then
      raise exception 'Manual DayBook import is disabled while paired. Refresh through the Tally bridge.';
    end if;
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_vouchers,'[]'::jsonb)) loop
    sk := r->>'seriesKey';
    if sk not in ('hsd','ms','xg') then continue; end if;
    insert into tally_vouchers
      (series, number, date, party, vehicle, qty, rate, item_amt, party_amt, roff,
       status, source, created_by)
    values
      (sk, r->>'number', (r->>'dateISO')::date, r->>'party',
       coalesce(r->>'vehicle',''), (r->>'qty')::numeric, (r->>'rate')::numeric,
       (r->>'amount')::numeric, (r->>'amount')::numeric, 0,
       'history', 'tally', auth.uid())
    on conflict (series, number) do update set
      date = excluded.date, party = excluded.party, vehicle = excluded.vehicle,
      qty = excluded.qty, rate = excluded.rate, item_amt = excluded.item_amt,
      party_amt = excluded.party_amt, roff = excluded.roff,
      status = 'history', source = 'tally', exported_at = null, updated_at = now()
    returning (xmax = 0) into v_inserted;
    if v_inserted then
      added := jsonb_set(added, array[sk], to_jsonb((added->>sk)::int + 1));
    else
      updated := updated + 1;
    end if;
    if not exists (select 1 from tally_parties where name = r->>'party') then
      insert into tally_parties (name) values (r->>'party') on conflict do nothing;
      new_p := new_p + 1;
    end if;
  end loop;

  -- advance baselines to the highest number now present
  for sk in select key from tally_series loop
    select number into best from tally_vouchers
      where series = sk order by _tally_numpart(number) desc limit 1;
    if best is not null then
      update tally_series set baseline = best
        where key = sk and _tally_numpart(baseline) < _tally_numpart(best);
    end if;
  end loop;

  -- today's price = rate of the latest voucher per series in this file
  update tally_series ts set rate = latest.rate
  from (
    select distinct on (x->>'seriesKey')
           x->>'seriesKey' as key, (x->>'rate')::numeric as rate
    from jsonb_array_elements(coalesce(p_vouchers,'[]'::jsonb)) x
    where (x->>'rate')::numeric > 0
    order by x->>'seriesKey', (x->>'dateISO')::date desc, _tally_numpart(x->>'number') desc
  ) latest
  where ts.key = latest.key;

  return jsonb_build_object('added', added, 'updated', updated, 'newParties', new_p);
end $$;


-- Only the device capability endpoints are callable with the public API key.
do $$ declare f record; begin
  for f in select oid::regprocedure as signature,proname from pg_proc where pronamespace='public'::regnamespace
    and (proname like 'tally_bridge_%' or proname like '\_tb\_%' escape '\') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    if f.proname in ('tally_bridge_pair','tally_bridge_heartbeat','tally_bridge_claim','tally_bridge_begin_write',
      'tally_bridge_finish','tally_bridge_ingest','tally_bridge_ready') then
      execute format('grant execute on function %s to anon',f.signature);
    elsif f.proname like 'tally_bridge_%' then
      execute format('grant execute on function %s to authenticated',f.signature);
    end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
