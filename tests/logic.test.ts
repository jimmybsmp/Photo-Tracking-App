/**
 * Logic tests — schema migration, the store's rules, comment threads, delta
 * merge, and a simulated multi-site Elvis sync. No UI, no network: the "Elvis
 * server" here is a map of asset id → metadata that pushes write into and
 * pulls read from, which is all the sync rules ever see of it.
 *
 * Run with `npm run test:logic` (bundled by scripts/test-logic.mjs).
 */
import { migrate, type AssetMeta, type ShotRow, type TrackerDocument } from '@/state/schema';
import { createHash } from 'node:crypto';
import { computeStats, isRowComplete, nextStage, openConcerns } from '@/state/selectors';
import { useTrackerStore } from '@/state/useTrackerStore';
import { startHistory, undo } from '@/state/history';
import { setIdentity } from '@/lib/identity';
import { buildDelta, mergeDelta } from '@/lib/delta';
import { normalizeElvisConfig, type ElvisConfig } from '@/lib/elvis/types';
import { io, linkShot, lookupAsset, shareProject, syncNow, unlinkShot, useSyncStore } from '@/lib/elvis/autoSync';
import { sharedPayload } from '@/lib/elvis/sharedFile';
import { packDelta, unpackDelta } from '@/lib/projectFiles';
import type { DesktopBridge } from '@/lib/desktop';
// The real Elvis client against the strict mock server, over plain Node HTTP.
import { createElvisClient } from '../electron/elvisClient.cjs';
import { startMockElvis, USER, PASSWORD } from '../scripts/mock-elvis-server.mjs';
import { nodeTransport } from '../scripts/node-transport.mjs';

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${!cond && extra !== undefined ? `\n      got: ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
}
const tick = () => new Promise((r) => setTimeout(r, 3));

/** Key-order-independent JSON, to compare two copies of a row. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A picture as the app would hold it, without needing a DOM to decode one. */
function fakeAsset(fileName: string, bytes: Uint8Array): AssetMeta {
  const url = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
  return { hash: createHash('sha256').update(bytes).digest('hex').slice(0, 32), thumbUrl: url, reviewUrl: url, width: 1, height: 1, fileName, bytes: bytes.length };
}
const store = () => useTrackerStore.getState();

/** Run store actions against a given document — one "site" at a time. */
async function onSite(doc: TrackerDocument, who: string, fn: () => void | Promise<void>): Promise<TrackerDocument> {
  setIdentity({ name: who, role: who === 'Exec' ? 'executive' : 'staff' });
  useTrackerStore.setState({ doc });
  await tick();
  await fn();
  await tick();
  return store().doc;
}

async function main() {
  startHistory();

  /* ---------------------------------------------------------------- */
  console.log('migration');
  {
    const v1 = {
      schemaVersion: 1,
      header: { name: 'Lead', event: 'Gala', date: '' },
      rows: {
        r1: {
          id: 'r1',
          shotNum: '4821',
          shotType: 'longshot',
          usage: 'both',
          imageHash: null,
          mag: { position: '12', selectType: 'main', retoucher: 'JM', pipeline: { retouched: true, qc: true, assembled: false, submitted: false, approved: false } },
          pr: { position: '3', selectType: 'alt', retoucher: 'AB', pipeline: { retouched: true, qc: false, assembled: false, submitted: false, approved: false } },
          elvisAssetId: '',
          notes: 'hero',
          fieldTimes: { shotNum: { t: 5, d: 'x' } },
        },
      },
      rowIds: ['r1'],
      assets: {},
      deletedRowIds: {},
    };
    const { doc } = migrate(v1);
    const r = doc.rows.r1;
    check('v1 file opens at the current version', doc.schemaVersion === 3);
    check('v1 values survive unchanged', r.mag.position === '12' && r.pr.retoucher === 'AB' && r.notes === 'hero' && r.mag.pipeline.qc === true && r.pr.pipeline.qc === false);
    check('v1 rows gain an empty comment thread', r.comments && Object.keys(r.comments).length === 0);
    check('v1 edit stamps are kept', r.fieldTimes.shotNum?.t === 5);
    check('longshot complete on mag without assembled/submitted/approved', isRowComplete({ ...r, usage: 'mag' }));

    const v2 = migrate({ ...v1, schemaVersion: 2, elvisLinked: true }).doc;
    check('a v2 file opens as v3, unshared, its folder link dropped', v2.schemaVersion === 3 && v2.elvisFile === '' && Object.keys(v2.elvisPreviews).length === 0 && !('elvisLinked' in v2));
    const v3 = migrate({ ...v1, schemaVersion: 3, elvisFile: '/PhotoTrack/G.ptdelta', elvisPreviews: { A1: { version: '2', hash: 'h' }, bad: 4 } }).doc;
    check('a v3 file keeps its shared file and preview versions', v3.elvisFile === '/PhotoTrack/G.ptdelta' && v3.elvisPreviews.A1?.hash === 'h' && !('bad' in v3.elvisPreviews));

    const legacy = {
      headerEvent: 'Old tool',
      rows: [{ shotNum: '9', usage: 'both', shotType: 'closeup', toggles: [true, false, false, true, false, false, false, false, false, false] }],
    };
    const old = migrate(legacy).doc;
    const lr = old.rows[old.rowIds[0]];
    check('original HTML tool export still imports', old.header.event === 'Old tool' && lr.shotNum === '9');
    check('…with its toggles mapped to the right property', lr.mag.pipeline.retouched && !lr.pr.pipeline.retouched && lr.pr.pipeline.qc && !lr.mag.pipeline.qc, { mag: lr.mag.pipeline, pr: lr.pr.pipeline });
  }

  /* ---------------------------------------------------------------- */
  console.log('\nlongshot rule');
  {
    store().newProject();
    const id = store().addRow();
    store().setField(id, 'usage', 'pr');
    store().setField(id, 'shotType', 'longshot');
    store().setStage(id, 'pr', 'assembled', true);
    check('a longshot cannot be marked assembled', store().doc.rows[id].pr.pipeline.assembled === false);
    store().setStage(id, 'pr', 'retouched', true);
    store().setStage(id, 'pr', 'qc', true);
    check('a longshot is complete after retouch + QC', isRowComplete(store().doc.rows[id]));
    const stats = computeStats(store().doc);
    check('exempt stages are left out of the counts', stats.sides.pr.stages.assembled.eligible === 0 && stats.sides.pr.complete === 1, stats.sides.pr);

    store().setField(id, 'shotType', 'closeup');
    store().setStage(id, 'pr', 'assembled', true);
    store().setField(id, 'shotType', 'longshot');
    store().setField(id, 'shotType', 'closeup');
    check('switching shot type back and forth keeps the stored stage', store().doc.rows[id].pr.pipeline.assembled === true);
    check('a close-up waits on the next stage', nextStage(store().doc.rows[id], 'pr') === 'submitted');
  }

  /* ---------------------------------------------------------------- */
  console.log('\nundo');
  {
    store().newProject();
    const id = store().addRow();
    for (const text of ['1', '12', '123', '1234']) {
      store().setField(id, 'shotNum', text, { typing: true });
      await tick();
    }
    store().setStage(id, 'mag', 'retouched', true);
    undo();
    check('undo reverts the last click on its own', store().doc.rows[id].mag.pipeline.retouched === false && store().doc.rows[id].shotNum === '1234');
    undo();
    check('a burst of typing undoes as one step', store().doc.rows[id].shotNum === '', store().doc.rows[id]?.shotNum);
  }

  /* ---------------------------------------------------------------- */
  console.log('\nwho / when');
  {
    store().newProject();
    setIdentity({ name: 'Jo', role: 'staff' });
    const id = store().addRow();
    store().setStage(id, 'mag', 'retouched', true);
    const stamp = store().doc.rows[id].fieldTimes['mag.pipeline.retouched'];
    check('a stage records who marked it', stamp?.u === 'Jo' && stamp.t > 0, stamp);
  }

  /* ---------------------------------------------------------------- */
  console.log('\nconcerns');
  {
    store().newProject();
    setIdentity({ name: 'Exec', role: 'executive' });
    const id = store().addRow();
    store().addComment(id, { kind: 'concern', text: 'Skin tones too warm', side: 'mag' });
    const [concern] = openConcerns(store().doc.rows[id]);
    check('an executive concern is open, attributed, and on the right property', concern?.author === 'Exec' && concern.role === 'executive' && concern.side === 'mag');
    setIdentity({ name: 'Jo', role: 'staff' });
    store().addComment(id, { kind: 'note', text: 'Cooled them down', side: 'mag', replyTo: concern.id });
    store().setCommentResolved(id, concern.id, true);
    const row = store().doc.rows[id];
    check('staff can reply and resolve it', openConcerns(row).length === 0 && row.comments[concern.id].resolvedBy === 'Jo');
    check('the stats bar counts no open concerns', computeStats(store().doc).openConcerns === 0);
  }

  /* ---------------------------------------------------------------- */
  console.log('\ndelta files');
  {
    store().newProject();
    setIdentity({ name: 'A', role: 'staff' });
    const id = store().addRow();
    store().setField(id, 'usage', 'both');
    const base = store().doc;

    let siteA = await onSite(base, 'A', () => store().setStage(id, 'mag', 'retouched', true));
    let siteB = await onSite(base, 'B', () => {
      store().setStage(id, 'pr', 'qc', true);
      store().addComment(id, { kind: 'concern', text: 'Crop is tight', side: 'pr' });
    });
    const intoA = mergeDelta(siteA, buildDelta(siteB, 0));
    const intoB = mergeDelta(siteB, buildDelta(siteA, 0));
    siteA = intoA.doc;
    siteB = intoB.doc;
    check('edits to different properties of one shot both survive', siteA.rows[id].mag.pipeline.retouched && siteA.rows[id].pr.pipeline.qc);
    check('a concern travels in a delta file', Object.keys(siteA.rows[id].comments).length === 1);
    check('both sites end up identical', canonical(siteA.rows[id]) === canonical(siteB.rows[id]));

    // Same Elvis asset, different row ids at two sites → merged, not duplicated.
    const a = { ...siteA.rows[id], id: 'local-1', elvisAssetId: 'X9' };
    const b = { ...siteB.rows[id], id: 'local-2', elvisAssetId: 'X9', notes: 'b' , fieldTimes: { ...siteB.rows[id].fieldTimes, notes: { t: Date.now() + 5, d: 'b' } } };
    const docA = { ...siteA, rows: { 'local-1': a }, rowIds: ['local-1'] };
    const docB = { ...siteB, rows: { 'local-2': b }, rowIds: ['local-2'] };
    const merged = mergeDelta(docA, buildDelta(docB, 0)).doc;
    check('the same Elvis asset under two row ids merges into one shot', merged.rowIds.length === 1 && merged.rows['local-1'].notes === 'b', merged.rowIds);
  }

  /* ---------------------------------------------------------------- */
  console.log('\nElvis: dropped JPEGs, a shared file, shots linked by hand (real client, mock server)');
  {
    // 30 assets in the Elvis folder — test frames; only the ones a retoucher links matter.
    const server = await startMockElvis({ assetCount: 30 });
    const client = createElvisClient(nodeTransport());
    const bridge = {
      elvisTest: (c: ElvisConfig) => client.test(c),
      elvisLookup: (c: ElvisConfig, text: string) => client.lookup(c, text),
      elvisAssetsById: (c: ElvisConfig, ids: string[]) => client.assetsById(c, ids),
      elvisListFiles: (c: ElvisConfig, folder: string) => client.listFiles(c, folder),
      elvisFetchImage: (c: ElvisConfig, url: string) => client.fetchImage(c, url),
      elvisFindFile: (c: ElvisConfig, path: string) => client.findFile(c, path),
      elvisDownload: (c: ElvisConfig, url: string) => client.download(c, url),
      elvisUpload: (c: ElvisConfig, file: Parameters<DesktopBridge['elvisUpload']>[1]) => client.upload(c, file),
    } as unknown as DesktopBridge;
    (globalThis as unknown as { window: unknown }).window = { phototrack: bridge };
    // Decoding a picture needs a DOM; a stand-in keyed on the bytes is enough here.
    io.importImageBytes = async (bytes: Uint8Array, _mime: string, fileName: string) => fakeAsset(fileName, bytes);

    const PATH = '/PhotoTrack/Gala 2026.ptdelta';
    const PHOTOS = '/PhotoTrack/Gala 2026.photos.ptdelta';
    const config = normalizeElvisConfig({ endpoint: server.origin, username: USER, password: PASSWORD, query: '*', recordField: 'cf_x' });
    check('an old setup’s folder query and record field are dropped', !('query' in config) && !('recordField' in config), config);
    useSyncStore.setState({ config });

    const run = async (doc: TrackerDocument, who: string, fn?: () => unknown) => {
      setIdentity({ name: who, role: who === 'Exec' ? 'executive' : 'staff' });
      useTrackerStore.setState({ doc });
      await tick();
      if (fn) await fn();
      await syncNow();
      return store().doc;
    };
    const fresh = () => (store().newProject(), store().doc);
    const filesAt = (path: string) => server.state.assets.filter((a: { metadata: { assetPath?: string } }) => a.metadata.assetPath === path);
    const fileContent = (path: string) => unpackDelta(new Uint8Array(server.state.files.get(filesAt(path)[0].id)));
    const byShot = (doc: TrackerDocument, shot: string): ShotRow => doc.rows[doc.rowIds.find((id) => doc.rows[id].shotNum === shot) as string];
    const uploads = () => server.state.uploads.length;
    const queriesFrom = server.state.queries.length;

    // The selector drops three JPEGs and starts sharing.
    let london = fresh();
    london = await onSite(london, 'Selector', () => {
      store().addRowsFromAssets(['IMG_4821.jpg', 'IMG_4822.jpg', 'IMG_4823.jpg'].map((n) => fakeAsset(n, new TextEncoder().encode(n))));
      store().setField(store().doc.rowIds[0], 'usage', 'both');
    });
    london = await run(london, 'Selector', () => shareProject(PATH));
    check('sharing creates the shared file and its photos file', filesAt(PATH).length === 1 && filesAt(PHOTOS).length === 1, server.state.uploads);
    check('…the shared file holds the shots, no pixels', Object.keys(fileContent(PATH).rows).length === 3 && Object.keys(fileContent(PATH).assets).length === 0);
    check('…the photos file holds a thumbnail of each, no full size', Object.values(fileContent(PHOTOS).assets).length === 3 && Object.values(fileContent(PHOTOS).assets).every((a) => a.thumbUrl && !a.reviewUrl));
    check('the project remembers its shared file', london.elvisFile === PATH);

    // Another site joins.
    let exec = await run(fresh(), 'Exec', () => shareProject(PATH));
    const e4821 = byShot(exec, 'IMG_4821');
    check('a site that joins gets every shot', exec.rowIds.length === 3 && e4821?.usage === 'both', exec.rowIds.length);
    check('…with the photos the selector dropped in', exec.rowIds.every((id) => Boolean(exec.assets[exec.rows[id].imageHash ?? '']?.thumbUrl)));
    check('joining writes nothing new', uploads() === 2, server.state.uploads);

    // The retoucher's first pass is in Elvis: they link the shot to it.
    const rowId = byShot(london, 'IMG_4821').id;
    const dropped = byShot(london, 'IMG_4821').imageHash;
    const found = await lookupAsset('IMG_4821');
    check('finding the asset by shot number', found.ok && found.hits?.[0]?.name === 'IMG_4821.tif', found);
    london = await run(london, 'Retoucher', async () => {
      const linked = await linkShot(rowId, found.hits![0]);
      check('linking succeeds with its preview', linked.ok && !linked.warning, linked);
    });
    const lRow = london.rows[rowId];
    check('the shot is linked, with the file name and folder from Elvis', lRow.elvisAssetId === 'A1' && lRow.elvisName === 'IMG_4821.tif' && lRow.elvisPath === '/Shoots/Gala');
    check('…its picture is now the Elvis preview', lRow.imageHash !== dropped && london.elvisPreviews.A1?.hash === lRow.imageHash);
    check('…and the link went out in the shared file', fileContent(PATH).rows[rowId].elvisAssetId === 'A1' && fileContent(PATH).rows[rowId].fieldTimes.elvisAssetId?.u === 'Retoucher');

    exec = await run(exec, 'Exec');
    check('another site picks up the link and fetches the preview itself', exec.rows[rowId].elvisAssetId === 'A1' && exec.rows[rowId].imageHash === lRow.imageHash);

    // A new version checked in to Elvis shows up everywhere.
    server.newVersion('A1');
    london = await run(london, 'Retoucher');
    exec = await run(exec, 'Exec');
    check('a new version in Elvis updates the picture at every site', london.rows[rowId].imageHash !== lRow.imageHash && exec.rows[rowId].imageHash === london.rows[rowId].imageHash);
    check('…shown as Elvis’s change, not a person’s', london.rows[rowId].fieldTimes.imageHash?.u === 'Elvis');

    // Idle: nothing written, nothing downloaded again.
    const before = { up: uploads(), img: server.state.imageFetches };
    london = await run(london, 'Retoucher');
    exec = await run(exec, 'Exec');
    check('idle syncs write nothing and fetch no pictures', uploads() === before.up && server.state.imageFetches === before.img, { before, up: uploads(), img: server.state.imageFetches });

    const asked = server.state.queries.slice(queriesFrom);
    check('Elvis is only ever asked for linked ids, the shared folder, or a lookup — never the whole folder', asked.every((q: string) => /^(id:|folderPath:|name:)/.test(q)), asked);
    check('…and the other test frames were never touched', server.state.imageFetches <= 6, server.state.imageFetches);

    // An executive concern reaches the retoucher, and the resolution comes back.
    exec = await run(exec, 'Exec', () => store().addComment(rowId, { kind: 'concern', text: 'Skin too warm on the left', side: 'mag' }));
    london = await run(london, 'Retoucher');
    const concern = openConcerns(london.rows[rowId]).find((c) => c.author === 'Exec');
    check('the executive’s concern reaches the retoucher', Boolean(concern));
    london = await run(london, 'Retoucher', () => store().setCommentResolved(rowId, concern!.id, true));
    exec = await run(exec, 'Exec');
    check('…and its resolution comes back', exec.rows[rowId].comments[concern!.id]?.resolved === true);

    // A lost check-in race heals.
    const fileId = filesAt(PATH)[0].id;
    exec = await run(exec, 'Exec', () => store().setStage(rowId, 'pr', 'qc', true));
    const stale = Buffer.from(packDelta(sharedPayload(london)));
    server.state.files.set(fileId, stale);
    filesAt(PATH)[0].metadata.versionNumber += 1;
    const n0 = uploads();
    exec = await run(exec, 'Exec');
    check('a site whose change was overwritten checks it in again', uploads() === n0 + 1 && fileContent(PATH).rows[rowId].pr.pipeline.qc, server.state.uploads.slice(n0));

    // The asset disappears from Elvis: the shot keeps its last picture.
    server.remove('A1');
    london = await run(london, 'Retoucher');
    check('an asset gone from Elvis is reported, and the picture stays', useSyncStore.getState().missing.join() === 'A1' && Boolean(london.assets[london.rows[rowId].imageHash ?? '']));

    // Unlinking: the picture stays, and now travels in the photos file.
    london = await run(london, 'Retoucher', () => unlinkShot(rowId));
    exec = await run(exec, 'Exec');
    check('unlinking reaches the other sites and keeps the picture', exec.rows[rowId].elvisAssetId === '' && Boolean(exec.assets[exec.rows[rowId].imageHash ?? '']));
    check('…which now travels in the photos file', Boolean(fileContent(PHOTOS).assets[london.rows[rowId].imageHash ?? '']));

    // A deleted shot goes everywhere.
    const r3 = byShot(london, 'IMG_4823').id;
    london = await run(london, 'Selector', () => store().deleteRows([r3]));
    exec = await run(exec, 'Exec');
    check('a deleted shot goes at every site', !exec.rows[r3] && !london.rows[r3]);

    // Two copies at the path: both are read.
    const stray = sharedPayload(exec);
    const extra = { ...stray.rows[rowId], notes: 'from the second copy', fieldTimes: { ...stray.rows[rowId].fieldTimes, notes: { t: Date.now() + 1000, d: 'z', u: 'Z' } } };
    stray.rows = { [rowId]: extra };
    server.state.assets.push({ id: 'Z9', metadata: { filename: 'Gala 2026.ptdelta', name: 'Gala 2026.ptdelta', folderPath: '/PhotoTrack', assetPath: PATH, versionNumber: 1 } });
    server.state.files.set('Z9', Buffer.from(packDelta(stray)));
    london = await run(london, 'Selector');
    check('a second copy of the file is merged, not ignored', london.rows[rowId].notes === 'from the second copy');

    // Something at the path that isn't ours is never overwritten.
    const foreign = '/PhotoTrack/Notes.ptdelta';
    server.state.assets.push({ id: 'Q1', metadata: { filename: 'Notes.ptdelta', name: 'Notes.ptdelta', folderPath: '/PhotoTrack', assetPath: foreign, versionNumber: 1 } });
    server.state.files.set('Q1', Buffer.from('not a zip'));
    const n1 = uploads();
    london = await run({ ...london, elvisFile: foreign }, 'Selector');
    check('a file that isn’t PhotoTrack’s is left alone, with a reason', uploads() === n1 && useSyncStore.getState().status === 'error' && /isn't a PhotoTrack/.test(useSyncStore.getState().lastResult), useSyncStore.getState().lastResult);
    london = await run({ ...london, elvisFile: 'Gala.ptdelta' }, 'Selector');
    check('a path without a folder is refused with a reason', /folder/.test(useSyncStore.getState().lastResult), useSyncStore.getState().lastResult);

    // A project that isn't shared and has nothing linked never talks to Elvis.
    const q0 = server.state.queries.length;
    await run(fresh(), 'Selector', () => store().addRowsFromAssets([fakeAsset('IMG_9.jpg', new Uint8Array([9]))]));
    check('an unshared project with nothing linked makes no Elvis calls', server.state.queries.length === q0);

    check('across all of it, no photo in Elvis was written to', server.state.updates.length === 0 && server.state.uploads.every((u: { id: string }) => !/^A\d+$/.test(u.id)), server.state.updates);
    await server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

void main();
