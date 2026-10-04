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

const ASSETS = [
  { id: 'A1', metadata: { name: 'IMG_4821.CR3', cf_usagePlacement: 'mag', cf_spreadNum: '12', cf_retouched: 'true' } },
  { id: 'A2', metadata: { name: 'IMG_4822.CR3', cf_usagePlacement: 'both', cf_qcOk: true } },
];

export function startMockElvis({ dialect = 'token' } = {}) {
  const state = { logins: 0, updates: [], log: [], expireNext: false };
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
        const num = Number(params.get('num') || 50);
        return send(res, 200, { totalHits: ASSETS.length, hits: ASSETS.slice(0, num) });
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
