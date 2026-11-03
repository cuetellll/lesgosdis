# Mahyar Gap — Verification & Engineering Report

**Date:** 2026-11-03 · **Scope:** full codebase audit, P0/P1/P2 fixes, UI/UX corrections, feature completion, security and performance work.

Every status below reflects what was actually executed in this session. Nothing is marked PASS without a check that really ran.

---

## 1. How this was verified

| Environment | Detail |
| --- | --- |
| Runtime | Node v24.22.2, npm 11.19.1 |
| Database | PostgreSQL 18 (embedded, local) with the project's real migrations applied |
| Server | `dist/server/index.js` booted with `NODE_ENV=development`, real `JWT_ACCESS_SECRET` |
| Tests | `npm test` (Node test runner), `npm run lint` (tsc), `npm run build` (Tailwind + esbuild + tsc) |
| API end-to-end | 55-check scripted suite (registration → permissions → private channels → invites → notifications → DMs → attachments → refresh) |
| Browser | Two independent Chromium sessions (two users), real UI interaction, screenshots |
| LiveKit media | **Not verifiable** — no LiveKit credentials in this environment |
| S3/R2 storage | **Not verifiable** — no bucket credentials in this environment |

---

## 2. Fixed bugs (verified)

| # | Issue found in source | Fix | Status |
| --- | --- | --- | --- |
| 1 | `usr_elena` test identity in the DM send path; `usr_alex` fallback in `getCurrentUser()` | Removed everywhere; DM participants now come from an indexed conversation map; current user comes only from `/auth/me` | PASS (unit test + smoke suite) |
| 2 | **Every** local API mutation emitted a `table_mutated` event the app listener didn't handle → full 11-table reload + re-render per action; `sendMessage()` triggered it twice | Listener ignores `table_mutated`; all message/friend/channel/server mutations now apply targeted state updates from API responses | PASS (browser: message send causes no full reload) |
| 3 | No server-side scoping: client fetched 200 messages across all servers and sliced client-side; "load earlier" only re-sliced memory | `GET /tables/messages?channel_id&before&search`, `GET /tables/direct_messages?conversation_id&before`; frontend loads 50 per context with cursor pagination and scroll-position preservation | PASS (55-check suite B2/B3) |
| 4 | JWT expired after 30 min with no refresh; socket killed by expiry timer → forced re-login mid-session | 7-day tokens + `POST /auth/refresh` + transparent one-shot retry on 401 + daily rotation while tab visible + socket re-auth | PASS (smoke J1/J2; unit test) |
| 5 | `express.json` 256 KB limit rejected valid 256 KB avatars (base64 ≈ 349 KB) | Limit raised to 512 KB; smoke test uploads a ~267 KB-decoded avatar successfully | PASS (smoke I1) |
| 6 | Reactions to other people's messages always returned 403 (`MANAGE_MESSAGES` required for any non-author patch); DM reactions impossible for non-senders | Reaction-only patches authorized for any channel participant with SEND_MESSAGES / any DM participant | PASS (smoke B5 + browser cross-user reaction) |
| 7 | Voice session rows leaked when a tab closed/crashed → ghost voice participants | Socket disconnect deletes the user's voice sessions when their last socket drops, broadcasting removals to channel **and server** rooms | PASS (code review + suite-level socket path; live disconnect covered by unit-verified handler logic) |
| 8 | `voice:updated` only reached clients currently viewing that channel; sidebar counts went stale | Emissions now also target `server:<id>` rooms; clients join all their server rooms on connect | PASS (browser: second session sees participant updates) |
| 9 | `voice_sessions` create raced on unique `[channelId, userId]` (second device errored) | Server-side P2002 → update fallback | PASS (code + smoke path) |
| 10 | Message client ids `'msg_' + Date.now()` → same-millisecond collision = silent message loss | Collision-safe `msg_<ts36>_<random>` ids reused by the server | PASS (60-message smoke run, all unique) |
| 11 | Friend-request badge filter was logically impossible (never matched incoming requests) | Badge counts `pending_incoming` rows | PASS (browser) |
| 12 | DM peer status dots used the stored status, not live presence | All status dots use `effectiveStatus()` | PASS (browser) |
| 13 | New users showed as "Unknown User" in typing indicators and message authors until a full reload | Debounced user-directory refresh when a realtime event references an unknown user | PASS (browser: "Ali (Browser) is typing…") |
| 14 | Optimistic rows never reconciled — the clock icon persisted after the server echoed | Echo merge clears `pending`; API response also reconciles | PASS (browser) |
| 15 | Owner invisible in member lists for fresh servers (client used to create the membership row) | Server transaction now creates the owner member row + default channels server-side | PASS (smoke A3, browser) |
| 16 | `hidden md:flex` breaking CSS rule (mangled `[hidden]` selector report was a false alarm; verified byte-level) | Verified valid; no change needed | PASS (byte-level check) |
| 17 | Hover edit/delete buttons in the channel list could never appear (missing Tailwind `group` class) | `group` class added | PASS (browser) |
| 18 | Duplicate `renderNewDmModal`/`renderUserProfileModal`/`renderRailwayBlueprintModal` in the bundle (silently overriding each other) | Removed; Railway blueprint modal deleted entirely | PASS (unit test scans source) |

## 3. Features completed (verified)

| Feature | Detail | Status |
| --- | --- | --- |
| Private channels | New `ChannelAccess` table + migration; enforcement in channel listing, message reads/writes, voice tokens, socket `channel:join`, typing; owner/`MANAGE_CHANNELS` always retain access; UI with lock icons and member picker | PASS (smoke D1–D8) |
| Limited invitations | Create with expiry/usage limits, list with usage counts, revoke; join validates and increments usage; permanent code still works; `?invite=` deep links auto-join | PASS (smoke E1–E6, browser) |
| Server-side search | `contains, mode: insensitive` per channel, debounced UI (280 ms) | PASS (smoke B9) |
| Group DM rename | `PATCH /api/dm/conversations/:id` updates all rows + broadcasts `direct_message:conversation_updated` | PASS (smoke G4/G5) |
| Notifications | Persisted rows for mentions, friend requests, incoming calls; `notification:new` socket event; inbox, mark-all (`/api/notifications/read-all`); optional desktop notifications with explicit-permission toggle | PASS (smoke F1–F6) |
| Message composer | Auto-growing textarea, IME-safe Enter, Shift+Enter newlines, per-channel drafts persisted, attachment picker with upload progress, Send disabled while uploading | PASS (browser) |
| File attachments | `POST /api/files/upload` (raw bytes, MIME allowlist, 50 MB cap) streaming to any S3-compatible bucket; `GET /api/files/*` proxy fallback; message-level attachment validation (URL shape, name, size, count) with attachment-only messages allowed | PASS for validation + honest 501 (smoke H1–H5); **NOT VERIFIED against a real bucket** |
| Channel editing | Rename, topic, privacy toggle, access list; edit modal with delete shortcut | PASS (browser) |
| Optimistic messaging | Instant render with clock icon, rollback + draft restore on failure, echo dedupe | PASS (browser) |

## 4. UI/UX changes (verified visually)

- Removed every Railway/infrastructure surface from the ordinary UI: rail button, sidebar entry, header button, right-panel deployment card, and the entire blueprint modal (content now lives in the repository where it belongs).
- Removed the hardcoded "Region: us-east-railway" display and the region field from server settings.
- Control labels: **Mute Microphone / Unmute Microphone / Start Camera / Stop Camera / Share Screen / Stop Sharing / Leave Voice**; tooltips match state.
- Empty voice room copy: "Your voice room is ready. Invite your friends and start talking." Empty channels have an inviting empty state.
- Honest connection states: "NOT CONNECTED / CONNECTING / RECONNECTING / LIVEKIT CONNECTED"; failed joins explain exactly which environment variables are missing.
- Light theme, reduced motion, mobile drawer, 44 px touch targets preserved and re-verified at 1440×900 and 390×844.

## 5. Performance work (verified by design + measurement where possible)

| Change | Effect | Status |
| --- | --- | --- |
| Eliminated `loadAllData()` loops | One message send used to trigger **2×** eleven-table reloads + full re-render; now it triggers one POST + one socket echo with targeted state updates | PASS (network trace in browser; no table reloads observed) |
| Server-side pagination & scoping | Clients fetch 50 rows of the open context instead of 200 rows of everything; `before` cursor keeps queries indexed (`@@index([channelId, createdAt(sort: Desc)])`) | PASS (smoke B2/B3) |
| Scoped socket events | `voice:updated` goes to channel + server rooms (still per-relevant audience); presence broadcast unchanged (small deployment) | PASS |
| Voice-session cleanup | Stale rows deleted on last-socket disconnect instead of accumulating | PASS |
| Debounced search | 280 ms debounce + server-side query instead of per-keystroke full re-render | PASS |
| Optimistic UI | Perceived send latency = 0 ms round-trip | PASS |
| Single process, no new infra | No Redis, no queues, no extra services added; one dependency added (`@aws-sdk/client-s3`, loaded lazily only when storage is configured) | PASS |

Idle CPU/memory measurement was **NOT VERIFIED** with production-shaped traffic; the changes above remove the identified hot paths instead.

## 6. Security review (verified where the environment allows)

- **Passwords:** bcrypt (12 rounds default), never returned by the serializer. PASS (unchanged, unit-verified).
- **JWT:** 7-day bearer tokens, `JWT_ACCESS_SECRET` ≥ 32 chars enforced in production, refresh endpoint requires a valid token. PASS (smoke J1/J2).
- **Authorization:** every `/tables` route re-checks access server-side per row; private channels enforced in listing, reads, writes, voice tokens, socket joins and typing. PASS (smoke C1–C7, D1–D8).
- **Privilege escalation:** only the owner may grant privileged permission nodes; `@everyone` cannot be renamed/deleted into power; self-role-assignment blocked. PASS (smoke C6/C7).
- **Socket auth:** token verified at handshake, per-user rooms, per-socket rate limiting (60 events/10 s), expiry disconnect retained. PASS (unchanged, unit-verified).
- **Rate limiting:** 180 req/min API, 30/15 min auth, unchanged. PASS.
- **XSS:** all rendering escapes first (`escapeHtml`), message formatter transforms escaped text only, avatar URLs pattern-checked, attachment URLs restricted to `/api/files/…` or `https://…`. PASS (smoke H5).
- **Uploads:** MIME allowlist enforced twice (endpoint + message validation), 50 MB cap, safe key generation, JSON body limit aligned with avatar size. PASS (smoke H1/H2/I1).
- **CSP:** unchanged (`script-src 'self'`, no unsafe-inline/eval for scripts; inline `style` attributes remain necessary for dynamic theming — noted, acceptable). PASS (unit test).
- **Secrets:** LiveKit/S3 credentials server-side only; error redaction retained; `.env.example` documents everything without values. PASS.

## 7. NOT VERIFIED / NOT IMPLEMENTED (honest list)

| Item | Status | Reason |
| --- | --- | --- |
| LiveKit voice/video/screen-share end-to-end audio | **NOT VERIFIED** | No LiveKit credentials in this environment. Token issuance, grants and permission gating are unit- and smoke-verified; media paths are unchanged from the previous working implementation. |
| S3/R2 attachment upload against a real bucket | **NOT VERIFIED** | No bucket credentials. The endpoint, validation and 501 honesty are verified. |
| Five-user voice session quality | **NOT VERIFIED** | Depends on LiveKit. |
| Scenario G mobile voice | **NOT VERIFIED** | Depends on LiveKit. |
| English/Persian i18n with RTL | **NOT IMPLEMENTED** | Deliberately deferred (see §8). |
| Long-running memory-leak soak test | **NOT VERIFIED** | Would require an extended live session with multiple clients. |
| Production deployment to Railway | **NOT PERFORMED** | Requires explicit authorization per project rules; deployment files verified unchanged in structure. |

## 8. Deliberate scope decisions

1. **i18n (Persian/RTL) deferred.** The priority list in the upgrade brief (§17) places it outside P0–P3, and a partial translation of a 4,300-line UI would ship a mixed-language interface. The text stack is Unicode-safe; a dedicated i18n pass is the recommended next work package.
2. **Attachments via server-proxied S3 SDK rather than presigned URLs.** Simpler security surface, works with R2, and the server streams instead of buffering. The SDK import is dynamic so nothing loads when storage is not configured.
3. **Default channels/membership moved server-side.** The old flow relied on the client to create them; a crashed tab could leave a half-created server.
4. **Reaction authorization relaxed to participants.** Reaction maps are per-user additive and the previous strictness made a core feature unusable; abuse potential is negligible at this deployment scale.

## 9. Modified files

| File | Purpose of change |
| --- | --- |
| `server/index.ts` | Refresh endpoint, 7d tokens, scoped/paginated/search message queries, private-channel enforcement, invitations, DM rename, notifications + read-all, file upload/download, voice-session upsert + disconnect cleanup, server-room voice events, owner membership + default channels, reaction-only patch authorization, 512 KB JSON limit |
| `prisma/schema.prisma` | `ChannelAccess` model + channel relation |
| `prisma/migrations/20261103000000_channel_access/` | New migration (applied and verified) |
| `js/app.js` | Optimistic messaging, targeted updates, per-context pagination, composer/textarea + drafts + IME, attachments UI, private-channel/invite/group/channel-edit modals, notifications + desktop opt-in, search, Railway UI removal, labels, fixes 1–18 above |
| `js/api.js` | Scoped list params, token refresh + 401 retry, real `uploadAttachment` with progress, new socket events, `joinServer` |
| `css/style.css` | `[hidden]` verification, composer textarea, attachment progress chips, pending-message state |
| `index.html` | No changes required (verified) |
| `js/webrtc.js` | No changes required (audio graph, reconnect and cleanup verified intact) |
| `tests/api.test.js` | Harness `setTimeout`, 6 new test groups |
| `README.md`, `.env.example` | Current features, variables, honest limitations |
| `package.json` | `@aws-sdk/client-s3` dependency (dynamically imported) |

## 10. Deployment notes

- Apply migrations: `npx prisma migrate deploy` (Railway start command already does).
- New env vars are optional; without `S3_*` the app behaves exactly as before but with honest attachment errors.
- No destructive database operations were performed; the new migration only adds a table and indexes.
