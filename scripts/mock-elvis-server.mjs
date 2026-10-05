/**
 * A strict stand-in for an Elvis server, for testing electron/elvisClient.cjs.
 *
 * It is deliberately unforgiving: every call except /login must carry valid
 * credentials, writes must be form-encoded with `metadata` as a JSON string,
 * and anything else is rejected the way a real server would reject it. Two
 * dialects, because both are deployed:
 *
 *   token  — Elvis 6 / WoodWing Assets: login returns `authToken`, later
 *            calls send `Authorization: Bearer <authToken>`.
 *   cookie — Elvis 5: login sets a session cookie and returns `csrfToken`;
 *            later calls need the cookie and an `X-CSRF-TOKEN` header.
 *
 * Files: `create` and `update` with a file must be multipart with the file in
 * `Filedata`; `create` refuses a path that already holds an asset, and
 * `update` with a file checks in a new version (versionNumber + 1, same id).
 * `search` understands `folderPath:"…"`; any other query matches everything —
 * including the tracking file, which the sync must know to skip.
 */
import http from 'node:http';

export const USER = 'photodesk';
export const PASSWORD = 'correct horse';

/** A 1×1 JPEG, so previews are real image bytes. */
const PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

/** Fresh assets per server — writes land on these, so later searches see them. */
function seedAssets(count) {
  const photo = (id, n, extra = {}) => ({
    id,
    metadata: { filename: `IMG_${n}.CR3`, name: `IMG_${n}.CR3`, folderPath: '/Shoots/Gala', assetPath: `/Shoots/Gala/IMG_${n}.CR3`, ...extra },
  });
  const assets = [photo('A1', 4821, { cf_usagePlacement: 'mag', cf_spreadNum: '12' }), photo('A2', 4822, { cf_usagePlacement: 'both' })];
  for (let i = 3; i <= count; i++) assets.push(photo(`A${i}`, 4820 + i));
  return assets;
}

/** Split a multipart/form-data body into text fields and files. */
function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return null;
  const delimiter = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = {};
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const start = at + delimiter.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) return null;
    const part = body.slice(start + 2, next - 2); // drop the CRLF after the delimiter and before the next
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) return null;
    const head = part.slice(0, split).toString('utf8');
    const content = part.slice(split + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const fileName = /filename="([^"]*)"/.exec(head)?.[1];
    if (name && fileName !== undefined) files[name] = { fileName, bytes: content };
    else if (name) fields[name] = content.toString('utf8');
    at = next;
  }
  return { fields, files };
}

export function startMockElvis({ dialect = 'token', assetCount = 2, pageCap = 200 } = {}) {
  const ASSETS = seedAssets(assetCount);
  const state = { logins: 0, updates: [], uploads: [], log: [], expireNext: false, assets: ASSETS, imageFetches: 0, files: new Map(), nextId: 1 };
  const TOKEN = 'tok-abc123';
  const CSRF = 'csrf-xyz789';
  const SESSION = 'JSESSIONID=sess-42';

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const authorised = (req) => {
    if (state.expireNext) return false;
    if (dialect === 'token') return req.headers.authorization === `Bearer ${TOKEN}`;
    return (req.headers.cookie || '').includes(SESSION) && req.headers['x-csrf-token'] === CSRF;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBytes = Buffer.concat(chunks);
      const raw = rawBytes.toString('utf8');
      const isForm = (req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');
      const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/form-data');
      const params = new URLSearchParams(req.method === 'GET' ? url.search : isForm ? raw : '');
      state.log.push(`${req.method} ${url.pathname}`);

      if (url.pathname.startsWith('/file/')) {
        if (!authorised(req)) return send(res, 401, { errorcode: 401, message: 'Not logged in' });
        const id = url.pathname.split('/')[2];
        const bytes = state.files.get(id);
        if (!bytes) return send(res, 404, { errorcode: 404, message: `No file for ${id}` });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(bytes);
      }

      if (!url.pathname.startsWith('/services/')) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<html>Not found</html>');
      }
      const endpoint = url.pathname.slice('/services/'.length);

      if (endpoint === 'login') {
        if (req.method !== 'POST' || !isForm) return send(res, 400, { errorcode: 400, message: 'login expects a form POST' });
        if (params.get('username') !== USER || params.get('password') !== PASSWORD) {
          return send(res, 200, { loginSuccess: false, loginFaultMessage: 'Invalid username or password' });
        }
        state.logins++;
        state.expireNext = false;
        if (dialect === 'token') return send(res, 200, { loginSuccess: true, authToken: TOKEN });
        return send(res, 200, { loginSuccess: true, csrfToken: CSRF }, { 'Set-Cookie': `${SESSION}; Path=/; HttpOnly` });
      }

      if (!authorised(req)) return send(res, 401, { errorcode: 401, message: 'Not logged in' });

      if (endpoint === 'search') {
        const num = Math.min(Number(params.get('num') || 50), pageCap);
        const start = Number(params.get('start') || 0);
        const folder = /^folderPath:"((?:[^"\\]|\\.)*)"$/.exec(params.get('q') || '');
        const matching = folder ? ASSETS.filter((a) => a.metadata.folderPath === folder[1].replace(/\\(.)/g, '$1')) : ASSETS;
        const hits = matching.slice(start, start + num).map((a) => ({
          ...a,
          thumbnailUrl: state.files.has(a.id) ? undefined : `/services/preview/${a.id}?size=thumb`,
          previewUrl: state.files.has(a.id) ? undefined : `/services/preview/${a.id}`,
          originalUrl: `/file/${a.id}/*/${encodeURIComponent(a.metadata.filename)}?_=${a.metadata.versionNumber ?? 1}`,
          metadata: { ...a.metadata },
        }));
        return send(res, 200, { totalHits: matching.length, firstResult: start, hits });
      }

      if (endpoint === 'create' || (endpoint === 'update' && isMultipart)) {
        if (req.method !== 'POST' || !isMultipart) return send(res, 400, { errorcode: 400, message: `${endpoint} with a file expects multipart/form-data` });
        const parsed = parseMultipart(rawBytes, req.headers['content-type']);
        const file = parsed?.files.Filedata;
        if (!file) return send(res, 400, { errorcode: 400, message: 'missing Filedata' });
        if (endpoint === 'create') {
          const assetPath = parsed.fields.assetPath;
          if (!assetPath || !assetPath.startsWith('/')) return send(res, 400, { errorcode: 400, message: 'missing assetPath' });
          if (ASSETS.some((a) => a.metadata.assetPath === assetPath)) {
            return send(res, 409, { errorcode: 409, message: `An asset already exists at ${assetPath}` });
          }
          const id = `F${state.nextId++}`;
          const slash = assetPath.lastIndexOf('/');
          const name = assetPath.slice(slash + 1);
          ASSETS.push({ id, metadata: { filename: name, name, folderPath: assetPath.slice(0, slash) || '/', assetPath, versionNumber: 1 } });
          state.files.set(id, Buffer.from(file.bytes));
          state.uploads.push({ endpoint, id, version: 1 });
          return send(res, 200, { id, metadata: { assetPath } });
        }
        const id = parsed.fields.id;
        const asset = ASSETS.find((a) => a.id === id);
        if (!asset) return send(res, 404, { errorcode: 404, message: `No asset ${id}` });
        asset.metadata.versionNumber = (asset.metadata.versionNumber ?? 1) + 1;
        state.files.set(id, Buffer.from(file.bytes));
        state.uploads.push({ endpoint, id, version: asset.metadata.versionNumber });
        return send(res, 200, { id, metadata: { versionNumber: asset.metadata.versionNumber } });
      }

      if (endpoint.startsWith('preview/')) {
        state.imageFetches++;
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(PIXEL_JPEG);
      }

      if (endpoint === 'update' || endpoint === 'updatebulk') {
        if (req.method !== 'POST' || !isForm) {
          return send(res, 400, { errorcode: 400, message: 'update expects form parameters, not a JSON body' });
        }
        const target = endpoint === 'update' ? params.get('id') : params.get('q');
        const metadataText = params.get('metadata');
        if (!target || !metadataText) return send(res, 400, { errorcode: 400, message: 'missing id/q or metadata' });
        let metadata;
        try {
          metadata = JSON.parse(metadataText);
        } catch {
          return send(res, 400, { errorcode: 400, message: 'metadata is not a JSON string' });
        }
        state.updates.push({ endpoint, target, metadata });
        const id = endpoint === 'update' ? target : target.replace(/^id:/, '');
        const asset = ASSETS.find((a) => a.id === id);
        if (!asset) return send(res, 404, { errorcode: 404, message: `No asset ${id}` });
        Object.assign(asset.metadata, metadata);
        return send(res, 200, endpoint === 'update' ? { id: target, metadata } : { processedCount: 1 });
      }

      return send(res, 404, { errorcode: 404, message: `Unknown service ${endpoint}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        state,
        expireSession: () => (state.expireNext = true),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
