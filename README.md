# Mahyar Gap

Mahyar Gap is a browser-based communication platform: an Express/TypeScript API, PostgreSQL persistence through Prisma, Socket.IO realtime events, and LiveKit SFU transport for voice, video and screen sharing. The interface uses an original violet/cyan identity and Discord-inspired interaction patterns, with locally compiled Tailwind and a first-party design system.

Visitors get a dedicated multilingual landing page (`/fa` Persian default with full RTL, `/en` English); the authenticated workspace lives at `/app`.

## What is implemented

- **Public landing page:** Voltex-inspired premium design in Persian (`/fa`, default, RTL with Vazirmatn) and English (`/en`), a CSS-only animated app preview, feature grid, Mahyar Music spotlight, FAQ, CTA band, honest footer (privacy + terms pages included), mobile navigation, and a language switch that persists the visitor's choice (cookie + localStorage, honored by `/`). No animation libraries, no autoplay media.
- **Accounts and profiles:** registration, login, bcrypt hashes, signed 7-day bearer tokens with transparent rotation (`POST /auth/refresh`), rate limits, profile editing (display name, bio, custom status, presence), and **avatar upload**. The upgraded auth screen has Login/Create account tabs, a password visibility toggle, honest loading states and clear errors. Avatars are cropped to 256x256 in the browser, validated server-side (MIME plus magic bytes, <=256 KB) and stored on the user row.
- **Text channels:** persistent messages, replies, edits, deletes, pins, threads, emoji reactions (now permitted for every participant, not just moderators), mentions, **server-side message search**, **server-side per-channel pagination with a `before` cursor**, unread indicators, optimistic sending with rollback, and per-channel **draft persistence**.
- **Composer:** auto-growing textarea with Shift+Enter for newlines, IME-safe Enter handling (Persian/CJK composition never sends), attachment picker with real upload progress, and honest failure states.
- **Realtime:** Socket.IO with authenticated handshakes, targeted `message:*`, `direct_message:*`, `voice:updated` (broadcast to server rooms, not just the open channel), `notification:new`, reconnect handling, typing indicators for channels and DMs, live presence, and **automatic voice-session cleanup when the last socket of a user disappears** (no ghost participants).
- **Voice/video:** server-issued LiveKit tokens scoped to one voice room with role-based publish grants. Real microphone, camera and screen-share tracks; speaking indicators; participant metadata; device pickers; fullscreen stage; reconnect with exponential backoff. Empty voice rooms say "Your voice room is ready. Invite your friends and start talking."
- **Per-participant audio controls:** right-click (or long-press) a voice participant for a 0-200% volume slider, "mute for me", profile, DM and copy-ID actions, applied through a Web Audio `GainNode` per remote participant and persisted in `localStorage`.
- **Direct messages and calls:** 1:1 (with symmetric conversation ids) and group DMs, **group renaming**, typing indicators, real LiveKit calls with an in-app incoming-call banner.
- **Servers, channels and moderation:** server creation (defaults created server-side: membership row, `@everyone` role, `general` + voice channels), invite links (**limited invites with usage counts, expiry and revocation**), channel creation/**editing**/deletion, **private channels enforced on the backend** (visibility, reads, writes, voice tokens, socket rooms), roles and permissions with owner-only escalation guards, kick, ban and audit records.
- **Notifications:** persisted notification rows for mentions, friend requests and incoming calls, a notification inbox, mark-all-read, and optional desktop notifications (permission requested only from the explicit toggle).
- **File attachments:** raw-byte upload endpoint (`POST /api/files/upload`) that streams to any S3-compatible bucket (Cloudflare R2 included) with MIME allowlist, 50 MB cap and safe keys. Without storage credentials the endpoint returns an explicit `501` and the UI says so - it never fakes a successful upload.
- **Appearance:** dark and light themes, reduced-motion preference, glassy menus, message hover toolbars, skeleton-free fast renders, and a responsive layout with a mobile navigation drawer and touch-friendly participant menus.
- **Mahyar Music — a real Discord-style music bot:** `Mahyar Music` joins the LiveKit voice room as its own participant and publishes ONE shared audio track. Architecture: per-room engine (queue, playback state, permissions) + a dedicated **worker process per room** (`dist/server/music/worker-main.js`) that owns the `@livekit/rtc-node` connection and an ffmpeg decoder (48 kHz stereo PCM streamed as 20 ms frames with bounded-queue backpressure). `/mp play|queue|pause|resume|skip|stop|nowplaying` with slash-command autocomplete, an interactive search-result picker, a shared synchronized queue, a now-playing panel (artwork, position, duration, next track), and a right-click context menu with a personal 0–200% music volume and personal mute (never affecting other listeners). Music permissions default to open for voice members and can be disabled per server by admins (`PATCH /api/servers/:id/music`). Providers are pluggable and **honest by design**: direct audio only from operator allow-listed hosts (SSRF-guarded), SoundCloud via the official API with an explicit shared-playback attestation gate, Spotify as metadata-only. No scraping, no DRM circumvention.
- **Build and deploy:** local Tailwind build, locally bundled LiveKit browser client, CSP-safe delegated event handling (no inline handlers), Dockerfile, Railway manifest, health endpoint, Prisma migrations (including `ChannelAccess` and the per-server music toggle), and a passing TypeScript build.

## Requirements

- Node.js 22.22.0 or newer and npm.
- PostgreSQL 13 or newer (Railway PostgreSQL works).
- A LiveKit project (WebSocket URL plus API key/secret) for voice, video, screen share and DM calls.
- (Optional) An S3-compatible bucket for file attachments.
- A secure origin (`https://`, or `localhost`) for microphone, camera and screen capture.

## Local setup

```bash
cp .env.example .env
# Set DATABASE_URL, JWT_ACCESS_SECRET and the three LiveKit variables.
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm test
npm start
```

Open `http://localhost:3000`. `npm run build` produces `css/tailwind.generated.css`, `public/vendor/livekit-client.js` and the compiled server in `dist/`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (Railway provides it). |
| `JWT_ACCESS_SECRET` | Random secret, 32+ characters; required in production. |
| `BCRYPT_ROUNDS` | Password hashing cost (default 12). |
| `LIVEKIT_URL` | LiveKit server origin (`wss://...`). |
| `LIVEKIT_API_KEY` | LiveKit server API key (server only). |
| `LIVEKIT_API_SECRET` | LiveKit server secret (server only). |
| `S3_ENDPOINT` | Optional. S3/R2 endpoint enabling file attachments. |
| `S3_REGION` | Optional. Defaults to `auto` (R2). |
| `S3_BUCKET` | Optional. Bucket receiving uploaded attachments. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Optional. Storage credentials (server only). |
| `S3_PUBLIC_BASE_URL` | Optional. Serve attachments from a CDN/base URL instead of proxying downloads. |
| `CORS_ORIGIN` | Optional exact public origin for cross-origin browser access. |
| `MUSIC_DIRECT_HOSTS` | Optional. Comma-separated allow-list of hosts the music bot may stream from; empty disables direct links. |
| `MUSIC_DIRECT_INDEX_URL` | Optional. JSON track index on an allow-listed host enabling `/mp` text search. |
| `MUSIC_ALLOW_PRIVATE_HOSTS` | Optional dev-only escape hatch (`1`) permitting private hosts; never for public deployments. |
| `SOUNDCLOUD_CLIENT_ID` / `SOUNDCLOUD_OAUTH_TOKEN` | Optional. Official SoundCloud API credentials for search/metadata. |
| `SOUNDCLOUD_SHARED_PLAYBACK_AUTHORIZED` | Optional. Set to `1` ONLY if your SoundCloud API agreement permits shared-room retransmission; otherwise metadata-only. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional. Spotify metadata resolution only (policy forbids group webcasting). |
| `MUSIC_MAX_QUEUE` | Optional. Max queued tracks per room (default 50). |
| `PORT` | Supplied by Railway; defaults to 3000. |

Secrets never reach browser JavaScript. LiveKit tokens are minted server-side per room.

## Push to GitHub

The repository stays small on purpose: `node_modules`, `dist/` and `.env` are ignored, so a fresh clone is small source only; everything generated is rebuilt on the server:

```bash
npm ci                 # install dependencies (also what Docker and CI run)
npx prisma generate    # Prisma client
npm run build          # Tailwind CSS, bundled LiveKit browser client, tsc
```

`.github/workflows/ci.yml` runs those checks on every push, and `.dockerignore` keeps the Docker build context small so Railway does not upload `node_modules` either.

1. Create an empty repository on GitHub (no README, no .gitignore - both already exist here).
2. Connect and push:

   ```bash
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```

Never commit `.env`; only `.env.example` is tracked.

## Deploy to Railway

1. Push this repository to GitHub, then create a Railway project from the repo. Railway uses the checked-in `Dockerfile` and `railway.json` (`npm ci` -> `prisma generate` -> `npm run build`).
2. Add a PostgreSQL service and confirm the web service receives `DATABASE_URL`.
3. Add the LiveKit variables, set `NODE_ENV=production`, and set a fresh `JWT_ACCESS_SECRET`.
4. (Optional) Add the `S3_*` variables to enable file attachments.
5. Deploy. The container runs `prisma migrate deploy` then starts the server on `$PORT`.
6. Wait for `/api/health` to return 200 (it checks database connectivity). This does not verify LiveKit media.
7. Verify with two authenticated browsers: register, upload avatars, create a server, exchange messages, join a voice room, test mute/deafen, right-click a participant and change their volume, run a DM call, then relaunch both browsers and confirm state.

## Known limitations (not hidden, not faked)

- **LiveKit voice/video requires credentials.** Without `LIVEKIT_*` variables the UI reports that the service is not configured instead of pretending to connect.
- **Attachment storage requires `S3_*` variables.** Without them the upload endpoint answers 501 and the composer explains why; nothing is simulated.
- **Avatars are small data URLs stored on the user row** (<=256 KB, validated). Moving them to object storage is recommended before large-scale use.
- **No email verification, password reset or MFA.** Access tokens rotate transparently for 7 days; `localStorage` tokens mean XSS prevention matters, and the CSP blocks inline and eval scripts.
- **Forum and announcement channels render with their own icons and descriptions but do not implement post/thread workflows.**
- **Internationalization (English/Persian with RTL)** was intentionally deferred in this pass to keep the change surface safe; all interface strings are currently English. The composer and text stack are Unicode-safe.
- **Single-instance Socket.IO.** No Redis adapter; multiple replicas would not share rooms. This matches the documented small-deployment target.
- **Notification delivery is in-app plus optional desktop notifications; there is no email/push delivery.**

## Tests

`npm test` runs the Node test suite covering the API client (auth header, 401 handling with transparent refresh, error metadata, scoped pagination parameters, attachment type/501 handling), the CSP-safe delegated action contract (every button has a wired action, allowlist matches methods, no inline handlers), the local Tailwind build, Prisma order-by fields, LiveKit grant construction, and source hygiene (no test identities, no infrastructure branding in the UI, backend endpoints present). `npm run lint` is a TypeScript check.

An end-to-end API suite (55 checks: registration, membership, scoped pagination, search, permissions, private channels, limited invites, notifications, DM group rename, attachment validation, avatar limits, session refresh) was executed against a live PostgreSQL instance; see `VERIFICATION_REPORT.md`.
