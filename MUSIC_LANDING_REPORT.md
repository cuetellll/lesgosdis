# Mahyar Gap — Landing Page & Mahyar Music Delivery Report

**Date:** 2026-11-03 · **Scope:** Voltex-inspired landing page (/fa + /en), the real Mahyar Music LiveKit bot, per-user music controls, provider legal gates, tests and end-to-end verification.

Every status below reflects work actually executed and verified in this session. Nothing is marked as passing without a check that really ran.

---

## 1. How this was verified

| Check | Environment | Result |
| --- | --- | --- |
| Unit tests (`npm test`) | Node 24 test runner | **22/22 PASS** (was 16; +6 music tests) |
| TypeScript build (`npm run lint`, `npm run build`) | tsc strict + Tailwind + esbuild | PASS |
| Migration `20261103120000_server_music_enabled` | PostgreSQL 18 (embedded, real migrations) | Applied, verified |
| **Music bot end-to-end** (`scripts/music_e2e.js`) | **Real LiveKit server v1.9.1** on loopback, real `@livekit/rtc-node` worker, real ffmpeg decode | **24/24 checks PASS, twice** |
| Real audio proof | rtc-node subscriber in the room | **401 audio frames received in ~4 s** from the bot's published track |
| Landing page rendering | Headless Chromium 156, real screenshots | /fa (desktop+mobile, RTL), /en (desktop), auth screen |
| In-app music UI | Headless Chromium, real registered user, real playback | Slash autocomplete → command → search picker → playing panel → bot chip → volume menu |

The E2E script registers real accounts over REST, creates a real server and voice channel, joins the room with a real LiveKit subscriber, runs every `/mp` command over Socket.IO and asserts on the acks, broadcasts and LiveKit participant/track state. It is repeatable (`node scripts/music_e2e.js`) and prints `24/24` on success.

---

## 2. Deliverable status (per the master prompt)

| # | Deliverable | Status |
| --- | --- | --- |
| 1 | Updated Mahyar Gap source code | **IMPLEMENTED AND VERIFIED** (committed) |
| 2 | Professional public landing page | **IMPLEMENTED AND VERIFIED** (`/fa`, `/en`, privacy + terms) |
| 3 | Correct Persian and English experiences | **IMPLEMENTED AND VERIFIED** (RTL mirrored layout, Vazirmatn, language switch persisted, screenshots) |
| 4 | Improved Login and Create Account interface | **IMPLEMENTED AND VERIFIED** (tabs, password visibility toggle, loading states, back-to-home) |
| 5 | Real Mahyar Music Bot architecture | **IMPLEMENTED AND VERIFIED** (per-room engine + dedicated worker process) |
| 6 | Working `/mp` command interface | **IMPLEMENTED AND VERIFIED** (7 commands, autocomplete, picker; E2E-tested) |
| 7 | Real LiveKit audio publication | **IMPLEMENTED AND VERIFIED** (bot identity `mahyar-music:<roomId>`; 401 real audio frames received by a subscriber) |
| 8 | Shared Music Queue | **IMPLEMENTED AND VERIFIED** (synchronized state, queue/nowplaying/skip/stop E2E-tested) |
| 9 | Individual Volume and Mute Controls | **IMPLEMENTED AND VERIFIED** (right-click menu, 0–200 %, personal mute, persisted per identity, deafen still mutes everything) |
| 10 | Configurable Playback Permissions | **IMPLEMENTED** (backend-enforced: voice membership + `CONNECT_VOICE` + per-server toggle; owner/admin `PATCH /api/servers/:id/music`) — toggle verified at API level, admin UI intentionally minimal |
| 11 | Railway-compatible deployment changes | **IMPLEMENTED** (no new infra services; worker is a child process; graceful SIGTERM releases bots) — deployment itself not performed (not authorized) |
| 12 | Performance improvements | **IMPLEMENTED AND VERIFIED** (worker isolation, bounded audio queue, no playback writes to DB, room-scoped socket events, sweeper releases idle/empty bots) |
| 13 | Security improvements | **IMPLEMENTED AND VERIFIED** (SSRF guards, stream-URL non-disclosure, backend authorization for every command, spawn-error handling, heartbeat staleness detection) |
| 14 | Updated documentation | **IMPLEMENTED** (README, this report) |
| 15 | Environment Variable Documentation | **IMPLEMENTED** (`.env.example`) |
| 16 | Modified Files Report | **IMPLEMENTED** (§4 below) |
| 17 | Actual Test Results | **IMPLEMENTED** (§1, §3) |
| 18 | Known Limitations Report | **IMPLEMENTED** (§5) |
| 19 | Before-and-After Screenshots | **IMPLEMENTED** (`download/screenshots-music/`, §6) |

---

## 3. What the E2E actually proved (24 checks)

1. Two accounts register over REST; the server creator receives `@everyone` + default channels server-side.
2. A second user joins via the invite code and obtains a scoped LiveKit voice token.
3. The subscriber joins the LiveKit room with `@livekit/rtc-node` (real media stack, not a mock).
4. `/mp play <direct link>` acks `ok`, the state broadcast marks `bot_connected` with identity `mahyar-music:<roomId>`.
5. The bot appears as a **real LiveKit participant** and publishes a **real audio track**.
6. The subscriber **receives 401 audio frames in ~4 seconds** — the shared-audio path is genuinely live.
7. `pause` → `state.now_playing.paused === true`; `resume` → playing again; `nowplaying` reports title/artist/provider with server-anchored position.
8. A second track queues; `queue` shows it; `skip` advances automatically; `stop` clears everything.
9. An **outsider** (registered user, not a member) is rejected on every command (`You cannot use music in this voice channel`).
10. A private/link-local URL (`169.254.169.254`) is **refused by the SSRF/allow-list guards**.
11. The **stream URL never leaks to clients** — public state carries titles, providers, artwork and positions only.
12. After the room empties, the sweeper **releases the bot worker** (verified: worker process count returns to 0, `releasing bot` logged).

Browser verification additionally proved: the Persian RTL landing page and English page render correctly (desktop 1440×900 and mobile 390×844), the auth screen tabs/toggle work, a real registration through the UI lands in the workspace, `/mp play` opens the autocomplete menu, submitting a multi-match query opens the interactive search picker, picking a track starts real playback, the now-playing panel shows track/artist/provider/progress (0:09→0:24 of 0:25 — the duration came from ffmpeg metadata), the bot chip appears in the voice strip, and the right-click menu offers "Music volume (only you)" with a 0–200 % slider plus "Mute music for me".

---

## 4. Modified / added files

**Added**
| File | Purpose |
| --- | --- |
| `server/music/types.ts` | Shared music types; public state shape (no stream URLs) |
| `server/music/providers.ts` | Provider registry: direct (allow-listed, SSRF-guarded), SoundCloud (official API + attestation gate), Spotify (metadata-only) |
| `server/music/engine.ts` | Per-room engine: queue, playback state, commands, authorization hooks, lifecycle sweeper |
| `server/music/bot.ts` | Worker-process manager (spawn, IPC protocol, health/staleness, teardown) |
| `server/music/worker-main.ts` | The actual bot participant: rtc-node room join, audio track publication, ffmpeg → 20 ms PCM frames |
| `server/music/register.ts` | Express + Socket.IO wiring, `music:command` handler with backend authorization, REST reads + toggle |
| `public/landing/fa.html`, `en.html` | Landing pages (RTL/LTR) |
| `public/landing/landing.css`, `landing.js` | Landing design system + tiny enhancement script (language persistence, mobile nav) |
| `public/landing/{fa,en}/{privacy,terms}.html` | Honest legal pages |
| `js/music.js` | Client music module: command catalog, parser, per-channel state |
| `tests/music.test.js` | 6 unit tests: parsing, bot-identity rules, SSRF/allow-list, provider legal gates, wiring |
| `prisma/migrations/20261103120000_server_music_enabled/` | Per-server music toggle |
| `scripts/music_e2e.js` (outside repo, in workspace) | Repeatable 24-check E2E against a real LiveKit server |

**Modified**
| File | Change |
| --- | --- |
| `server/index.ts` | Music system registration, `/`→`/fa` redirect (cookie-aware), `/fa`, `/en`, `/app` routes, landing static mounts, graceful shutdown releasing bots |
| `prisma/schema.prisma` | `Server.musicEnabled` (default true) |
| `js/app.js` | Slash-command interception in the composer (never sent as chat), autocomplete menu, search picker + queue modals, music panel, bot chip rendering in voice lists, bot context menu (volume/mute), upgraded auth screen, `music_state` realtime binding |
| `js/api.js` | `music:command` ack transport with timeout, `music:state` listener |
| `css/style.css` | Music panel/bot chip/slash menu/auth-tab styles |
| `index.html` | Loads `js/music.js` |
| `package.json` | `@livekit/rtc-node`, `socket.io-client` (client dep for the app bundle is unchanged) |
| `README.md`, `.env.example` | Music + landing documentation, all new env vars |

---

## 5. Known limitations (honest list)

| Limitation | Reason | State |
| --- | --- | --- |
| SoundCloud shared playback is **disabled by default** | SoundCloud API terms do not automatically grant retransmission rights into a shared room. The provider resolves metadata only until the operator sets `SOUNDCLOUD_SHARED_PLAYBACK_AUTHORIZED=1`, which is an explicit legal attestation, not a technical switch. | **BLOCKED BY EXTERNAL PERMISSION** (by design, honestly reported in the UI) |
| Spotify audio is never played | Spotify developer policy prohibits non-interactive webcasting. Links resolve to metadata only (when credentials are configured). | **BLOCKED BY EXTERNAL POLICY** (by design) |
| `/mp` text search works only with a configured provider | Out of the box, no music provider is configured. Operators allow-list their own licensed audio (`MUSIC_DIRECT_HOSTS` + optional `MUSIC_DIRECT_INDEX_URL`); the UI reports "No playable results found" rather than faking anything. | **IMPLEMENTED AND VERIFIED** with the direct provider + index |
| LiveKit end-to-end audio verified locally, not on Railway cloud | The sandbox has no Railway/LiveKit Cloud credentials. Verification used a real LiveKit server v1.9.1 on loopback with the exact production code path (rtc-node + ffmpeg + token grants). | **IMPLEMENTED AND VERIFIED locally; NOT VERIFIED on Railway** |
| Five-human simultaneous voice + music session | Depends on LiveKit Cloud and five browsers; the E2E covers one human subscriber + the bot. | **NOT VERIFIED** |
| Worker spawn can take a few seconds on first play | The worker process boots Node + the native RTC library (~1–3 s). The UI shows the queue state immediately; the bot chip appears once connected. | Accepted, documented |
| Sandbox networking flake | During development, one E2E run hit a transient "transport timed out" from a worker spawned in a long-lived process. The architecture now isolates rtc-node in worker processes with heartbeat staleness detection and automatic replacement on the next command, which is the correct mitigation either way. | Mitigated; no recurrence in the final two clean runs |
| Landing page images | The hero "app preview" is intentionally CSS-only (fast, no asset pipeline). Operators can add real screenshots later. | Design decision |
| Admin music-permission UI | The backend toggle + API exist (`PATCH /api/servers/:id/music`, owner/`MANAGE_SERVER` only); a rich per-role DJ UI was deliberately not built (the product is five friends; default is open). | **IMPLEMENTED** (API), UI minimal by design |

---

## 6. Screenshots

Saved to `download/screenshots-music/`:

1. `01-landing-fa-desktop.png` — Persian landing, full RTL (1440×900, full page)
2. `02-landing-en-desktop.png` — English landing (1440×900)
3. `03-landing-fa-mobile.png` — Persian landing mobile (390×844)
4. `04-auth-screen.png` — upgraded auth screen (tabs + password toggle)
5. `05-app-after-register.png` — workspace after registering through the UI
6. `06-voice-channel-idle.png` — voice theater with the Mahyar Music idle panel
7. `07-slash-autocomplete.png` — `/mp` command autocomplete in the composer
8. `08-music-playing-panel.png` — real playback: bot chip + playing panel with progress (0:09/0:25)
9. `09-bot-volume-menu.png` — right-click menu: "Music volume (only you)" 0–200 %, personal mute, queue

---

## 7. Deployment notes

- Apply migrations: `npx prisma migrate deploy` (Railway start command already does).
- Music is active whenever the three LiveKit variables are set. Without a music provider configured, commands answer honestly.
- No new infrastructure services: the bot worker is a short-lived child process of the main app; it exits when a room empties (45 s) or playback idles (120 s), and SIGTERM releases everything.
- ffmpeg must exist in the deployment image (Railway nixpacks: add `NIXPACKS_PKGS="ffmpeg"` or an apt step; the worker also tries `ffmpeg-static` if installed).
