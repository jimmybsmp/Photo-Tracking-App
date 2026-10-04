#!/usr/bin/env node
/**
 * Tests for electron/elvisClient.cjs against a strict mock Elvis server.
 *
 * Runs in plain Node with a small Node-based transport standing in for
 * Electron's `net` (the protocol logic is identical either way — only the
 * socket layer differs). `npm run test:elvis`.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { startMockElvis, USER, PASSWORD } from './mock-elvis-server.mjs';

const require = createRequire(import.meta.url);
const { createElvisClient, resolveBase } = require('../electron/elvisClient.cjs');

/** Node transport with the cookie handling Chromium's session would provide. */
function nodeTransport() {
  const jar = new Map();
  return ({ url, method, headers, body }) =>
    new Promise((resolve, reject) => {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const req = http.request(url, { method, headers: cookie ? { ...headers, Cookie: cookie } : headers }, (res) => {
        for (const line of [].concat(res.headers['set-cookie'] || [])) {
          const [pair] = line.split(';');
          const [k, v] = pair.split('=');
          jar.set(k.trim(), v);
        }
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, bodyText: text }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
}

let failures = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${!cond && extra !== undefined ? `\n      got: ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};

const config = (origin, overrides = {}) => ({
  endpoint: origin, // browser-style address, no /services — the client must add it
  searchPath: '/search',
  updatePath: '/update',
  searchMethod: 'POST',
  query: '*',
  authMode: 'login',
  apiKey: '',
  username: USER,
  password: PASSWORD,
  fieldMap: {},
  ...overrides,
});

console.log('address normalisation');
check('bare host gets https:// and /services', resolveBase('dam.example.com').base === 'https://dam.example.com/services');
check('browser address gets /services', resolveBase('https://dam.example.com/').base === 'https://dam.example.com/services');
check('explicit /services kept', resolveBase('https://dam.example.com/services/').base === 'https://dam.example.com/services');
check('custom context path kept', resolveBase('https://x.com/elvis/services').base === 'https://x.com/elvis/services');
check('empty address is an error', resolveBase('  ').ok === false);

for (const dialect of ['token', 'cookie']) {
  console.log(`\n${dialect === 'token' ? 'Elvis 6 / Assets (auth token)' : 'Elvis 5 (session cookie + CSRF)'}`);
  const server = await startMockElvis({ dialect });
  const client = createElvisClient(nodeTransport());
  const cfg = config(server.origin);

  const test = await client.test(cfg);
  check('connection test passes all three steps', test.ok && test.steps.every((s) => s.ok), test.steps);
  check('test reports total hits', test.totalHits === 2, test.totalHits);

  const found = await client.search(cfg);
  check('search returns hits', found.ok && found.hits.length === 2, found);
  check('hit metadata is mapped', found.hits?.[0]?.metadata?.cf_spreadNum === '12' && found.hits?.[0]?.name === 'IMG_4821.CR3');
  const loginsAfterSearch = server.state.logins;
  check('session reused, not re-logged-in per call', loginsAfterSearch === 1, loginsAfterSearch);

  const upd = await client.update(cfg, 'A1', { cf_retouched: true, cf_spreadNum: '14' });
  check('update via /update succeeds', upd.ok, upd);
  check('update sent id + JSON-string metadata', server.state.updates[0]?.target === 'A1' && server.state.updates[0]?.metadata.cf_spreadNum === '14', server.state.updates[0]);

  const bulk = await client.update({ ...cfg, updatePath: '/updatebulk' }, 'A2', { cf_qcOk: true });
  check('legacy /updatebulk config still works (q=id:…)', bulk.ok && server.state.updates[1]?.target === 'id:A2', server.state.updates[1]);

  server.expireSession();
  const afterExpiry = await client.search(cfg);
  check('expired session → logs in again once and succeeds', afterExpiry.ok && server.state.logins === 2, { ok: afterExpiry.ok, logins: server.state.logins });

  const bad = await createElvisClient(nodeTransport()).test({ ...cfg, password: 'wrong' });
  const loginStep = bad.steps.find((s) => s.label === 'Log in');
  check('wrong password fails at the login step', !bad.ok && loginStep && !loginStep.ok, bad.steps);
  check('…with the server’s own message', /Invalid username or password/.test(loginStep?.detail || ''), loginStep);

  await server.close();
}

console.log('\nfailure reporting');
{
  const server = await startMockElvis();
  const client = createElvisClient(nodeTransport());
  const noAuth = await client.search(config(server.origin, { authMode: 'none' }));
  check('no-auth against a real server → 401 with an explanation', !noAuth.ok && noAuth.status === 401 && !!noAuth.hint, noAuth);

  const wrongPath = await client.search(config(server.origin, { searchPath: '/nope' }));
  check('wrong path → 404 with an explanation', !wrongPath.ok && wrongPath.status === 404 && /services/.test(wrongPath.hint || ''), wrongPath);

  const webPage = await client.search(config(`${server.origin}/web`, { authMode: 'none' }));
  check('a web page instead of the API is recognised', !webPage.ok && !!webPage.hint, webPage);
  await server.close();

  const refused = await createElvisClient(nodeTransport()).test(config('http://127.0.0.1:9'));
  const step = refused.steps.find((s) => !s.ok);
  check('closed port → network error with a hint', !refused.ok && /refused/i.test(step?.hint || ''), step);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
