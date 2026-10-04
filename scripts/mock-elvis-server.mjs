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
  const assets = [
    { id: 'A1', metadata: { filename: 'IMG_4821.CR3', name: 'IMG_4821.CR3', folderPath: '/Shoots/Gala', cf_usagePlacement: 'mag', cf_spreadNum: '12' } },
    { id: 'A2', metadata: { filename: 'IMG_4822.CR3', name: 'IMG_4822.CR3', folderPath: '/Shoots/Gala', cf_usagePlacement: 'both' } },
  ];
  for (let i = 3; i <= count; i++) {
    assets.push({ id: `A${i}`, metadata: { filename: `IMG_${4820 + i}.CR3`, name: `IMG_${4820 + i}.CR3`, folderPath: '/Shoots/Gala' } });
  }
  return assets;
}

export function startMockElvis({ dialect = 'token', assetCount = 2, pageCap = 200 } = {}) {
  const ASSETS = seedAssets(assetCount);
  const state = { logins: 0, updates: [], log: [], expireNext: false, assets: ASSETS, imageFetches: 0 };
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
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const isForm = (req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');
      const params = new URLSearchParams(req.method === 'GET' ? url.search : isForm ? raw : '');
      state.log.push(`${req.method} ${url.pathname}`);

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
        const hits = ASSETS.slice(start, start + num).map((a) => ({
          ...a,
          thumbnailUrl: `/services/preview/${a.id}?size=thumb`,
          previewUrl: `/services/preview/${a.id}`,
          metadata: { ...a.metadata },
        }));
        return send(res, 200, { totalHits: ASSETS.length, firstResult: start, hits });
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
