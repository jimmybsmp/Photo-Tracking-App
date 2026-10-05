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
 * `search` understands clauses joined by OR, each `field:"exact"` or
 * `field:prefix*` on id, name, filename or folderPath; `*` matches
 * everything. A preview's bytes change with the asset's version, the way a
 * real preview does when a retoucher checks in a new file — `newVersion(id)`
 * does that.
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
    metadata: {
      filename: `IMG_${n}.tif`,
      name: `IMG_${n}.tif`,
      folderPath: '/Shoots/Gala',
      assetPath: `/Shoots/Gala/IMG_${n}.tif`,
      versionNumber: 1,
      assetModified: Date.UTC(2026, 9, 1, 12, 0, 0),
      ...extra,
    },
  });
  const assets = [photo('A1', 4821, { cf_usagePlacement: 'mag', cf_spreadNum: '12' }), photo('A2', 4822, { cf_usagePlacement: 'both' })];
  for (let i = 3; i <= count; i++) assets.push(photo(`A${i}`, 4820 + i));
  return assets;
}

/** A tiny Lucene subset: OR-joined `field:"exact"` / `field:prefix*` clauses, or `*`. */
function compileQuery(q) {
  const query = String(q || '*').trim();
  if (query === '*' || query === '') return () => true;
  const clauses = [];
  const re = /(\w+):(?:"((?:[^"\\]|\\.)*)"|((?:[^\s\\*]|\\.)+)\*)(?:\s+OR\s+|$)/gy;
  let m;
  while ((m = re.exec(query))) {
    const unescape = (v) => v.replace(/\\(.)/g, '$1');
    if (m[2] !== undefined) clauses.push({ field: m[1], exact: unescape(m[2]) });
    else clauses.push({ field: m[1], prefix: unescape(m[3]) });
    if (re.lastIndex >= query.length) break;
  }
  if (!clauses.length || re.lastIndex < query.length) throw new Error(`mock can't parse query: ${query}`);
  return (asset) =>
    clauses.some(({ field, exact, prefix }) => {
      const value = field === 'id' ? asset.id : String(asset.metadata[field] ?? '');
      const ci = field === 'name' || field === 'filename';
      const a = ci ? value.toLowerCase() : value;
      if (exact !== undefined) return a === (ci ? exact.toLowerCase() : exact);
      return a.startsWith(ci ? prefix.toLowerCase() : prefix);
    });
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

/** `preview(asset)` can supply real JPEG bytes for UI runs; the default is a 1×1 pixel. */
export function startMockElvis({ dialect = 'token', assetCount = 2, pageCap = 200, preview = () => PIXEL_JPEG } = {}) {
  const ASSETS = seedAssets(assetCount);
  const state = { logins: 0, updates: [], uploads: [], queries: [], log: [], expireNext: false, assets: ASSETS, imageFetches: 0, files: new Map(), nextId: 1 };
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
        let test;
        state.queries.push(params.get('q') || '');
        try {
          test = compileQuery(params.get('q'));
        } catch (error) {
          return send(res, 400, { errorcode: 400, message: String(error.message) });
        }
        const matching = ASSETS.filter(test);
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
        const asset = ASSETS.find((a) => a.id === endpoint.split('/')[1]);
        if (!asset) return send(res, 404, { errorcode: 404, message: 'No such asset' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        // Same pixel, version-tagged: a new version's preview has new bytes.
        return res.end(Buffer.concat([preview(asset), Buffer.from(`v${asset.metadata.versionNumber ?? 1}`)]));
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
        /** A retoucher checks in a new version of a photo in Elvis. */
        newVersion: (id) => {
          const asset = ASSETS.find((a) => a.id === id);
          asset.metadata.versionNumber = (asset.metadata.versionNumber ?? 1) + 1;
          asset.metadata.assetModified = Date.now();
        },
        /** Someone deletes an asset in Elvis. */
        remove: (id) => ASSETS.splice(ASSETS.findIndex((a) => a.id === id), 1),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
