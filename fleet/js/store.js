// Where the fleet data lives. Both stores answer the same calls:
//   supabaseStore(client) — the fleet_* functions in supabase/fleet-schema.sql,
//                           in the fleet app's own Supabase project
//   memoryStore(seed)     — the demo: made-up data in this browser tab only

export function supabaseStore(client) {
  const rpc = async (fn, args = {}) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      if (/fleet_\w+|function .* does not exist|schema cache/i.test(error.message || '') && /not find|does not exist|schema cache/i.test(error.message || '')) {
        const e = new Error('The fleet tables aren\'t in the database yet. Run supabase/fleet-schema.sql once in the Supabase SQL Editor (see fleet/README.md).');
        e.code = 'NO_SCHEMA';
        throw e;
      }
      throw new Error(error.message || String(error));
    }
    return data;
  };
  return {
    kind: 'supabase',
    whoami: () => rpc('fleet_whoami'),
    latest: () => rpc('fleet_latest'),
    save: (fileName, payload) => rpc('fleet_save', { p_file_name: fileName, p_payload: payload }),
    uploads: (limit = 10) => rpc('fleet_uploads_list', { p_limit: limit }),
    settings: () => rpc('fleet_settings_get'),
    saveSettings: (value) => rpc('fleet_settings_save', { p_value: value }),
    // the Trip Register the Mac's sync uploaded (Storage bucket fleet-uploads): {name, updated_at, size} or null
    macUpload: async () => {
      const { data, error } = await client.storage.from('fleet-uploads').list('', { limit: 20, sortBy: { column: 'updated_at', order: 'desc' } });
      if (error) throw new Error(error.message || String(error));
      const o = (data || []).find((x) => x.id && x.name === 'trip-register.xlsm');
      return o ? { name: o.name, updated_at: o.updated_at || o.created_at, size: o.metadata ? o.metadata.size : null } : null;
    },
    macUploadFile: async (name) => {
      const { data, error } = await client.storage.from('fleet-uploads').download(name);
      if (error) throw new Error(error.message || String(error));
      return data;
    },
    // SSFC's monthly statements as read (ssfcstmt.js compactStatement()), one file a month: ssfc/2026-09.json
    ssfcList: async () => {
      const { data, error } = await client.storage.from('fleet-uploads').list('ssfc', { limit: 200 });
      if (error) throw new Error(error.message || String(error));
      return (data || []).map((x) => (x.name.match(/^(\d{4}-\d{2})\.json$/) || [])[1]).filter(Boolean).sort();
    },
    ssfcGet: async (month) => {
      const { data, error } = await client.storage.from('fleet-uploads').download(`ssfc/${month}.json`);
      if (error) throw new Error(error.message || String(error));
      return JSON.parse(await data.text());
    },
    ssfcSave: async (month, value) => {
      const body = new Blob([JSON.stringify(value)], { type: 'application/json' });
      const { error } = await client.storage.from('fleet-uploads').upload(`ssfc/${month}.json`, body, { upsert: true, contentType: 'application/json' });
      if (error) throw new Error(error.message || String(error));
    },
    ssfcRemove: async (month) => {
      const { error } = await client.storage.from('fleet-uploads').remove([`ssfc/${month}.json`]);
      if (error) throw new Error(error.message || String(error));
    },
  };
}

export function memoryStore(seed = null, { email = 'demo@example.com', settings: seedSettings = null } = {}) {
  const uploads = [];
  const add = (fileName, payload) => {
    const row = {
      id: uploads.length + 1, file_name: fileName || '', latest_trip: payload.latest || null,
      counts: { trips: payload.trips.length }, by_email: email, created_at: new Date().toISOString(),
    };
    uploads.unshift({ ...row, payload: JSON.parse(JSON.stringify(payload)) });
    return row;
  };
  if (seed) add(seed.fileName || 'Demo Trip Register.xlsm', seed);
  let settings = { value: seedSettings || {} };
  const ssfc = new Map();
  return {
    kind: 'memory',
    whoami: async () => ({ email, member: true }),
    latest: async () => {
      if (!uploads.length) return null;
      const { payload, ...meta } = uploads[0];
      return { meta, payload };
    },
    save: async (fileName, payload) => add(fileName, payload),
    uploads: async (limit = 10) => uploads.slice(0, limit).map(({ payload, ...meta }) => meta),
    settings: async () => JSON.parse(JSON.stringify(settings)),
    saveSettings: async (value) => {
      settings = { value: JSON.parse(JSON.stringify(value)), by_email: email, updated_at: new Date().toISOString() };
      return JSON.parse(JSON.stringify(settings));
    },
    ssfcList: async () => [...ssfc.keys()].sort(),
    ssfcGet: async (month) => JSON.parse(ssfc.get(month)),
    ssfcSave: async (month, value) => { ssfc.set(month, JSON.stringify(value)); },
    ssfcRemove: async (month) => { ssfc.delete(month); },
  };
}
