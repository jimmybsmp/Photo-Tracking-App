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
- **A display decision never discards data.** Switching a row's usage away
  from a side, or its shot type to longshot, must never clear that side's
  position, retoucher, or pipeline booleans. The tool this replaces did both,
  and lost the fields on a light click and lost pipeline state on every file
  load. `state/selectors.ts`'s `applicableStages`/`activeSides` decide what's
  *shown and counted* without touching what's *stored*.
- **Every row field carries its own edit stamp.** `touchRowField` in
  `state/schema.ts` is how a field gets written — never assign a row field
  directly outside it. The `{t, d}` stamp is what makes delta merge
  (`lib/delta.ts`) and Elvis pull (`lib/elvis/sync.ts`) both able to combine
  two units' edits on the same row instead of one clobbering the other.
- **Images are content-addressed, never inlined per row.** A row holds an
  `imageHash` into `doc.assets`; the same frame imported twice is the same
  asset. Import always goes through `lib/images.ts` (resize to thumb + review
  sizes, then hash) — never store a raw `File`'s data URL directly on a row.
- **Never re-introduce per-keystroke autosave to `localStorage`.** That is
  the bug that made the original tool die after one full-size photo — its
  quota is a few MB, and a failed `setItem` was never checked. Autosave goes
  through `lib/autosave.ts`, debounced, to disk (desktop) or IndexedDB
  (browser), and a failed write is swallowed rather than surfacing mid-edit.
- **Schema changes are migrations.** Bump `SCHEMA_VERSION` in
  `state/schema.ts` and add a branch to `migrate()`. Never edit an existing
  branch — files exported from the original HTML tool still have to enter
  through the legacy path, and once this app ships a v2, v1 files need their
  own path too.
- **Elvis credentials never leave the desktop app's config file.** They are
  not part of `TrackerDocument`, so they can never end up in a `.phototrack`
  save, a `.ptdelta` export, or the crash-recovery file. The request itself
  only ever originates in `electron/main.cjs` — never call
  `window.phototrack.elvis*` assuming it exists without checking
  `isDesktop()` first, and never add a fetch to Elvis from a component.
- **It has to work offline.** No CDN, no runtime network calls except the
  Elvis sync a user explicitly configures and triggers. Nothing is fetched at
  load. The desktop app ships its typeface inside the bundle; the standalone
  file uses the system stack — see "The two builds" in the README.

## Before pushing

```bash
npm run typecheck && npm run build
```

## Design

Dark chrome (toolbar, stats bar, inspector) around a light working surface
(the grid, the printed sheet) — the chrome is instrument-panel, the surface
is the paper the shoot gets judged on, so it stays white on screen and on
paper alike. Tokens and component classes live in `src/styles/index.css`;
print-only rules are in `src/styles/print.css`, targeting `.sheet-page` and
hiding everything marked `.no-print`.

## The two builds

`npm run dist:mac` packages the Electron app, universal (arm64 + x64) so one
build covers macOS 10.13 through Apple Silicon; `npm run build:standalone`
emits the portable single HTML file. They share all of `src/` and differ
only in what the shell provides:

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

See the README's "Known gaps" section — lane/board grouping in the grid,
Elvis sync unverified against a real server, delta merge as per-field
last-write-wins rather than a full CRDT, and the `.dmg`/code-signing
limitations shared with OpticPlan.
