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

1. **Bring in the shoot** — pull it from WoodWing Elvis (photos, filenames and
   folders come with it), or drop photos anywhere on the Shots tab.
2. **Set where each shot runs** — Magazine, Press release, or Both — and its
   shot type. A longshot skips assembly, submission and approval; those three
   stages are hidden for it and left out of every count.
3. **Work the tracks** — check stages off in the shot's panel or on the sheet;
   assign retoucher per property.
4. **Discuss on the shot** — concerns and notes, replies, resolve.
5. **Stay in step** — Elvis sync keeps every site current automatically; delta
   files do the same by hand where there's no network.

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

## WoodWing Elvis sync

Desktop app only (a browser page can't log in to a DAM). Open it from the
**Connect Elvis** chip in the top bar:

1. **Connect** — the server address you use in a browser, and the username and
   password PhotoTrack should sign in with. **Test connection** walks address →
   log in → search and, if a step fails, says which, the URL tried, and what
   that error usually means.
2. **Which assets** — an Elvis query, usually the shoot's folder, e.g.
   `ancestorPaths:"/Shoots/2026/Gala"`. Every matching asset becomes a shot:
   its preview, filename (→ shot number) and folder come with it, and new
   assets appear on each sync.
3. **Where the tracking is shared** — the photos are only ever read. The
   shared state (both tracks, who/when for every stage, every comment) lives
   in one of two places:
   - **One shared file** (the default, nothing for an administrator to set
     up). Make a folder in Elvis outside the shoot's photo folders, e.g.
     `/PhotoTrack`, and give every site the same path, e.g.
     `/PhotoTrack/Gala 2026.ptdelta`. The first sync creates the file; after
     that each site downloads it, merges, and checks in a **new version of
     the same file** only when it has something the file lacks. It shows up
     in Elvis as one asset per shoot — the versions live in its history, not
     in search results. It's an ordinary delta file, so File → Import changes
     opens it on any machine, offline included.
   - **A field on every photo** — a multi-line text custom field (e.g.
     `cf_photoTrack`) an administrator creates, holding each shot's record.
4. **Plain fields** (optional) — the only thing PhotoTrack would ever write
   to the photos, and only if you fill them in. For people looking at assets
   in Elvis itself:
   usage, spread/slide, retouchers, and a written status per property
   ("Waiting on QC"). After **Test connection** these boxes list the fields
   your assets actually have, with an example value each.
5. **Sync** — **Pull this shoot** links the open project to the query. From
   then on it syncs every minute (adjustable) and a few seconds after each
   change; the top-bar chip always shows when it last synced. If the network
   drops, nothing is lost — changes stay here and go out on the next sync.

Each login takes one of the server's API licences, so the session is reused.
Credentials are stored only in the desktop app's own encrypted config — never
in a project file, a delta, or the Elvis record. Requests go through macOS's
own network stack, so a company HTTPS certificate works once its root is
trusted in Keychain Access, and the system proxy is honoured.

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

- **Not yet run against your Elvis server.** The protocol, the shared file,
  the record field, and two app instances coordinating were all tested
  against a strict mock server and over Electron's own network stack; the
  first real run is the real test.
- **Two sites checking in the shared file in the same second** — the later
  version briefly lacks the earlier one's change; that site notices on its
  next sync and checks it in again, so it arrives a minute late, never lost.
- **Shots added by dropping photos aren't uploaded to Elvis.** Sync covers
  shots pulled from Elvis; a dropped photo links to an asset only if its shot
  number matches that asset's filename.
- **Comments can't be edited or deleted** once posted — that's what keeps
  merging threads between sites simple and safe. Resolve instead.
- **Per-field newest-wins, not a full CRDT.** Two people changing the same
  field of the same shot at the same moment resolve to one winner.
- **Native Apple Silicon, universal, and `.dmg` builds need a Mac to build
  on** — `lipo`, `codesign`, `hdiutil`. The x64 build runs on Apple Silicon
  under Rosetta 2 meanwhile; signing needs an Apple Developer ID either way.
