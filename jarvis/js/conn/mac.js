// The Mac: XtraPower monitor and the owner's scripts, through the Jarvis
// bridge (jarvis/bridge/). Jarvis queues a command in the ledger project
// (jarvis_send, supabase/jarvis-schema.sql); the bridge on the Mac runs it
// and posts the result, which is read back here.

import { signedIn } from '../session.js';

const WAIT_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(c, fn, args) {
  const { data, error } = await c.rpc(fn, args);
  if (error) {
    if (/jarvis_/.test(error.message) && /(does not exist|Could not find)/i.test(error.message)) {
      throw new Error('The Mac link isn\'t set up yet: run supabase/jarvis-schema.sql in the ledger project (see jarvis/README.md).');
    }
    throw new Error(error.message);
  }
  return data;
}

// one command, start to finish -> the bridge's result ({text, ...})
async function send(ctx, action, args = {}) {
  if (ctx.demo) return demoRun(action, args);
  const c = await signedIn('ledger', 'the Ledger');
  const bridges = await rpc(c, 'jarvis_bridges_list', {});
  const mac = (bridges || []).find((b) => b.name === 'mac');
  if (!mac || !mac.online) {
    const err = new Error(mac
      ? `The Mac is offline (last seen ${new Date(mac.seen_at).toLocaleString('en-IN')}). Is it on and awake, with the bridge running (./jarvis/bridge/bridge-mac.sh start)?`
      : 'The Jarvis bridge has never checked in. Set it up on the Mac: ./jarvis/bridge/bridge-mac.sh setup (see jarvis/README.md).');
    err.offline = true;
    throw err;
  }
  const id = await rpc(c, 'jarvis_send', { p_action: action, p_args: args, p_target: 'mac' });
  ctx.progress('Sent to the Mac…');
  const until = Date.now() + WAIT_MS;
  let delay = 700;
  while (Date.now() < until) {
    await sleep(delay);
    delay = Math.min(2000, delay + 300);
    const cmd = await rpc(c, 'jarvis_command', { p_id: id });
    if (cmd?.status === 'running') ctx.progress('The Mac is on it…');
    if (cmd?.status === 'done') return cmd.result || { text: 'Done.' };
    if (cmd?.status === 'failed' || cmd?.status === 'expired') throw new Error(cmd.error || 'The Mac couldn\'t do it.');
  }
  throw new Error('The Mac hasn\'t answered within a minute — it may still be working on it. Ask for the XtraPower status in a moment.');
}

const wrap = (action, argsOf = (i) => i) => async (input, ctx) => {
  const res = await send(ctx, action, argsOf(input));
  const { text, ...rest } = res || {};
  return { summary: { result: text, ...rest }, say: text, app: 'xtrapower' };
};

// ---- demo: a pretend Mac ------------------------------------------------------------
const demoMac = {
  running: false,
  accounts: [
    { label: 'Shyam Metalics', customer_id: '1005218882', watch: true, chrome_open: true, last_ccms: '₹4,12,560.00' },
    { label: 'Ember Coal', customer_id: '1005079471', watch: false, chrome_open: false, last_ccms: '₹1,85,000.00' },
    { label: 'SSL XP', customer_id: '1005133705', watch: false, chrome_open: false, last_ccms: null },
  ],
};
async function demoRun(action, args) {
  await sleep(600);
  const m = demoMac;
  const pick = (q) => m.accounts.find((a) => a.label.toLowerCase().includes(String(q || '').toLowerCase().split(' ')[0]));
  switch (action) {
    case 'xtrapower.status':
      return { text: `Monitoring is ${m.running ? 'ON' : 'OFF'}. ${m.accounts.map((a) => `${a.label}: ${a.watch ? 'watching' : 'off'}${a.last_ccms ? `, CCMS ${a.last_ccms}` : ''}.`).join(' ')}`, running: m.running, accounts: m.accounts };
    case 'xtrapower.start': m.running = true; return { text: 'XtraPower monitoring is ON.' };
    case 'xtrapower.stop': m.running = false; return { text: 'XtraPower monitoring is OFF.' };
    case 'xtrapower.logs': return { text: 'The last 3 log lines.', lines: ['10:02 Shyam Metalics CCMS ₹4,12,560.00 (no change)', '10:04 Shyam Metalics CCMS ₹4,12,560.00 (no change)', '10:06 Shyam Metalics CCMS ₹4,12,560.00 (no change)'] };
    case 'xtrapower.watch': {
      const a = pick(args.account);
      if (!a) throw new Error(`No XtraPower account matches "${args.account}". Accounts: ${m.accounts.map((x) => x.label).join(', ')}`);
      a.watch = args.watch !== false;
      const notes = [];
      if (a.watch && !a.chrome_open) { a.chrome_open = true; notes.push('opened its Chrome window — log in there and leave it on Balance Info'); }
      if (a.watch && !m.running) { m.running = true; notes.push('started the monitor'); }
      if (!a.watch && !m.accounts.some((x) => x.watch)) { m.running = false; return { text: `Stopped watching ${a.label}. No account is left, so I turned the monitor off.` }; }
      return { text: a.watch ? `Now watching ${a.label}${notes.length ? ` — ${notes.join(', ')}.` : '.'}` : `Stopped watching ${a.label}.` };
    }
    case 'xtrapower.open_window': return { text: `Opened the Chrome window for ${pick(args.account)?.label || args.account}.` };
    case 'script.list': return { text: 'Scripts I can run: Payment agent status, Bank to Tally app.', scripts: [{ name: 'payment_agent_status', label: 'Payment agent status' }, { name: 'bank_tally_app', label: 'Bank to Tally app' }] };
    case 'script.run': return { text: `Ran ${args.name}.`, output: '● The payment agent is running.' };
    default: throw new Error(`The bridge doesn't know "${action}".`);
  }
}

// ---- tools ---------------------------------------------------------------------
const account = { type: 'string', description: 'The XtraPower account as the owner said it (label or customer id), e.g. "Ember Coal", "shyam".' };

export const tools = [
  {
    name: 'xtrapower_status',
    app: 'xtrapower',
    label: () => 'XtraPower status',
    description: 'XtraPower CCMS monitor on the Mac: whether monitoring is on, and for each fleet-card account whether it is watched, its Chrome window is open, its last CCMS balance and any problem.',
    input_schema: { type: 'object', properties: {} },
    run: wrap('xtrapower.status'),
  },
  {
    name: 'xtrapower_watch',
    app: 'xtrapower',
    label: (i) => `${i.watch === false ? 'Stop' : 'Start'} monitoring · ${i.account}`,
    description: 'Start (watch=true) or stop (watch=false) monitoring ONE XtraPower account\'s CCMS balance. Starting also opens that account\'s Chrome window if it is closed and starts the monitor if it is off; stopping the last watched account turns the monitor off. The owner gets a Telegram alert on every credit. Use this for "monitor <account>".',
    input_schema: { type: 'object', properties: { account, watch: { type: 'boolean' } }, required: ['account'] },
    run: wrap('xtrapower.watch', (i) => ({ account: i.account, watch: i.watch !== false })),
  },
  {
    name: 'xtrapower_monitor',
    app: 'xtrapower',
    label: (i) => `XtraPower monitor ${i.action}`,
    description: 'Turn the whole XtraPower monitor on or off on the Mac (all watched accounts). Use xtrapower_watch for one account.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop'] } }, required: ['action'] },
    run: async (input, ctx) => wrap(input.action === 'stop' ? 'xtrapower.stop' : 'xtrapower.start', () => ({}))(input, ctx),
  },
  {
    name: 'xtrapower_logs',
    app: 'xtrapower',
    label: () => 'XtraPower logs',
    description: 'The XtraPower monitor\'s latest log lines (to see what it has been doing or why it stopped).',
    input_schema: { type: 'object', properties: { lines: { type: 'integer', minimum: 1, maximum: 80 } } },
    run: wrap('xtrapower.logs', (i) => ({ lines: i.lines || 20 })),
  },
  {
    name: 'xtrapower_open_window',
    app: 'xtrapower',
    label: (i) => `Open XtraPower window · ${i.account}`,
    description: 'Open one XtraPower account\'s Chrome login window on the Mac (e.g. after the session expired).',
    input_schema: { type: 'object', properties: { account }, required: ['account'] },
    run: wrap('xtrapower.open_window'),
  },
  {
    name: 'mac_scripts',
    app: 'mac',
    label: () => 'Mac scripts',
    description: 'The scripts the owner has allowed Jarvis to run on the Mac (set up in jarvis/bridge/config.json), e.g. the payment agent\'s status or the Tally apps.',
    input_schema: { type: 'object', properties: {} },
    run: wrap('script.list'),
  },
  {
    name: 'mac_run_script',
    app: 'mac',
    label: (i) => `Run on Mac · ${i.name}`,
    description: 'Run one of the scripts listed by mac_scripts on the Mac (by its name or label). The owner confirms first.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: async (input, ctx) => {
      const ok = await ctx.confirm({ title: 'Run this on the Mac?', rows: [[input.name]], ok: 'Run it' });
      if (!ok) return { summary: { ran: false, declined_by_owner: true }, say: 'Not run.' };
      return wrap('script.run', (i) => ({ name: i.name }))(input, ctx);
    },
  },
];
