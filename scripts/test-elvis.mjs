#!/usr/bin/env node
/**
 * Tests for electron/elvisClient.cjs against a strict mock Elvis server.
 *
 * Runs in plain Node with a small Node-based transport standing in for
 * Electron's `net` (the protocol logic is identical either way — only the
 * socket layer differs). `npm run test:elvis`.
 */
import { createRequire } from 'node:module';
import { startMockElvis, USER, PASSWORD } from './mock-elvis-server.mjs';
import { nodeTransport } from './node-transport.mjs';

const require = createRequire(import.meta.url);
const { createElvisClient, resolveBase } = require('../electron/elvisClient.cjs');

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

console.log('\npaging, images, field discovery');
{
  const server = await startMockElvis({ assetCount: 450, pageCap: 200 });
  const client = createElvisClient(nodeTransport());
  const cfg = config(server.origin);
  const all = await client.search(cfg);
  check('a 450-asset query is read in full across pages', all.ok && all.hits.length === 450 && new Set(all.hits.map((h) => h.id)).size === 450, all.hits?.length);
  check('hits carry preview urls', /preview\/A1/.test(all.hits?.[0]?.previewUrl || ''));
  const img = await client.fetchImage(cfg, all.hits[0].previewUrl);
  check('preview downloads as image bytes', img.ok && img.mime === 'image/jpeg' && img.bytes[0] === 0xff && img.bytes[1] === 0xd8, img);
  const foreign = await client.fetchImage(cfg, 'https://elsewhere.example/steal.jpg');
  check('refuses to send the login to another host', !foreign.ok && /Refusing/.test(foreign.error), foreign);
  const test = await client.test(cfg);
  const names = (test.sampleFields || []).map((f) => f.name);
  check('connection test lists the fields assets really have', names.includes('filename') && names.includes('cf_spreadNum'), names);
  await client.update(cfg, 'A1', { cf_photoTrack: '{"x":1}' });
  const after = await client.search(cfg, { num: 1 });
  check('a write is visible on the next search', after.hits?.[0]?.metadata?.cf_photoTrack === '{"x":1}', after.hits?.[0]?.metadata);
  await server.close();
}

console.log('\nshared tracking file');
for (const dialect of ['token', 'cookie']) {
  const server = await startMockElvis({ dialect });
  const client = createElvisClient(nodeTransport());
  const cfg = config(server.origin);
  const path = '/PhotoTrack/Gala "Night" 2026.ptdelta';

  const none = await client.findFile(cfg, path);
  check(`${dialect}: no file yet → found nothing, not an error`, none.ok && none.hits.length === 0, none);

  const v1 = new Uint8Array([0x50, 0x4b, 0, 1, 2, 3, 255, 13, 10]);
  const created = await client.upload(cfg, { assetPath: path, bytes: v1 });
  check(`${dialect}: file created at the path (multipart, Filedata)`, created.ok && !!created.id, created);

  const found = await client.findFile(cfg, path);
  check(`${dialect}: found again by its exact path`, found.ok && found.hits.length === 1 && found.hits[0].id === created.id, found);
  const got = await client.download(cfg, found.hits[0].originalUrl);
  check(`${dialect}: downloads byte-for-byte, binary intact`, got.ok && Buffer.from(got.bytes).equals(Buffer.from(v1)), got);

  const again = await client.upload(cfg, { assetPath: path, bytes: v1 });
  check(`${dialect}: creating a second file at the same path is refused`, !again.ok && again.status === 409, again);

  const v2 = new Uint8Array([9, 8, 7]);
  const replaced = await client.upload(cfg, { id: created.id, assetPath: path, bytes: v2 });
  const after = await client.findFile(cfg, path);
  const got2 = await client.download(cfg, after.hits[0].originalUrl);
  check(`${dialect}: a replace is a new version of the same asset`, replaced.ok && after.hits.length === 1 && after.hits[0].id === created.id && after.hits[0].metadata.versionNumber === 2, after.hits);
  check(`${dialect}: …and the download is the new version`, got2.ok && Buffer.from(got2.bytes).equals(Buffer.from(v2)), got2);

  const elsewhere = await client.findFile(cfg, '/PhotoTrack/Other.ptdelta');
  check(`${dialect}: another shoot's path finds nothing`, elsewhere.ok && elsewhere.hits.length === 0, elsewhere);
  const foreign = await client.download(cfg, 'https://elsewhere.example/file/F1');
  check(`${dialect}: refuses to send the login to another host`, !foreign.ok && /Refusing/.test(foreign.error), foreign);
  const badPath = await client.findFile(cfg, 'Gala.ptdelta');
  check(`${dialect}: a path without a folder is explained`, !badPath.ok && /full path/.test(badPath.error), badPath);
  check(`${dialect}: photo metadata untouched by any of it`, server.state.updates.length === 0, server.state.updates);
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
