# PhotoTrack

A photo production tracker for a shoot's line: every frame, where it's
running (magazine, press release, or both), who's retouching it, and where it
stands in the pipeline — retouched → QC → assembled → submitted → approved.
The deliverable is the same one a production desk already runs off: a printed
tracker sheet, plus a shared, current picture of the whole shoot's status.

Built to replace a single self-contained HTML tool that worked until a real
shoot's worth of photos went into it — it saved everything to `localStorage`
as inline base64, which has about a 5MB budget total. One or two full-size
photos and every save afterward failed silently. See "What changed" below.

## The workflow

1. **Drop photos onto the grid.** Anywhere on the contact-sheet view — a
   whole folder at once — creates one row per photo, guesses its shot number
   from the filename, and keeps going even with hundreds of images queued.
2. **Set usage and shot type** on each shot: Magazine, Press Release, or
   Both; Longshot or Close-up. A longshot skips assembly, submission, and
   approval — those three stages only apply to a select that runs in a
   layout.
3. **Track it through the pipeline** — click a tile to open its detail panel,
   or work down the printable sheet — retoucher assignment and the five
   pipeline toggles, independently for the magazine and press sides when a
   shot runs in both.
4. **Print or export** the tabloid sheet, or export a PDF from the desktop
   app.
5. **Hand off progress to another unit** with a delta file (see below) or,
   once it's configured, sync through WoodWing Elvis.

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

## Sharing progress between two units — delta files

`.ptdelta` files are how two units on the same shoot, each running PhotoTrack
independently, share progress without a server: **Export Delta** packages
everything changed since the last export (or the whole project the first
time); **Import Delta** merges it in field by field. Every field on every row
carries its own edit timestamp, so if one unit retouches a shot while the
other assigns its layout position, both edits land — neither side's row
clobbers the other's. Hand the file over on a USB stick, over email, however
is easiest; there's no server to run.

What this doesn't do: merge two *simultaneous* edits to the exact same field
(newest wins, tie-broken by which machine made the edit), and it doesn't sync
the show header field-by-field (the header is one small block with one
timestamp for all of it — whichever export touched it last wins as a whole).

## WoodWing Elvis sync

The **Elvis Sync…** panel (desktop app only — see the table above) is real,
working plumbing: it can search Elvis for assets, map custom metadata fields
onto rows through the exact same per-field merge a delta import uses, and
write pipeline/usage state back. What it does **not** ship with is a
confirmed connection to any specific server — the endpoint, the auth method,
the search/update paths, and every custom field name are settings, defaulted
to plausible guesses (the same ones the original tool hardcoded, never
verified against a real Elvis instance). Before it does anything against a
production DAM:

1. Get the base URL, and confirm with whoever administers Elvis whether the
   service account authenticates with an API key, HTTP Basic, or something
   else — Elvis versions differ here.
2. Confirm the actual custom-field names for usage placement, shot type,
   spread/slide number, and the five pipeline stages, and that the account
   can write them.
3. Use **Test connection** before **Pull now** — it does one bounded search
   and reports what came back, without touching any row.

Credentials are stored in a local config file the desktop app owns,
encrypted at rest with Electron's `safeStorage` (the OS keychain on macOS).
They are never written into a project file, a recovery file, or a delta.

## Keyboard shortcuts

`Cmd/Ctrl+Z` / `Shift+Z` undo/redo · `Cmd/Ctrl+S` save (`Shift` for Save As) ·
`N` add a shot · `1`–`5` toggle Retouched/QC/Assembled/Submitted/Approved on
whichever shot is open in the inspector, on every side its usage covers.

## Before pushing

```bash
npm run typecheck && npm run build
```

## Known gaps

- **Lane/board grouping in the grid.** The contact sheet is a flat, filtered
  grid of tiles today — dragging a shot into a "QC" or "by retoucher" lane to
  change its state is a natural next step, not yet built.
- **Elvis sync is unverified against a real server.** See above — it needs
  someone who administers the DAM to confirm endpoint, auth, and field names.
- **Delta merge is per-field last-write-wins, not a full CRDT.** Two units
  editing the exact same field on the exact same row at the same moment still
  resolves to one winner rather than a genuine three-way merge; that's an
  accepted simplification, not a bug to fix quietly later without saying so.
- **Native Apple Silicon, universal, and `.dmg` builds all need a Mac to
  build on** — `lipo`, `codesign`, and `hdiutil` respectively. See the table
  under "The two builds". The x64 build covers Apple Silicon via Rosetta 2 in
  the meantime, and proper signing needs an Apple Developer ID either way.
