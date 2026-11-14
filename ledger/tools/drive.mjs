// Google Drive, the little the monthly register PDFs need: a folder by its
// path (made when missing), the files in it, and an upload (or a new
// version of a file already there). Plain REST with fetch — no SDK.
//
// token: the authorized-user JSON minted by ledger/tools/mint_drive_token.py
// ({client_id, client_secret, refresh_token, ...}); fetchFn is swappable for tests.

const FOLDER = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function ok(res, what) {
  if (res.ok) return res.status === 204 ? null : res.json();
  const body = await res.text().catch(() => '');
  throw new Error(`Google Drive: ${what} failed (${res.status}): ${body.slice(0, 300)}`);
}

export async function accessToken(token, fetchFn = fetch) {
  const t = typeof token === 'string' ? JSON.parse(token) : token;
  if (!t || !t.refresh_token || !t.client_id || !t.client_secret) {
    throw new Error('GDRIVE_TOKEN must be the JSON printed by ledger/tools/mint_drive_token.py (client_id, client_secret, refresh_token).');
  }
  const res = await fetchFn(t.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id, client_secret: t.client_secret }).toString(),
  });
  const j = await ok(res, 'signing in (is the GDRIVE_TOKEN still valid?)');
  return j.access_token;
}

export function drive(access, fetchFn = fetch) {
  const auth = { Authorization: `Bearer ${access}` };
  const list = async (query, fields = 'files(id,name,mimeType,modifiedTime)') => {
    const u = `${API}/files?${new URLSearchParams({ q: query, fields, pageSize: '200', spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`;
    return (await ok(await fetchFn(u, { headers: auth }), 'listing a folder')).files || [];
  };
  const api = {
    // 'Vriddhi Fuels/Registers/FY 2026-27' under My Drive -> the last folder's id (made when missing)
    async folder(path) {
      let parent = 'root';
      for (const name of String(path).split('/').map((x) => x.trim()).filter(Boolean)) {
        const found = await list(`name = '${q(name)}' and mimeType = '${FOLDER}' and '${parent}' in parents and trashed = false`);
        if (found.length) { parent = found[0].id; continue; }
        const made = await ok(await fetchFn(`${API}/files?supportsAllDrives=true`, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
        }), `making the folder ${name}`);
        parent = made.id;
      }
      return parent;
    },
    // the files in a folder: {name: id}
    async files(folderId) {
      const out = {};
      for (const f of await list(`'${folderId}' in parents and trashed = false and mimeType != '${FOLDER}'`)) out[f.name] = f.id;
      return out;
    },
    // a PDF into the folder; with existingId, a new version of that file
    async upload(folderId, name, bytes, existingId = null, mime = 'application/pdf') {
      const boundary = `vriddhi${Date.now().toString(36)}`;
      const meta = existingId ? { name } : { name, parents: [folderId] };
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
        Buffer.from(bytes),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const url = existingId ? `${UPLOAD}/files/${existingId}?uploadType=multipart&supportsAllDrives=true` : `${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true`;
      return ok(await fetchFn(url, { method: existingId ? 'PATCH' : 'POST', headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` }, body }), `uploading ${name}`);
    },
  };
  return api;
}
