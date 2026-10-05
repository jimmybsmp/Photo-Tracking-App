# Working in this repo

PhotoTrack — a photo production tracker: shot in, tracked through retouch,
QC, assembly, submission, and approval, on the magazine and press-release
tracks independently. Read `README.md` first for the workflow and the file
formats. This app is the sibling of OpticPlan (`Camera-app`) — same stack,
same build split, same reasons for both.

## Ground rules

- **Rows are keyed, order is separate.** `doc.rows` is an id-keyed record and
  `doc.rowIds` is the draw/print order. A row mutation must not create a new
  `rowIds` array — see `state/useTrackerStore.ts`.
- **Never return a fresh object from a zustand selector** without
  `useShallow` — it makes the store see a new value every render and loops
  until React throws error #185. Read scalars individually, or subscribe to
  one row by id (`s.doc.rows[rowId]`) rather than the whole `rows` map.
- **Magazine and press release are separate tracks, every stage included.**
  The user confirmed it: magazine images get their own CMYK and detail
  retouching. Never merge, mirror or OR the two sides' stages together.
- **A display decision never discards data.** Switching a row's usage away
  from a side, or its shot type to longshot, must never clear that side's
  position, retoucher, or stages. A longshot's assembled/submitted/approved
  are *hidden* and left out of counts — the user's rule — not reset or
  disabled. `state/selectors.ts` (`applicableStages`, `activeSides`,
  `nextStage`) is the single definition of what's shown and counted; views
  never re-derive it.
- **Every row field carries its own edit stamp.** `touchRowField` in
  `state/schema.ts`, with `stampNow()` from `lib/identity.ts`, is how a field
  gets written — never assign a row field directly. The `{t, d, u}` stamp
  (time, device, person) is what lets delta import and Elvis pull combine two
  sites' edits instead of one clobbering the other, and what shows "QC ✓ · Jo,
  14:02". Values PhotoTrack infers (shot # from a filename, a plain Elvis
  field) get the weakest stamp, `t: 1`, so they fill blanks and never beat a
  person's edit.
- **Comments are append-only.** Text is never edited after posting; only
  `resolved` changes, with its own stamp. That is what lets threads merge
  between sites by simple union (`mergeComment`).
- **Only drag handles are draggable.** A `draggable` tile or row turns a
  slightly-moving click on its buttons into a drag — buttons that "sometimes
  don't work". Keep `draggable` on the ⋮⋮ handle only.
- **Images are content-addressed, never inlined per row.** A row holds an
  `imageHash` into `doc.assets`; the same frame imported twice is the same
  asset. Import always goes through `lib/images.ts` (resize to thumb + review
  sizes, then hash) — never store a raw `File`'s data URL directly on a row.
- **Never re-introduce per-keystroke autosave to `localStorage`, or re-zip
  the photos on every edit.** The first killed the original tool after one
  full-size photo; the second made v0.1 stall as projects grew. Autosave
  (`lib/autosave.ts`) writes the small shot data each time and a photo only
  once, to IndexedDB, debounced; a failed write is swallowed.
- **Text inputs pass `{ typing: true }` to `setField`.** History folds a burst
  of keystrokes on one field into a single undo step (`lastEdit` in the store,
  `COALESCE_MS` in `state/history.ts`).
- **Schema changes are migrations.** Bump `SCHEMA_VERSION` in
  `state/schema.ts` and add a branch to `migrate()`. Never edit an existing
  branch — files exported from the original HTML tool still have to enter
  through the legacy path, and once this app ships a v2, v1 files need their
  own path too.
- **Elvis credentials never leave the desktop app's config file.** They are
  not part of `TrackerDocument`, so they can never end up in a `.phototrack`
  save, a `.ptdelta` export, or the crash-recovery file. The request itself
  only ever originates in the main process (`electron/elvisClient.cjs` for
  the protocol, `electron/elvisTransport.cjs` for Electron's `net`) — never call
  `window.phototrack.elvis*` assuming it exists without checking
  `isDesktop()` first, and never add a fetch to Elvis from a component.
- **It has to work offline.** No CDN, no runtime network calls except the
  Elvis sync a user explicitly configures and triggers. Nothing is fetched at
  load. The desktop app ships its typeface inside the bundle; the standalone
  file uses the system stack — see "The two builds" in the README.

## Before pushing

```bash
npm run typecheck && npm run build && npm test
```

`npm test` = `tests/logic.test.ts` (bundled by esbuild; migration, longshot
rule, undo, comments, delta, three sites syncing through a simulated Elvis
record field, and three sites sharing one tracking file through the real
client and the mock server) plus the Elvis protocol tests against the mock.

`npm run build` also asserts the output loads from `file://` — see
`scripts/check-file-protocol.mjs` for the three ways it silently doesn't.

## Elvis protocol and sync

Elvis has no static API key: log in with username + password at
`/services/login`, then send the returned `authToken` as a Bearer header
(Elvis 6 / Assets) or keep the session cookie and send `X-CSRF-TOKEN`
(Elvis 5). Writes are **form parameters** — `update` takes `id` plus
`metadata` as a JSON *string*; `updatebulk` takes `q` instead of `id`. Keep
network calls on Electron's `net`, not Node's `https`: only `net` trusts the
macOS Keychain and the system proxy, which a company-hosted DAM usually
needs. `scripts/mock-elvis-server.mjs` is strict about all of this on purpose
— if a change makes it fail, a real server would fail too. Image downloads go
only to the configured server's origin: the request carries the login.

Sync (`lib/elvis/sync.ts` and `lib/elvis/sharedFile.ts` rules,
`lib/elvis/autoSync.ts` I/O) never writes to the photos unless plain mirror
fields are mapped. The shared state lives in one of two places
(`config.sharedStore`):

- **The shared file** (default): one `.ptdelta` per shoot at a path every
  site enters identically. A cycle downloads every copy at that path, merges
  with `mergeDelta`, and checks in a new version (`update` + `Filedata`) only
  when `fileNeedsUpdate` says the file lacks something — so idle sites never
  write and a lost race heals on the next cycle. Elvis-linked rows go in
  without `imageHash` (each site gets the picture from the asset itself);
  only dropped photos carry pixels. Never write over a file that doesn't
  unpack as a delta, and never let the file become a shot
  (`isTrackingFileHit`).
- **The record field**: holds the shot's full state as canonical JSON —
  fields, stamps, comments — and merges with `mergeRow`, the same merge delta
  files use. Plain
"mirror" fields are written for people in Elvis and read *only* when an asset
has no record yet; they carry no stamps, so they must never override a record.
Push writes only fields whose value differs from what the preceding pull saw.
A project syncs only once `doc.elvisLinked` is set by an explicit pull.

## Design

Three views: Overview (executive dashboard, opens first), Shots (tiles +
shot panel), Sheet (print). Dark chrome (bars, panels, inspector, overview)
around a light working surface (shot tiles, the printed sheet). Magazine and
press release each keep one colour everywhere (`--mag`, `--pr`) — the chrome is instrument-panel, the surface
is the paper the shoot gets judged on, so it stays white on screen and on
paper alike. Tokens and component classes live in `src/styles/index.css`;
print-only rules are in `src/styles/print.css`, targeting `.sheet-page` and
hiding everything marked `.no-print`.

## The two builds

`npm run dist:mac` packages the Electron app universal (arm64 + x64) — but
that only works **on a Mac**, since the merge needs `lipo` and Apple Silicon
refuses to launch unsigned arm64 code. Off a Mac, build `--mac zip --x64`
instead: it covers 10.13 Intel natively and Apple Silicon under Rosetta 2.
`npm run build:standalone` emits the portable single HTML file. The three
share all of `src/` and differ only in what the shell provides:

- **Fonts.** The desktop app bundles IBM Plex from `src/styles/fonts.css`.
  The standalone build aliases that file to an empty one — see the alias
  array in `vite.standalone.config.ts`, where order matters, since the font
  sheet has to be redirected before the generic `@` alias resolves it.
- **Shell features.** Anything native goes through `src/lib/desktop.ts` and
  is a no-op in a browser, so the same renderer runs in both. Never call
  `window.phototrack` directly from a component — always through `desktop()`.
- **Elvis sync** only exists behind `isDesktop()`. It needs a main-process
  HTTP request (past CORS, and to keep the request off the renderer's
  `file://` origin) — see `electron/main.cjs`'s `elvis:search`/`elvis:update`
  handlers and `src/components/elvis/ElvisPanel.tsx`.

The project file format (`.phototrack`) and the delta format (`.ptdelta`) are
identical in both builds, deliberately: work drafted on the offline machine
has to open on the desktop app, and a delta exported from either has to merge
into the other. Do not add a second format for either.

## Known gaps

See the README's "Known gaps" section.
