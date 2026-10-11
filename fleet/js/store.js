// Where the fleet data lives. Both stores answer the same calls:
//   supabaseStore(client) — the fleet_* functions in supabase/fleet-schema.sql,
//                           in the ledger's Supabase project (same logins)
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
  };
}
