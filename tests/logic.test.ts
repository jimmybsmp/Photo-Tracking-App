/**
 * Logic tests — schema migration, the store's rules, comment threads, delta
 * merge, and a simulated multi-site Elvis sync. No UI, no network: the "Elvis
 * server" here is a map of asset id → metadata that pushes write into and
 * pulls read from, which is all the sync rules ever see of it.
 *
 * Run with `npm run test:logic` (bundled by scripts/test-logic.mjs).
 */
import { SCHEMA_VERSION, defaultProperties, migrate, trackOf, withLegacyFields, type AssetMeta, type ShotRow, type TrackerDocument } from '@/state/schema';
import { propertyList } from '@/state/properties';
import {
  activeSides,
  attentionItems,
  computeStats,
  defaultFilters,
  isRejected,
  isRowComplete,
  isShared,
  isSideComplete,
  matchesFilters,
  nextStage,
  openConcerns,
  rejectsOf,
  sideStatusLabel,
} from '@/state/selectors';
import { createHash } from 'node:crypto';
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
    check('v1 file opens at the current version', doc.schemaVersion === SCHEMA_VERSION);
    check('v1 values survive unchanged', r.tracks.mag.position === '12' && r.tracks.pr.retoucher === 'AB' && r.notes === 'hero' && r.tracks.mag.pipeline.qc === true && r.tracks.pr.pipeline.qc === false);
    check('v1 rows gain an empty comment thread', r.comments && Object.keys(r.comments).length === 0);
    check('v1 edit stamps are kept', r.fieldTimes.shotNum?.t === 5);
    const defaults = propertyList(defaultProperties());
    check('a v1 shot in both runs in both properties', activeSides(r, defaults).join() === 'mag,pr');
    check('longshot complete on mag without assembled/submitted/approved', isRowComplete({ ...r, tracks: { ...r.tracks, pr: { ...r.tracks.pr, on: false } } }, defaults));

    const v2 = migrate({ ...v1, schemaVersion: 2, elvisLinked: true }).doc;
    check('a v2 file opens as v3, unshared, its folder link dropped', v2.schemaVersion === SCHEMA_VERSION && v2.elvisFile === '' && Object.keys(v2.elvisPreviews).length === 0 && !('elvisLinked' in v2));
    const v3 = migrate({ ...v1, schemaVersion: 3, elvisFile: '/PhotoTrack/G.ptdelta', elvisPreviews: { A1: { version: '2', hash: 'h' }, bad: 4 } }).doc;
    check('a v3 file keeps its shared file and preview versions', v3.elvisFile === '/PhotoTrack/G.ptdelta' && v3.elvisPreviews.A1?.hash === 'h' && !('bad' in v3.elvisPreviews));

    const legacy = {
      headerEvent: 'Old tool',
      rows: [{ shotNum: '9', usage: 'both', shotType: 'closeup', toggles: [true, false, false, true, false, false, false, false, false, false] }],
    };
    const old = migrate(legacy).doc;
    const lr = old.rows[old.rowIds[0]];
    check('original HTML tool export still imports', old.header.event === 'Old tool' && lr.shotNum === '9');
    check('…with its toggles mapped to the right property', lr.tracks.mag.pipeline.retouched && !lr.tracks.pr.pipeline.retouched && lr.tracks.pr.pipeline.qc && !lr.tracks.mag.pipeline.qc, { mag: lr.tracks.mag.pipeline, pr: lr.tracks.pr.pipeline });
  }

  /* ---------------------------------------------------------------- */
  console.log('\nlongshot rule');
  {
    store().newProject();
    const id = store().addRow();
    store().setField(id, 'pr.on', true);
    store().setField(id, 'shotType', 'longshot');
    store().setStage(id, 'pr', 'assembled', true);
    check('a longshot cannot be marked assembled', store().doc.rows[id].tracks.pr.pipeline.assembled === false);
    store().setStage(id, 'pr', 'retouched', true);
    store().setStage(id, 'pr', 'qc', true);
    check('a longshot is complete after retouch + QC', isRowComplete(store().doc.rows[id], propertyList(store().doc.properties)));
    const stats = computeStats(store().doc);
    check('exempt stages are left out of the counts', stats.sides.pr.stages.assembled.eligible === 0 && stats.sides.pr.complete === 1, stats.sides.pr);

    store().setField(id, 'shotType', 'closeup');
    store().setStage(id, 'pr', 'assembled', true);
    store().setField(id, 'shotType', 'longshot');
    store().setField(id, 'shotType', 'closeup');
    check('switching shot type back and forth keeps the stored stage', store().doc.rows[id].tracks.pr.pipeline.assembled === true);
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
    check('undo reverts the last click on its own', trackOf(store().doc.rows[id], 'mag').pipeline.retouched === false && store().doc.rows[id].shotNum === '1234');
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
    store().setField(id, 'mag.on', true);
    store().setField(id, 'pr.on', true);
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
    check('edits to different properties of one shot both survive', siteA.rows[id].tracks.mag.pipeline.retouched && siteA.rows[id].tracks.pr.pipeline.qc);
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
  console.log('\ncustom properties');
  {
    store().newProject();
    setIdentity({ name: 'Producer', role: 'staff' });
    check('a new project starts with Magazine and Press release', propertyList(store().doc.properties).map((p) => p.name).join() === 'Magazine,Press release');
    const id = store().addRow();
    store().setField(id, 'mag.on', true);
    const web = store().addProperty('Website');
    const webDef = store().doc.properties[web];
    check('an added property gets a tag, a colour of its own, and goes last', webDef.short === 'WEB' && webDef.color !== '#60a5fa' && webDef.color !== '#34d399' && propertyList(store().doc.properties).at(-1)?.id === web, webDef);

    store().setField(id, `${web}.on`, true);
    let props = propertyList(store().doc.properties);
    let row = store().doc.rows[id];
    check('a shot can run in the new property alongside the magazine', activeSides(row, props).join() === `mag,${web}` && isShared(row, props));
    store().setStage(id, web, 'retouched', true);
    store().setField(id, `${web}.retoucher`, 'Ana', { typing: false });
    row = store().doc.rows[id];
    check('its stages and retoucher are its own', row.tracks[web].pipeline.retouched && !row.tracks.mag.pipeline.retouched && row.tracks[web].retoucher === 'Ana');
    let stats = computeStats(store().doc);
    check('the overview counts it like any property', stats.sides[web].shots === 1 && stats.sides[web].stages.retouched.done === 1 && stats.shared === 1, stats.sides[web]);
    check('filters find it', matchesFilters(row, { ...defaultFilters, property: web }, props) && matchesFilters(row, { ...defaultFilters, property: 'shared' }, props));

    store().batchSetStage([id], 'active', 'qc', true);
    row = store().doc.rows[id];
    check('a batch change aimed at "every property it runs in" reaches the new one too', row.tracks[web].pipeline.qc && row.tracks.mag.pipeline.qc);

    store().setPropertyArchived(web, true);
    props = propertyList(store().doc.properties);
    row = store().doc.rows[id];
    stats = computeStats(store().doc);
    check('hiding a property takes it out of views and counts', activeSides(row, props).join() === 'mag' && !(web in stats.sides) && stats.shared === 0);
    check('…without discarding anything in it', row.tracks[web].on && row.tracks[web].retoucher === 'Ana' && row.tracks[web].pipeline.retouched);
    store().setPropertyArchived(web, false);
    check('showing it again brings the shot back in it, as it was', activeSides(store().doc.rows[id], propertyList(store().doc.properties)).includes(web));

    store().moveProperty(web, -1);
    check('properties can be reordered', propertyList(store().doc.properties).map((p) => p.id).join() === `mag,${web},pr`);
    store().updateProperty(web, { name: 'Web', positionLabel: 'Page #' });
    check('…and renamed', store().doc.properties[web].name === 'Web' && store().doc.properties[web].positionLabel === 'Page #');

    // Two sites each add a property and use it; a delta each way.
    const base = store().doc;
    let siteA = await onSite(base, 'A', () => {
      const social = store().addProperty('Social');
      store().setField(id, `${social}.on`, true);
    });
    let siteB = await onSite(base, 'B', () => {
      const book = store().addProperty('Annual report');
      store().setField(id, `${book}.on`, true);
      store().updateProperty(web, { color: '#f472b6' });
    });
    siteA = mergeDelta(siteA, buildDelta(siteB, 0)).doc;
    siteB = mergeDelta(siteB, buildDelta(siteA, 0)).doc;
    const names = (d: TrackerDocument) => propertyList(d.properties).map((p) => p.name).sort().join();
    check('properties added at two sites both arrive at both', names(siteA) === names(siteB) && names(siteA).includes('Social') && names(siteA).includes('Annual report'), [names(siteA), names(siteB)]);
    // Magazine, Web, and the two new ones.
    check('…with the shot in both new ones at both sites', activeSides(siteA.rows[id], propertyList(siteA.properties)).length === 4 && activeSides(siteB.rows[id], propertyList(siteB.properties)).length === 4);
    check('a property edit at one site reaches the other', siteA.properties[web].color === '#f472b6');

    // A site still on 0.4 (v3 rows: mag/pr/usage) in the same exchange.
    const out = buildDelta(siteA, 0).rows[id] as unknown as Record<string, unknown> & { usage: string; mag: { retoucher: string } };
    check('rows going out still carry v3 fields for a site on 0.4', out.usage === 'mag' && typeof out.mag === 'object' && out.mag.retoucher === '');
    const old = withLegacyFields(siteA.rows[id]) as unknown as Record<string, unknown>;
    const fromOld = { ...old, tracks: undefined, usage: 'pr', fieldTimes: { ...siteA.rows[id].fieldTimes, usage: { t: Date.now() + 1000, d: 'old', u: 'Old site' } } };
    const legacyDelta = { ...buildDelta(siteA, 0), rows: { [id]: fromOld as unknown as ShotRow }, properties: undefined };
    const afterOld = mergeDelta(siteA, legacyDelta).doc;
    check('a newer usage change from a 0.4 site lands as magazine off, press release on', afterOld.rows[id].tracks.mag.on === false && afterOld.rows[id].tracks.pr.on === true);
    check('…and leaves the added properties alone', afterOld.rows[id].tracks[web].on === true && Object.keys(afterOld.properties).length === 5);

    // A v3 file opens with its usage turned into tracks, stamps kept.
    const v3 = migrate({
      schemaVersion: 3,
      rows: { r: { id: 'r', usage: 'both', mag: { position: '7' }, pr: {}, fieldTimes: { usage: { t: 50, d: 'x', u: 'Jo' } } } },
      rowIds: ['r'],
    }).doc;
    check('a v3 file opens with both tracks on and the usage stamp on each', v3.rows.r.tracks.mag.on && v3.rows.r.tracks.pr.on && v3.rows.r.tracks.mag.position === '7' && v3.rows.r.fieldTimes['pr.on']?.u === 'Jo' && !('usage' in v3.rows.r.fieldTimes));
  }

  /* ---------------------------------------------------------------- */
  console.log('\nrejects');
  {
    store().newProject();
    setIdentity({ name: 'QC desk', role: 'staff' });
    const id = store().addRow();
    store().setField(id, 'mag.on', true);
    store().setField(id, 'pr.on', true);
    for (const stage of ['retouched', 'qc', 'assembled', 'submitted', 'approved'] as const) store().setStage(id, 'mag', stage, true);
    let props = propertyList(store().doc.properties);
    check('a finished track with no reject is complete', isSideComplete(store().doc.rows[id], 'mag'));

    store().setField(id, 'mag.qcReject', true);
    let row = store().doc.rows[id];
    check('a QC reject is its own flag on that property only', row.tracks.mag.qcReject && !row.tracks.pr.qcReject && !row.tracks.mag.officeReject);
    check('…shown as the status', sideStatusLabel(row, 'mag') === 'QC reject' && rejectsOf(row, 'pr').length === 0);
    check('…and a shot on a reject is never complete, whatever is ticked', !isSideComplete(row, 'mag') && row.tracks.mag.pipeline.approved);
    store().setField(id, 'mag.officeReject', true);
    row = store().doc.rows[id];
    check('both rejects at once', sideStatusLabel(row, 'mag') === 'QC + office reject');
    const stats = computeStats(store().doc);
    check('the overview counts it', stats.rejected === 1 && stats.sides.mag.rejected === 1 && stats.sides.mag.complete === 0 && stats.sides.pr.rejected === 0);
    check('rejects head the needs-attention list', attentionItems(store().doc)[0]?.kind === 'reject');
    check('the "on a reject" filter finds it, per property', matchesFilters(row, { ...defaultFilters, attention: 'rejected' }, props) && !matchesFilters(row, { ...defaultFilters, attention: 'rejected', property: 'pr' }, props));
    check('who set it is recorded', row.fieldTimes['mag.qcReject']?.u === 'QC desk');

    // Clearing at one site while the other site sets the office reject on PR.
    const base = store().doc;
    let siteA = await onSite(base, 'A', () => store().setField(id, 'mag.qcReject', false));
    let siteB = await onSite(base, 'B', () => store().setField(id, 'pr.officeReject', true));
    siteA = mergeDelta(siteA, buildDelta(siteB, 0)).doc;
    siteB = mergeDelta(siteB, buildDelta(siteA, 0)).doc;
    check('rejects set and cleared at two sites merge', canonical(siteA.rows[id].tracks) === canonical(siteB.rows[id].tracks) && !siteA.rows[id].tracks.mag.qcReject && siteA.rows[id].tracks.mag.officeReject && siteA.rows[id].tracks.pr.officeReject);

    const v4 = migrate({ schemaVersion: 4, rows: { r: { id: 'r', tracks: { mag: { on: true } } } }, rowIds: ['r'] }).doc;
    props = propertyList(v4.properties);
    check('a v4 file opens with nothing on reject', v4.schemaVersion === SCHEMA_VERSION && !v4.rows.r.tracks.mag.qcReject && !isRejected(v4.rows.r, props));
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
      store().setField(store().doc.rowIds[0], 'mag.on', true);
      store().setField(store().doc.rowIds[0], 'pr.on', true);
    });
    london = await run(london, 'Selector', () => shareProject(PATH));
    check('sharing creates the shared file and its photos file', filesAt(PATH).length === 1 && filesAt(PHOTOS).length === 1, server.state.uploads);
    check('…the shared file holds the shots, no pixels', Object.keys(fileContent(PATH).rows).length === 3 && Object.keys(fileContent(PATH).assets).length === 0);
    check('…the photos file holds a thumbnail of each, no full size', Object.values(fileContent(PHOTOS).assets).length === 3 && Object.values(fileContent(PHOTOS).assets).every((a) => a.thumbUrl && !a.reviewUrl));
    check('the project remembers its shared file', london.elvisFile === PATH);

    // Another site joins.
    let exec = await run(fresh(), 'Exec', () => shareProject(PATH));
    const e4821 = byShot(exec, 'IMG_4821');
    check('a site that joins gets every shot', exec.rowIds.length === 3 && e4821?.tracks.mag?.on === true && e4821?.tracks.pr?.on === true, exec.rowIds.length);
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

    // A property added at one site reaches the others through the shared file.
    let webId = '';
    london = await run(london, 'Selector', () => {
      webId = store().addProperty('Website');
      store().setField(byShot(store().doc, 'IMG_4822').id, `${webId}.on`, true);
    });
    exec = await run(exec, 'Exec');
    check('a property added at one site arrives at the others with its shots', exec.properties[webId]?.name === 'Website' && byShot(exec, 'IMG_4822').tracks[webId]?.on === true);

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
    check('a site whose change was overwritten checks it in again', uploads() === n0 + 1 && fileContent(PATH).rows[rowId].tracks.pr.pipeline.qc, server.state.uploads.slice(n0));

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
