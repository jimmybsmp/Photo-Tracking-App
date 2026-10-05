/**
 * Logic tests — schema migration, the store's rules, comment threads, delta
 * merge, and a simulated multi-site Elvis sync. No UI, no network: the "Elvis
 * server" here is a map of asset id → metadata that pushes write into and
 * pulls read from, which is all the sync rules ever see of it.
 *
 * Run with `npm run test:logic` (bundled by scripts/test-logic.mjs).
 */
import { migrate, type ShotRow, type TrackerDocument } from '@/state/schema';
import { computeStats, isRowComplete, nextStage, openConcerns } from '@/state/selectors';
import { useTrackerStore } from '@/state/useTrackerStore';
import { startHistory, undo } from '@/state/history';
import { setIdentity } from '@/lib/identity';
import { buildDelta, mergeDelta } from '@/lib/delta';
import { applyPull, planPull, planPush, recordFor } from '@/lib/elvis/sync';
import { normalizeElvisConfig, type ElvisConfig, type ElvisHit } from '@/lib/elvis/types';
import { syncNow, useSyncStore } from '@/lib/elvis/autoSync';
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
    check('v1 file opens as v2', doc.schemaVersion === 2);
    check('v1 values survive unchanged', r.mag.position === '12' && r.pr.retoucher === 'AB' && r.notes === 'hero' && r.mag.pipeline.qc === true && r.pr.pipeline.qc === false);
    check('v1 rows gain an empty comment thread', r.comments && Object.keys(r.comments).length === 0);
    check('v1 edit stamps are kept', r.fieldTimes.shotNum?.t === 5);
    check('longshot complete on mag without assembled/submitted/approved', isRowComplete({ ...r, usage: 'mag' }));

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
    check('both sites end up identical', recordFor(siteA.rows[id]) === recordFor(siteB.rows[id]));

    // Same Elvis asset, different row ids at two sites → merged, not duplicated.
    const a = { ...siteA.rows[id], id: 'local-1', elvisAssetId: 'X9' };
    const b = { ...siteB.rows[id], id: 'local-2', elvisAssetId: 'X9', notes: 'b' , fieldTimes: { ...siteB.rows[id].fieldTimes, notes: { t: Date.now() + 5, d: 'b' } } };
    const docA = { ...siteA, rows: { 'local-1': a }, rowIds: ['local-1'] };
    const docB = { ...siteB, rows: { 'local-2': b }, rowIds: ['local-2'] };
    const merged = mergeDelta(docA, buildDelta(docB, 0)).doc;
    check('the same Elvis asset under two row ids merges into one shot', merged.rowIds.length === 1 && merged.rows['local-1'].notes === 'b', merged.rowIds);
  }

  /* ---------------------------------------------------------------- */
  console.log('\nElvis: three sites, one shoot');
  {
    const config = normalizeElvisConfig({
      endpoint: 'https://dam.example.com',
      username: 'u',
      recordField: 'cf_photoTrack',
      mirror: { magSpread: 'cf_spread', magStatus: 'cf_magStatus' },
    });

    // The "server": asset id → metadata.
    const server: Record<string, Record<string, unknown>> = {
      A1: { filename: 'IMG_4821.CR3', folderPath: '/Shoots/Gala', cf_spread: '12' },
      A2: { filename: 'IMG_4822.CR3', folderPath: '/Shoots/Gala' },
    };
    const hits = (): ElvisHit[] => Object.entries(server).map(([id, metadata]) => ({ id, metadata: { ...metadata } }));
    const sync = async (doc: TrackerDocument, who: string) => {
      setIdentity({ name: who, role: 'staff' });
      const h = hits();
      const pulled = applyPull(doc, planPull(doc, h, config), new Map()).doc;
      for (const p of planPush(pulled, h, config)) Object.assign(server[p.assetId], p.metadata);
      return pulled;
    };
    const rowFor = (doc: TrackerDocument, asset: string): ShotRow => doc.rows[doc.rowIds.find((id) => doc.rows[id].elvisAssetId === asset) as string];

    // First pull: shots appear with shot number, name and folder; a mirror value fills in.
    let london = await sync((store().newProject(), store().doc), 'London');
    const first = rowFor(london, 'A1');
    check('a pulled shot is no longer blank', first.shotNum === 'IMG_4821' && first.elvisName === 'IMG_4821.CR3' && first.elvisPath === '/Shoots/Gala', first);
    check('a mirror field fills in on first pull', first.mag.position === '12');
    check('the project is now linked to Elvis', london.elvisLinked);
    check('the first sync writes a record to every asset', typeof server.A1.cf_photoTrack === 'string' && typeof server.A2.cf_photoTrack === 'string');

    let ny = await sync(store().doc && (store().newProject(), store().doc), 'NewYork');
    check('a second site pulls the same shots under the same ids', ny.rowIds.join() === london.rowIds.join());

    // Concurrent work at both sites.
    const a1 = first.id;
    london = await onSite(london, 'London', () => {
      store().setField(a1, 'usage', 'both');
      store().setStage(a1, 'mag', 'retouched', true);
      store().addComment(a1, { kind: 'concern', text: 'Needs CMYK proof', side: 'mag' });
    });
    ny = await onSite(ny, 'NewYork', () => {
      store().setField(a1, 'pr.retoucher', 'NYC team');
      store().setStage(a1, 'pr', 'retouched', true);
    });

    london = await sync(london, 'London');
    ny = await sync(ny, 'NewYork');
    london = await sync(london, 'London');

    const l = rowFor(london, 'A1');
    const n = rowFor(ny, 'A1');
    check('London sees New York’s press-release work', l.pr.retoucher === 'NYC team' && l.pr.pipeline.retouched);
    check('New York sees London’s magazine work and concern', n.mag.pipeline.retouched && openConcerns(n).length === 1 && openConcerns(n)[0].author === 'London');
    check('neither site overwrote the other', l.usage === 'both' && n.usage === 'both');
    check('who did it travels with the change', n.fieldTimes['mag.pipeline.retouched']?.u === 'London', n.fieldTimes['mag.pipeline.retouched']);

    // An executive at a third site resolves nothing but raises a concern; staff resolve it.
    let exec = await sync((store().newProject(), store().doc), 'Exec');
    exec = await onSite(exec, 'Exec', () => store().addComment(a1, { kind: 'concern', text: 'Spread 12 too dark', side: 'mag' }));
    exec = await sync(exec, 'Exec');
    london = await sync(london, 'London');
    const execConcern = openConcerns(rowFor(london, 'A1')).find((c) => c.author === 'Exec');
    check('the executive’s concern reaches London', Boolean(execConcern));
    london = await onSite(london, 'London', () => store().setCommentResolved(a1, execConcern!.id, true));
    london = await sync(london, 'London');
    exec = await sync(exec, 'Exec');
    const back = rowFor(exec, 'A1').comments[execConcern!.id];
    check('…and its resolution comes back to the executive', back.resolved && back.resolvedBy === 'London');

    // Mirror fields don't override real work once a record exists.
    server.A1.cf_spread = '99';
    ny = await sync(ny, 'NewYork');
    london = await sync(london, 'London');
    check('a value read from a plain field at one site reaches the others', rowFor(ny, 'A1').mag.position === '12', rowFor(ny, 'A1').mag.position);
    check('a stale plain field in Elvis can’t overwrite tracked data', rowFor(london, 'A1').mag.position === '12');
    check('the status field reflects progress, for people in Elvis', String(server.A1.cf_magStatus).startsWith('Waiting on'));

    // Idle: nothing to write.
    ny = await sync(ny, 'NewYork');
    check('an idle project makes no writes', planPush(ny, hits(), config).length === 0, planPush(ny, hits(), config));

    // A typed shot number is never replaced by the filename guess.
    ny = await onSite(ny, 'NewYork', () => store().setField(rowFor(ny, 'A2').id, 'shotNum', 'HERO-1'));
    ny = await sync(ny, 'NewYork');
    check('a shot number someone typed survives every pull', rowFor(ny, 'A2').shotNum === 'HERO-1');

    // Deleted here stays deleted.
    const a2 = rowFor(london, 'A2').id;
    london = await onSite(london, 'London', () => store().deleteRows([a2]));
    const deletedNow = london;
    london = await sync(london, 'London');
    check('a shot deleted here is not pulled back in', !london.rows[a2] && deletedNow.deletedRowIds[a2] !== undefined);
  }

  /* ---------------------------------------------------------------- */
  console.log('\nElvis: three sites, one shared tracking file (real client, mock server)');
  {
    const server = await startMockElvis({ assetCount: 3 });
    const client = createElvisClient(nodeTransport());
    const bridge = {
      elvisSearch: (c: ElvisConfig) => client.search(c),
      elvisFetchImage: (c: ElvisConfig, url: string) => client.fetchImage(c, url),
      elvisUpdate: (c: ElvisConfig, id: string, metadata: Record<string, unknown>) => client.update(c, id, metadata),
      elvisFindFile: (c: ElvisConfig, path: string) => client.findFile(c, path),
      elvisDownload: (c: ElvisConfig, url: string) => client.download(c, url),
      elvisUpload: (c: ElvisConfig, file: Parameters<DesktopBridge['elvisUpload']>[1]) => client.upload(c, file),
    } as unknown as DesktopBridge;
    (globalThis as unknown as { window: unknown }).window = { phototrack: bridge };

    const PATH = '/PhotoTrack/Gala 2026.ptdelta';
    const config = normalizeElvisConfig({ endpoint: server.origin, username: USER, password: PASSWORD, query: '*', trackingFile: PATH });
    check('a new setup shares through one file by default', config.sharedStore === 'file');
    check('a setup already using a record field keeps it', normalizeElvisConfig({ recordField: 'cf_photoTrack' }).sharedStore === 'field');
    useSyncStore.setState({ config });

    const run = async (doc: TrackerDocument, who: string, link = false) => {
      setIdentity({ name: who, role: who === 'Exec' ? 'executive' : 'staff' });
      useTrackerStore.setState({ doc });
      await tick();
      await syncNow({ link });
      return store().doc;
    };
    const fresh = () => (store().newProject(), store().doc);
    const fileAssets = () => server.state.assets.filter((a: { metadata: { assetPath?: string } }) => a.metadata.assetPath === PATH);
    const rowFor = (doc: TrackerDocument, asset: string): ShotRow => doc.rows[doc.rowIds.find((id) => doc.rows[id].elvisAssetId === asset) as string];
    const uploads = () => server.state.uploads.length;

    let london = await run(fresh(), 'London', true);
    check('first pull brings in the photos', london.rowIds.length === 3, london.rowIds.length);
    check('…creates the one shared file at the chosen path', fileAssets().length === 1 && uploads() === 1, server.state.uploads);
    check('…and never writes to the photos', server.state.updates.length === 0, server.state.updates);

    let ny = await run(fresh(), 'NewYork', true);
    check('a second site gets the same shots', ny.rowIds.join() === london.rowIds.join());
    check('the tracking file is never mistaken for a shot', ny.rowIds.every((id) => !/\.ptdelta$/i.test(ny.rows[id].elvisName)), ny.rowIds.map((id) => ny.rows[id].elvisName));
    check('a site with nothing new checks nothing in', uploads() === 1, server.state.uploads);

    const a1 = rowFor(london, 'A1').id;
    london = await onSite(london, 'London', () => {
      store().setField(a1, 'usage', 'both');
      store().setStage(a1, 'mag', 'retouched', true);
      store().setField(a1, 'mag.position', '14');
    });
    london = await run(london, 'London');
    check('an edit checks in a new version of the same file', uploads() === 2 && fileAssets().length === 1 && fileAssets()[0].metadata.versionNumber === 2, server.state.uploads);

    ny = await onSite(ny, 'NewYork', () => {
      store().setField(a1, 'pr.retoucher', 'NYC team');
      store().setStage(a1, 'pr', 'retouched', true);
    });
    ny = await run(ny, 'NewYork');
    check('New York gets London’s work and adds its own', rowFor(ny, 'A1').mag.pipeline.retouched && rowFor(ny, 'A1').mag.position === '14' && uploads() === 3);
    check('who did it travels in the file', rowFor(ny, 'A1').fieldTimes['mag.pipeline.retouched']?.u === 'London');

    let exec = await run(fresh(), 'Exec', true);
    check('a third site starting empty gets everything', rowFor(exec, 'A1').pr.retoucher === 'NYC team' && rowFor(exec, 'A1').mag.pipeline.retouched);
    exec = await onSite(exec, 'Exec', () => store().addComment(a1, { kind: 'concern', text: 'Spread 14 too dark', side: 'mag' }));
    exec = await run(exec, 'Exec');

    // Two sites check in at the same moment: the later version lacks the
    // earlier one's change. Simulated by putting the previous version back.
    const fileId = fileAssets()[0].id;
    const withConcern = server.state.files.get(fileId);
    const beforeConcern = Buffer.from(packDelta(sharedPayload(ny)));
    server.state.files.set(fileId, beforeConcern);
    fileAssets()[0].metadata.versionNumber += 1;
    check('(race set up: the file has lost the concern)', Object.keys(unpackDelta(new Uint8Array(beforeConcern)).rows[a1].comments).length === 0 && !!withConcern);
    const beforeRetry = uploads();
    exec = await run(exec, 'Exec');
    check('…the site whose change was lost notices and checks it in again', uploads() === beforeRetry + 1, { beforeRetry, after: uploads() });
    london = await run(london, 'London');
    const concern = openConcerns(rowFor(london, 'A1')).find((c) => c.author === 'Exec');
    check('…and it arrives at the other sites', Boolean(concern));

    london = await onSite(london, 'London', () => store().setCommentResolved(a1, concern!.id, true));
    london = await run(london, 'London');
    exec = await run(exec, 'Exec');
    const back = rowFor(exec, 'A1').comments[concern!.id];
    check('the resolution comes back to the executive', back?.resolved && back.resolvedBy === 'London');

    const before = uploads();
    ny = await run(ny, 'NewYork');
    ny = await run(ny, 'NewYork');
    exec = await run(exec, 'Exec');
    london = await run(london, 'London');
    check('once everyone is in step, idle syncs write nothing', uploads() === before, { before, after: uploads() });

    const a3 = rowFor(london, 'A3').id;
    london = await onSite(london, 'London', () => store().deleteRows([a3]));
    london = await run(london, 'London');
    ny = await run(ny, 'NewYork');
    ny = await run(ny, 'NewYork');
    check('a deleted shot goes at every site and the photo pull doesn’t bring it back', !ny.rows[a3] && !london.rows[a3]);

    // Two copies at the path (two sites created it at once): both are read.
    const stray = sharedPayload(exec);
    stray.rows = { [a1]: { ...stray.rows[a1], comments: { x1: { ...back!, id: 'x1', text: 'From the second copy', resolved: false, resolvedBy: '', resolvedAt: 0, resolvedDevice: '' } } } };
    server.state.assets.push({ id: 'Z9', metadata: { filename: 'Gala 2026.ptdelta', name: 'Gala 2026.ptdelta', folderPath: '/PhotoTrack', assetPath: PATH, versionNumber: 1 } });
    server.state.files.set('Z9', Buffer.from(packDelta(stray)));
    ny = await run(ny, 'NewYork');
    check('a second copy of the file is merged, not ignored', Boolean(rowFor(ny, 'A1').comments.x1));
    check('…and the first copy is the one kept up to date', unpackDelta(new Uint8Array(server.state.files.get(fileId))).rows[a1].comments.x1 !== undefined);

    // Something that isn't ours at the path is never overwritten.
    const foreignPath = '/PhotoTrack/Notes.ptdelta';
    server.state.assets.push({ id: 'Q1', metadata: { filename: 'Notes.ptdelta', name: 'Notes.ptdelta', folderPath: '/PhotoTrack', assetPath: foreignPath, versionNumber: 1 } });
    server.state.files.set('Q1', Buffer.from('not a zip'));
    useSyncStore.setState({ config: { ...config, trackingFile: foreignPath } });
    const n0 = uploads();
    ny = await run(ny, 'NewYork');
    check('a file at the path that isn’t PhotoTrack’s is left alone, with a reason', uploads() === n0 && useSyncStore.getState().status === 'error' && /isn't a PhotoTrack/.test(useSyncStore.getState().lastResult), useSyncStore.getState().lastResult);
    useSyncStore.setState({ config: { ...config, trackingFile: 'Gala.ptdelta' } });
    ny = await run(ny, 'NewYork');
    check('a path without a folder is refused with a reason', /folder/.test(useSyncStore.getState().lastResult), useSyncStore.getState().lastResult);

    check('across all of it, no photo’s metadata was written', server.state.updates.length === 0, server.state.updates);
    await server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

void main();
