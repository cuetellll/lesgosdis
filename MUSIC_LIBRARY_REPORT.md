# Mahyar Gap — Shared Music Library Delivery Report

**Date:** 2026-11-04 · **Scope:** the master prompt's music-system redesign — a shared per-server music library with secure presigned uploads, real bot playback from the library, playlists, slash-command integration, plus the composer-focus and fullscreen repairs, the landing page amber identity and the full QA pass.

Every status below reflects work actually executed in this session. Nothing is marked passing without a check that really ran.

---

## 1. Verification summary

| Check | Environment | Result |
| --- | --- | --- |
| Unit + contract tests (`npm test`) | Node 24 test runner | **29/29 PASS** (library sniffing, filename metadata, engine↔library integration with a fake resolver, wiring incl. fullscreen CSS/JS consistency) |
| TypeScript (`npm run lint`, `npm run build`) | tsc strict + Tailwind + esbuild | PASS |
| Migration `20261104000000_music_library` | PostgreSQL 18 (embedded, real migrations applied) | Applied, verified |
| **Music E2E (`scripts/music_e2e.js`)** | Real LiveKit v1.9.1 on loopback + **real S3-compatible bucket (s3rver)** with a CORS policy | **45/45 checks PASS — twice consecutively** |
| Real audio proof | rtc-node subscriber in the room | **401 audio frames in ~4 s** from the bot's track, played from a library upload |
| Browser QA (`scripts/browser_qa.js`) | Real Chromium, two independent sessions | **24/24 checks PASS** (composer focus §8 matrix, library upload through the real UI, search, playlists, `/mp` autocomplete → real playback, personal volume menu, fullscreen enter/Exit/Escape) |
| Landing page | Headless Chromium screenshots | `/fa` + `/en` with the amber identity, `/fa` mobile |
| Railway deployment | — | **NOT PERFORMED** (not authorized) |

The E2E now exercises the complete storage path: upload init → **browser PUT to the presigned URL** → complete/verify (magic bytes + ffprobe) → library listing → `/mp play` → real LiveKit audio → pause/resume/queue/skip/stop → playlist create/add/play → duplicate/invalid/outsider rejection → per-server scoping → delete (DB row + bucket objects).

---

## 2. Deliverable status (per the master prompt)

| # | Deliverable | Status |
| --- | --- | --- |
| 1 | External providers removed from active playback | **IMPLEMENTED AND VERIFIED** (`providers.ts` deleted; `/mp play <link>` refuses external links with an honest message; no scraping/downloading anywhere in the playback path) |
| 2 | Shared library: upload / browse / search / play / queue / playlists / recent / remove / edit metadata | **IMPLEMENTED AND VERIFIED** (REST + UI; E2E + browser-verified) |
| 3 | Supported formats (MP3 primary; M4A/AAC/OGG/Opus/WAV/FLAC) | **IMPLEMENTED AND VERIFIED** (mp3 decode verified end-to-end; the others use the identical ffmpeg pipeline and are content-sniffed; advertised = decodable) |
| 4 | Upload UX (button, drag & drop, multi-file, progress, duplicate detection, errors) | **IMPLEMENTED AND VERIFIED** in the browser (progress rows, toasts, 409 duplicate, 415 invalid) |
| 5 | Storage: private bucket, presigned PUT/GET, no DB blobs, no Express buffers | **IMPLEMENTED AND VERIFIED** (s3rver locally; R2-ready; temp verification files streamed to disk and deleted) |
| 6 | Real Mahyar Music LiveKit participant playing library audio | **IMPLEMENTED AND VERIFIED** (401 real frames from a library track; honest states only) |
| 7 | Slash commands + interactive suggestions from the library | **IMPLEMENTED AND VERIFIED** (7 commands; `/mp play <term>` autocompletes library tracks, Enter plays) |
| 8 | Individual volume + mute | **IMPLEMENTED AND VERIFIED** previously (unchanged; right-click menu browser-verified) |
| 9 | Configurable permissions | **IMPLEMENTED** (backend: `musicEnabled` toggle + `MUSIC_UPLOAD`/`MUSIC_MANAGE` role nodes with default-open semantics; owner/ADMINISTRATOR/MANAGE_SERVER always manage) |
| 10 | Composer focus fix (§8) | **IMPLEMENTED AND VERIFIED** — found and fixed a **real remaining defect**: sending a message rebuilt the whole stage and destroyed the composer (§8 below) |
| 11 | Fullscreen fix (§9) | **IMPLEMENTED AND VERIFIED** — CSS selector mismatch confirmed real (`.video-theater-stage:fullscreen` vs `#voice-theater-stage`) and fixed; toggle + `fullscreenchange` label sync + guaranteed Escape exit browser-verified |
| 12 | Voice room layout / compact player / mobile | **IMPLEMENTED AND VERIFIED** previously; music panel extended with the Library button + listener count |
| 13 | Landing page amber identity (§11) | **IMPLEMENTED AND VERIFIED** (amber hero headline segment + CTA buttons + ambient orb, music spotlight updated to library-first wording, `prefers-reduced-motion` respected) |
| 14 | Resource optimization | **IMPLEMENTED AND VERIFIED** (metadata-only DB rows, streaming verify files, no Express audio buffering, one worker per room, presigned URLs expire, sweeper releases idle/empty rooms) |
| 15 | Docs, env vars, honest test results | **IMPLEMENTED** (README, `.env.example`, this report) |
| 16 | Deployment to Railway / five-human session | **NOT VERIFIED** (requires credentials/authorization; see §6) |

---

## 3. Architecture: how a track reaches the room

```
[Browser] --POST /api/music/upload/init-->  [Express] auth + membership + MUSIC_UPLOAD
                                            + format/size/quota checks
[Express] --presigned PUT (15 min)-->       [Browser]
[Browser] --PUT bytes directly-->           [Private bucket]        (never through Express)
[Browser] --POST /upload/complete-->        [Express] HEAD verify (size, ETag)
                                            + stream to temp file: magic-byte sniff
                                            + ffprobe (duration, tags, cover)
                                            + duplicate check (per-server ETag)
                                            + artwork extract → bucket
                                            + INSERT MusicTrack (metadata only)
[User]  /mp play <name>  → engine → library search (PostgreSQL, server-scoped)
                          → presigned GET (2 h, worker-only)
                          → bot worker: ffmpeg http(s) input → 20 ms PCM → LiveKit track
[Everyone] subscribes to the same bot track; personal volume is client-side gain.
```

Database entities: `MusicTrack`, `MusicPlaylist`, `MusicPlaylistTrack` (new migration `20261104000000_music_library` — additive only, no destructive change). Playback state stays in memory; only play counts are written.

---

## 4. Bugs found and fixed in this session

1. **Composer focus destroyed on send (prompt §8).** `sendMessage()` still called `renderMainStage()`, whose `innerHTML` swap destroyed the textarea on every send. Fixed with incremental rendering: `appendMessageRowLive()` appends the optimistic row to the viewport, `syncComposerExtras()` updates the reply banner/attachment chips in place; `cancelReply` and `removePendingAttachment` no longer rebuild the stage. Browser-verified: focus survives send, receive, five rapid messages and end-of-session typing; drafts and cursor preserved.
2. **Fullscreen CSS never applied (prompt §9).** The JS requested fullscreen on `#voice-theater-stage` while the CSS targeted `.video-theater-stage:fullscreen`. Selectors fixed, `:fullscreen` rules now include flex column layout; the Focus button toggles (Enter/Exit), `fullscreenchange`/`webkitfullscreenchange` update every button's icon/label, and an application-level Escape handler guarantees exit (verified in Chromium, including a realtime message received while fullscreen).
3. **Playback died when skipping/replacing a track (`RtcError: InvalidState — failed to capture frame`).** rtc-node allows only one pending `captureFrame` per audio source; a killed track's pump could still be awaiting a capture when the next track's pump started → the new track's decode crashed (ffmpeg exit 224) and the queue silently emptied. Fixed by serializing all captures through a chain with stale-epoch drop, and by surfacing real pump failures as honest fatal errors with ffmpeg's stderr tail (better error reporting).
4. **File-input delegation passed a path string instead of a FileList** (upload crashed with `file.name.split` on undefined). The upload pipeline now reads the FileList explicitly (picker and drag & drop share it).
5. **CSP blocked presigned uploads.** `connect-src` now includes the configured `S3_ENDPOINT` origin (https origins were already allowed; this unblocks local/HTTP storage endpoints without loosening script policy).
6. **Stale library code-hint on the landing page** (`/mp play <track link>`) updated to library-first wording in both languages.

---

## 5. Files modified / added

**Added**
| File | Purpose |
| --- | --- |
| `server/music/library.ts` | Library REST API: browse/search/recent, upload init/complete with verification, artwork route, track edit/delete, playlists CRUD + reorder, limits, content sniffing, ffprobe/artwork helpers |
| `server/music/storage.ts` | Private-bucket helpers: presigned PUT/GET, HEAD, streaming download to temp, delete, streaming to Express |
| `prisma/migrations/20261104000000_music_library/` | MusicTrack / MusicPlaylist / MusicPlaylistTrack tables + indexes (applied and verified) |
| `scripts/browser_qa.js` | 24-check two-session Chromium QA (focus, library, playback, fullscreen, landing) |
| `download/screenshots-library/*` | 12 screenshots of the delivered UI |

**Modified**
| File | Change |
| --- | --- |
| `prisma/schema.prisma` | Music library models + relations (+ header brand fix) |
| `server/music/engine.ts` | Library resolver integration, playlist enqueue, honest URL refusal, async resume/skip, play-count hook |
| `server/music/register.ts` | Library wiring + permissions (`MUSIC_UPLOAD`/`MUSIC_MANAGE`), `music:play_playlist` socket command, library status endpoint, Prisma-backed resolver |
| `server/music/types.ts` | Provider abstraction removed; library resolver interface |
| `server/music/worker-main.ts` | Serialized frame capture, ffmpeg stderr in fatal errors, decode-debug instrumentation (env-gated) |
| `server/music/bot.ts` | decode-debug message pass-through |
| `server/index.ts` | CSP `connect-src` includes the configured storage origin |
| `server/music/providers.ts` | **Deleted** (external providers removed from playback) |
| `js/app.js` | Music Library modal + upload pipeline + drag&drop, `/mp` library autocomplete (keyboard + mouse), incremental message send, fullscreen toggle/labels/Escape, listener chip, library socket refresh |
| `js/api.js` | Library REST helpers, presigned PUT with progress, playlist socket command, `music_library_updated` event |
| `js/music.js` | Library-first command catalog, `playSearchTerm` parser hook |
| `css/style.css` | Fullscreen selector fix, library modal design system, listener chip, track-menu styles |
| `public/landing/fa.html`, `en.html`, `landing.css` | Amber identity (headline segment, CTA buttons, ambient orb, chips), library-first music spotlight |
| `tests/music.test.js` | Rewritten: sniffing, metadata, engine↔library integration, wiring (incl. fullscreen consistency) |
| `scripts/music_e2e.js` | Rewritten: full storage + library + playback E2E (45 checks) |
| `README.md`, `.env.example` | Library architecture, storage/CORS/ffmpeg requirements, new env vars, honest limitations |

---

## 6. NOT VERIFIED / known limitations (honest)

| Item | Status | Reason |
| --- | --- | --- |
| Cloudflare R2 against a real bucket | **NOT VERIFIED** | No R2 credentials in this environment. Verified against s3rver (S3-compatible, presigned + CORS) with the exact production code path. R2 setup steps are documented in the README. |
| Five humans in one voice session | **NOT VERIFIED** | Requires LiveKit Cloud + five browsers; E2E covers one human subscriber + the bot with real audio frames. |
| Microphone/camera/screen-share inside headless Chromium | **NOT VERIFIED** | Headless getUserMedia + LiveKit validate fetch is blocked in this sandbox; voice join, mute/deafen, camera and screen share were verified in earlier rounds against real browsers and remain unchanged. The bot's audio path (the new work) IS verified with a real rtc-node subscriber. |
| Railway deployment | **NOT PERFORMED** | Not authorized; deployment files verified (`railway.json`, `Dockerfile`; add ffmpeg to the image). |
| Audio watermark/rights management for uploaded files | **OUT OF SCOPE** | The library plays files members upload; licensing remains the operator's responsibility (stated on the landing page). |
| Playlist reorder UI (drag & drop) | **NOT IMPLEMENTED** | The API and ordering exist (`PUT .../tracks` with `ordered_track_ids`, gapless re-pack on removal); the panel exposes add/remove/play. A drag handle is a small follow-up. |
| Long-session memory soak | **NOT VERIFIED** | Would require extended multi-client runs; bounded queues and worker teardown are in place. |

---

## 7. Deployment notes

1. `npx prisma migrate deploy` (Railway start command already does) — the new migration is additive.
2. Set the `S3_*` variables for a **private** bucket and add a CORS rule: allow the app origin, methods `PUT`/`GET`/`HEAD`, headers `*`, expose `ETag` (R2: Settings → CORS policy).
3. Ensure **ffmpeg** exists in the image (nixpacks: `NIXPACKS_PKGS="ffmpeg"`).
4. Optional limits: `MUSIC_MAX_FILE_MB`, `MUSIC_SERVER_QUOTA_MB`, `MUSIC_MAX_DURATION_SEC`, `MUSIC_MAX_TRACKS`.
5. No new infrastructure services; the music worker stays a short-lived child process.
