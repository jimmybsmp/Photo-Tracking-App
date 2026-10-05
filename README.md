# PhotoTrack

A photo production tracker for a shoot: every frame, where it runs —
magazine, press release, or both — who is retouching it, and where it stands
on each property's track: retouched → QC → assembled → submitted → approved.
Built so that an executive and every member of staff, at any site, see the
same current picture, and so that an executive's concerns reach the people
doing the work and get answered.

Magazine and press release are tracked separately, every stage included: a
magazine image is printed far larger than anything online and usually gets its
own CMYK colour work and detail retouching.

## Who sees what

- **Overview** (opens first) — the executive view. Progress per property with
  each stage's count, what's waiting where, open concerns, shots that need
  someone (stalled after retouch, no retoucher, no usage), every shot running
  in both properties side by side, retouching workload, and recent activity
  with who did it. Every number opens exactly those shots.
- **Shots** — every shot as a tile showing both tracks. Click one to open it:
  usage, shot type, spread/slide, retoucher and the stage checklist for each
  property, with who checked each stage and when, plus its notes & concerns.
- **Sheet** — the tabloid tracker sheet for print or PDF, editable like a
  spreadsheet.

Everyone enters their name once (and whether they're an executive). It goes
on every stage they mark and every comment they post. An executive's comments
default to **concerns**, which stay open — on the tile, on the overview — until
someone on the team replies and resolves them.

## The workflow

It starts offline and moves onto Elvis one shot at a time:

1. **Select** — someone goes through the raw folder, picks a frame, makes a
   JPEG of it and drops it on the Shots tab. That shot is now tracked. Nothing
   needs Elvis yet.
2. **Set where each shot runs** — Magazine, Press release, or Both — and its
   shot type. A longshot skips assembly, submission and approval; those three
   stages are hidden for it and left out of every count.
3. **Share the project** (once per shoot) — every site works from one shared
   file in Elvis; see below. Each site sees the same shots, stages, comments
   and the selector's photos.
4. **Link to Elvis** — when the retoucher's first pass is in Elvis, they open
   the shot and, under **Elvis**, paste the asset's id or link (or press
   Find: the box starts with the shot number). From then on the shot's
   picture is that asset's preview, and every new version checked in to Elvis
   shows up at every site on the next sync. All the other frames in that Elvis
   folder — the layout tests, the rejects — are ignored.
5. **Work the tracks** — check stages off in the shot's panel or on the sheet;
   assign retoucher per property.
6. **Discuss on the shot** — concerns and notes, replies, resolve.

## The two builds

Both ship from the same source and read/write the exact same `.phototrack`
project file, so a project drafted on one machine opens unmodified on the
other — that's deliberate, the same reasoning as the sibling OpticPlan app.

| | Desktop app | Standalone HTML |
| --- | --- | --- |
| Runs on | macOS 10.13 (High Sierra) through Apple Silicon — see the build note below | Any browser, any machine |
| Install | Unzip, drag to Applications | Double-click the file |
| Saving | Native dialogs; Save writes back to the open file | Browser download |
| Crash recovery | Autosaves to disk, offers to restore | Autosaves to IndexedDB, offers to restore |
| WoodWing Elvis sync | Yes | Not available — needs a real server request, which a browser page can't make past CORS |
| PDF export | Straight to a chosen path | Browser print dialog |

```bash
npm run dist:mac                        # universal .app — must run ON a Mac (see below)
npx electron-builder --mac zip --x64    # x64 .app — builds anywhere, incl. Linux/CI
npm run build:standalone                # portable file -> release/PhotoTrack-<version>-<date>.html
```

Both target **Electron 22** specifically — the last major version with a
macOS 10.13 build. Electron 22 no longer gets security patches; for an
offline, internal production tool that's an accepted tradeoff for covering
10.13 at all.

**Which desktop build to make depends on where you're building.** Two macOS
toolchain binaries decide this, and neither exists off a Mac:

| | Needs | Result |
| --- | --- | --- |
| `--x64` | nothing | Runs natively on 10.13 Intel; runs on Apple Silicon under Rosetta 2 |
| `--arm64` | `codesign` | Apple Silicon refuses to launch unsigned arm64 code, and packaging breaks Electron's own signature — so this is Mac-only in practice |
| `--universal` | `lipo` + `codesign` | Merges both into one binary; Mac-only |
| `dmg` target | `hdiutil` | Mac-only; elsewhere the build emits a `.zip` of the `.app` |

So **building from Linux or CI, use `--x64`** — one file that covers both an
old Intel Mac and Apple Silicon, at the cost of Rosetta translation on the
latter. To get a native Apple Silicon or universal build, run
`npm run dist:mac` on any Mac with Node installed.

Either way the app is unsigned, so the first launch needs right-click → Open
once. Unzip it and drag to Applications.

## Why a `.phototrack` file, not JSON

The old tool's project file was one JSON blob with every photo embedded as
full-resolution base64 — a fast way to make a project too large to open. A
`.phototrack` file is a zip: a small `document.json` (every row's data, no
pixels) plus one thumbnail and one review-size image per **distinct** photo,
stored as real binary JPEG/PNG. Two rows that happen to share an identical
frame — or a photo re-imported after already being tracked — cost nothing
extra, because every image is addressed by a content hash rather than copied
per row. Dropping the same file on the grid twice doesn't create a second
row for it; it's already tracked.

## How two sites stay in step

Every field on every shot carries an edit stamp — when, on which machine, by
whom. Merging another site's copy compares those stamps field by field and
keeps the newer, so one site retouching a shot while another sets its spread
number both land; neither overwrites the other. Comments merge by union, and a
concern's open/resolved state follows its own newest change. The same merge
runs whether the other copy arrives from Elvis or from a delta file.

**Delta files** (`.ptdelta`, File → Export / Import changes) carry everything
changed since the last export, for machines with no network between them —
hand them over on a USB stick or by email.

What this doesn't do: merge two *simultaneous* edits to the exact same field
(newest wins, tie-broken by machine), and the shoot's header merges as one
block.

## WoodWing Elvis

Desktop app only (a browser page can't sign in to a DAM). Open it from the
chip at the top right. PhotoTrack does exactly two things in Elvis, and never
changes a photo there:

**1. One shared file per shoot.** Make a folder for PhotoTrack in Elvis,
outside the photo folders — e.g. `/PhotoTrack`. One site presses **Share**
with a name like `/PhotoTrack/Gala 2026.ptdelta`; every other site presses
**Show shared projects** and **Join**. Two items appear in that folder per
shoot:

- `Gala 2026.ptdelta` — every shot's status, who did what and when, every
  comment. A few kilobytes per shot. A site checks in a new version only when
  it has something the file lacks, so idle sites never write; each change is
  a new *version* of the same file, kept in its history, not a new file.
- `Gala 2026.photos.ptdelta` — thumbnails of shots not in Elvis yet, so other
  sites can see what the selector picked. It only changes when photos are
  dropped in. Once a shot is linked, its picture comes from Elvis instead.

Both are ordinary delta files: File → Import changes opens them on any
machine, offline included.

**2. Shots linked by hand.** A linked shot follows its asset's preview. Each
sync asks Elvis — by id, for the linked assets only — whether a new version
was checked in, and fetches the new preview if so. A linked asset that's
deleted in Elvis is flagged on the shot; its last picture stays.

Sync runs every minute (adjustable), a few seconds after each change, and on
**Sync now**. If the network drops, nothing is lost — changes stay here and go
out on the next sync. Two sites checking in at the same second: the later
version briefly lacks the earlier one's change, and that site checks it in
again on its next sync.

Credentials are stored only in the desktop app's own encrypted config — never
in a project file, a delta, or the shared file. Requests go through macOS's
own network stack, so a company HTTPS certificate works once its root is
trusted in Keychain Access, and the system proxy is honoured. Each login takes
one of the server's API licences, so the session is reused.

## Keyboard shortcuts

`⌘Z` / `⇧⌘Z` undo/redo (a burst of typing undoes as one step) · `⌘S` save,
`⇧⌘S` save as · `N` new shot · `Esc` close the shot panel · with a shot open,
`1`–`5` toggle its stages in order — on its magazine track, or its only track;
`⇧1`–`⇧5` for the press-release track of a shot in both.

## Before pushing

```bash
npm run typecheck && npm run build && npm test
```

`npm test` runs the logic tests (migration, the longshot rule, undo, comments,
delta merge, and three sites syncing through a simulated Elvis) and the Elvis
protocol tests against a strict mock server.

## Known gaps

- **Not yet run against your Elvis server.** Linking, previews, the shared
  file and two app instances coordinating were tested against a strict mock
  server and over Electron's own network stack; the first real run is the
  real test.
- **Dropped photos aren't uploaded to Elvis.** The retoucher puts the file in
  Elvis; PhotoTrack only links to it.
- **Comments can't be edited or deleted** once posted — that's what keeps
  merging threads between sites simple and safe. Resolve instead.
- **Per-field newest-wins, not a full CRDT.** Two people changing the same
  field of the same shot at the same moment resolve to one winner.
- **Native Apple Silicon, universal, and `.dmg` builds need a Mac to build
  on** — `lipo`, `codesign`, `hdiutil`. The x64 build runs on Apple Silicon
  under Rosetta 2 meanwhile; signing needs an Apple Developer ID either way.
