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
const { createElvisClient, resolveBase, parseAssetRef } = require('../electron/elvisClient.cjs');

let failures = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${!cond && extra !== undefined ? `\n      got: ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};

const config = (origin, overrides = {}) => ({
  endpoint: origin, // browser-style address, no /services — the client must add it
  searchPath: '/search',
  searchMethod: 'POST',
  authMode: 'login',
  apiKey: '',
  username: USER,
  password: PASSWORD,
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

  const found = await client.search(cfg);
  check('search returns hits', found.ok && found.hits.length === 2, found);
  check('session reused, not re-logged-in per call', server.state.logins === 1, server.state.logins);

  server.expireSession();
  const afterExpiry = await client.search(cfg);
  check('expired session → logs in again once and succeeds', afterExpiry.ok && server.state.logins === 2, { ok: afterExpiry.ok, logins: server.state.logins });

  const bad = await createElvisClient(nodeTransport()).test({ ...cfg, password: 'wrong' });
  const loginStep = bad.steps.find((s) => s.label === 'Log in');
  check('wrong password fails at the login step', !bad.ok && loginStep && !loginStep.ok, bad.steps);
  check('…with the server’s own message', /Invalid username or password/.test(loginStep?.detail || ''), loginStep);

  await server.close();
}

console.log('\npasted references');
{
  const id = 'EkRoPu4tqE0BOpbTQe1IH1';
  check('a bare id', parseAssetRef(id).id === id);
  check('an Elvis web link', parseAssetRef(`https://dam.example.com/app/#/search//?assetId=${id}`).id === id);
  check('a file link', parseAssetRef(`https://dam.example.com/file/${id}/*/IMG_1.tif?_=3`).id === id);
  check('a link without an id is recognised as such', parseAssetRef('https://dam.example.com/app/').kind === 'bad-link');
  check('a file name', parseAssetRef('IMG_4821.tif').kind === 'name');
}

console.log('\nlinking shots to assets, previews, paging');
{
  const server = await startMockElvis({ assetCount: 450, pageCap: 200 });
  const client = createElvisClient(nodeTransport());
  const cfg = config(server.origin);
  const all = await client.search(cfg);
  check('a 450-asset search is read in full across pages', all.ok && all.hits.length === 450 && new Set(all.hits.map((h) => h.id)).size === 450, all.hits?.length);

  const byId = await client.lookup(cfg, 'A7');
  check('lookup by id finds exactly that asset', byId.ok && byId.by === 'id' && byId.hits.length === 1 && byId.hits[0].id === 'A7', byId);
  const byLink = await client.lookup(cfg, `${server.origin}/app/#/search//?assetId=A42`);
  check('lookup by a pasted link finds it', byLink.ok && byLink.hits[0]?.id === 'A42', byLink);
  const byShot = await client.lookup(cfg, 'IMG_4821');
  check('lookup by shot number finds the retouched file', byShot.ok && byShot.by === 'name' && byShot.hits[0]?.name === 'IMG_4821.tif', byShot);
  const byName = await client.lookup(cfg, 'img_4822.TIF');
  check('…and by its full file name, any case', byName.ok && byName.hits.length === 1 && byName.hits[0].id === 'A2', byName);
  const unknownLink = await client.lookup(cfg, `${server.origin}/file/ZZZZZZZZ/*/x.tif`);
  check('a link to an asset that isn’t there says so', !unknownLink.ok && /No asset/.test(unknownLink.error), unknownLink);
  const nothing = await client.lookup(cfg, 'NOPE_9999');
  check('no match is an empty list, not an error', nothing.ok && nothing.hits.length === 0, nothing);

  const ids = Array.from({ length: 120 }, (_, i) => `A${i + 1}`).concat(['GONE1']);
  const linked = await client.assetsById(cfg, ids);
  check('linked assets are fetched by id in batches', linked.ok && linked.hits.length === 120, linked.hits?.length);
  check('…and an id Elvis no longer has is reported missing', linked.missing?.join() === 'GONE1', linked.missing);
  check('only the linked ids were asked for — the rest of Elvis is ignored', linked.hits.every((h) => ids.includes(h.id)));

  const p1 = await client.fetchImage(cfg, byId.hits[0].previewUrl);
  check('preview downloads as image bytes', p1.ok && p1.mime === 'image/jpeg' && p1.bytes[0] === 0xff && p1.bytes[1] === 0xd8, p1);
  server.newVersion('A7');
  const again = await client.assetsById(cfg, ['A7']);
  const p2 = await client.fetchImage(cfg, again.hits[0].previewUrl);
  check('a new version in Elvis shows in its version number and preview', again.hits[0].metadata.versionNumber === 2 && !Buffer.from(p1.bytes).equals(Buffer.from(p2.bytes)));
  const foreign = await client.fetchImage(cfg, 'https://elsewhere.example/steal.jpg');
  check('refuses to send the login to another host', !foreign.ok && /Refusing/.test(foreign.error), foreign);
  check('nothing was written to any photo', server.state.updates.length === 0 && server.state.uploads.length === 0);
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

  await client.upload(cfg, { assetPath: '/PhotoTrack/Gala "Night" 2026.photos.ptdelta', bytes: v1 });
  const listed = await client.listFiles(cfg, '/PhotoTrack/');
  check(`${dialect}: the folder lists the shared file, not its photos companion`, listed.ok && listed.hits.length === 1 && listed.hits[0].name === 'Gala "Night" 2026.ptdelta', listed.hits);

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
