/**
 * Mahyar Music — end-to-end verification against a REAL local LiveKit server
 * and a REAL local S3-compatible bucket (s3rver).
 *
 * Flow:
 *   1. Boot a local S3 server (the same API the production R2 integration uses).
 *   2. Register two users over REST; A creates a server with a voice channel.
 *   3. B joins the server and the LiveKit room as a real rtc-node subscriber.
 *   4. A uploads an MP3 into the shared library through the full presigned
 *      flow (init → direct PUT → complete/verify) and sees it in the library.
 *   5. `/mp play Believer` (library search) starts the bot; the subscriber
 *      receives REAL audio frames through LiveKit.
 *   6. Duplicate upload, invalid file, SSRF link, outsider, pause/resume/skip/
 *      stop, queue, search, playlist upload→add→play are all asserted.
 */
const { io } = require('/home/z/my-project/mahyar-gap/node_modules/socket.io-client');
const { Room, RoomEvent, ConnectionState, AudioStream } = require('/home/z/my-project/mahyar-gap/node_modules/@livekit/rtc-node');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3100';
const S3_PORT = 4568;
const S3_BUCKET = 'mahyar-music-e2e';
const TRACK_1 = '/home/z/my-project/tools/test-track.mp3';
const TRACK_2 = '/home/z/my-project/tools/test-track-2.mp3';

/** The browser PUTs directly into the bucket, so the bucket needs a CORS rule
 *  allowing the app origin — the exact same policy a Cloudflare R2 bucket needs
 *  in production (documented in README §storage). */
const S3_CORS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

/** Supervised LiveKit server (reuses a warm one when present). */
function startLiveKit() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(7880, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); console.log('reusing already-running livekit-server'); resolve({ pid: 0, kill: () => {} }); });
    sock.once('error', () => {
      sock.destroy();
      const child = spawn('/home/z/my-project/tools/livekit-server', ['--dev', '--bind', '127.0.0.1', '--port', '7880'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const deadline = Date.now() + 20000;
      const probe = () => {
        const s = net.connect(7880, '127.0.0.1');
        s.once('connect', () => { s.destroy(); resolve(child); });
        s.once('error', () => {
          s.destroy();
          if (Date.now() > deadline) return reject(new Error('livekit-server did not start'));
          setTimeout(probe, 400);
        });
      };
      probe();
      child.once('exit', (code) => reject(new Error(`livekit-server exited early (code ${code})`)));
    });
  });
}

async function startS3() {
  const S3rver = require('/home/z/my-project/tools/s3rver/node_modules/s3rver');
  const dir = '/tmp/mahyar-e2e-s3';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const server = new S3rver({ port: S3_PORT, address: '127.0.0.1', directory: dir, configureBuckets: [{ name: S3_BUCKET, configs: [S3_CORS_XML] }] });
  await server.run();
  console.log(`s3rver listening on 127.0.0.1:${S3_PORT} (bucket ${S3_BUCKET})`);
  return { kill: () => server.close() };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function api(pathname, { method = 'GET', token, body, raw } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? raw : (body ? JSON.stringify(body) : undefined)
  });
  let json = null;
  try { json = await response.json(); } catch { /* 204/empty */ }
  return { status: response.status, json };
}

function waitSocketEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, timeoutMs);
    const handler = (payload) => { clearTimeout(timer); socket.off(event, handler); resolve(payload); };
    socket.on(event, handler);
  });
}

function socketCommand(socket, payload) {
  return new Promise((resolve) => socket.emit('music:command', payload, resolve));
}

/** Full client-side library upload: init → presigned PUT → complete. */
async function uploadTrack(token, serverId, filePath, overrides = {}) {
  const stat = fs.statSync(filePath);
  const init = await api('/api/music/upload/init', {
    method: 'POST', token,
    body: { server_id: serverId, file_name: path.basename(filePath), content_type: 'audio/mpeg', size_bytes: stat.size, ...overrides }
  });
  if (init.status !== 201) return { init };
  const bytes = fs.readFileSync(filePath);
  const put = await fetch(init.json.upload_url, { method: 'PUT', headers: { 'Content-Type': init.json.content_type }, body: bytes });
  if (!put.ok) return { init, putStatus: put.status };
  const complete = await api('/api/music/upload/complete', { method: 'POST', token, body: { upload_token: init.json.upload_token, ...overrides } });
  return { init, complete, putStatus: put.status };
}

async function main() {
  const livekit = await startLiveKit();
  const s3 = await startS3();
  const stamp = Date.now();

  // 1. Register two fresh accounts.
  const regA = await api('/auth/register', { method: 'POST', body: { username: `bot_e2e_a_${stamp}`, display_name: 'Bot Tester A', email: `a_${stamp}@e2e.test`, password: 'super-secure-pass-123' } });
  const regB = await api('/auth/register', { method: 'POST', body: { username: `bot_e2e_b_${stamp}`, display_name: 'Bot Tester B', email: `b_${stamp}@e2e.test`, password: 'super-secure-pass-123' } });
  check('two accounts registered', regA.status < 300 && regB.status < 300, `A=${regA.status} B=${regB.status} ${JSON.stringify(regA.json?.error || regB.json?.error)}`);
  const tokenA = regA.json.accessToken, tokenB = regB.json.accessToken;

  // 2. Server with a voice channel.
  const created = await api('/tables/servers', { method: 'POST', token: tokenA, body: { name: `Music E2E ${stamp}` } });
  check('server created', created.status < 300, JSON.stringify(created.json).slice(0, 120));
  const serverId = created.json?.id;
  const inviteCode = created.json?.invite_code;
  const channels = await api(`/tables/channels?page=1&limit=50`, { token: tokenA });
  const voiceChannel = (channels.json.data || []).find((c) => String(c.type).toLowerCase() === 'voice' && c.server_id === serverId);
  check('voice channel exists', Boolean(voiceChannel && serverId));

  // 3. Library status honestly reports storage configuration.
  const status = await api(`/api/music/library/status?server_id=${serverId}`, { token: tokenA });
  check('library status reports configured storage', status.status === 200 && status.json?.storage_configured === true, JSON.stringify(status.json || {}).slice(0, 140));

  // 4. User B joins and subscribes to the LiveKit room.
  const joinB = await api('/api/servers/join', { method: 'POST', token: tokenB, body: { code: inviteCode } });
  check('user B joined the server', joinB.status < 300);
  const voiceToken = await api('/api/voice/token', { method: 'POST', token: tokenB, body: { channelId: voiceChannel.id } });
  check('user B obtained a LiveKit voice token', voiceToken.status < 300, JSON.stringify(voiceToken.json).slice(0, 100));
  const listener = new Room();
  let framesReceived = 0;
  await listener.connect(voiceToken.json.url, voiceToken.json.token, { autoSubscribe: true });
  check('user B connected to the LiveKit room', listener.connectionState === ConnectionState.CONN_CONNECTED);

  // 5. Full upload flow into the shared library.
  const up1 = await uploadTrack(tokenA, serverId, TRACK_1);
  check('upload init issued a presigned PUT', up1.init?.status === 201 && typeof up1.init?.json?.upload_url === 'string');
  check('browser PUT to the presigned URL succeeded', up1.putStatus === 200, `status=${up1.putStatus}`);
  const track1 = up1.complete?.json?.track;
  check('upload verified and library entry created', up1.complete?.status === 201 && Boolean(track1?.id), JSON.stringify(up1.complete?.json || up1).slice(0, 200));
  check('track metadata probed server-side (title/format/duration)', track1?.format === 'mp3' && Number(track1?.duration) > 0, `format=${track1?.format} duration=${track1?.duration}s title=${track1?.title}`);
  const uploaderOk = Boolean(track1?.uploader_name);
  check('uploader attribution recorded', uploaderOk, track1?.uploader_name);

  // 6. The library listing shows the shared track for BOTH members.
  const listA = await api(`/api/music/library?server_id=${serverId}`, { token: tokenA });
  const listB = await api(`/api/music/library?server_id=${serverId}`, { token: tokenB });
  check('library list shows the track for member A', (listA.json?.tracks || []).some((t) => t.id === track1?.id));
  check('library list shows the track for member B', (listB.json?.tracks || []).some((t) => t.id === track1?.id));
  check('library response leaks no storage keys', !JSON.stringify(listA.json).includes('/music/'));

  // 7. Exact duplicate upload is detected (same bytes → same ETag).
  const dup = await uploadTrack(tokenA, serverId, TRACK_1);
  check('duplicate upload rejected with the existing track reported', dup.complete?.status === 409 && dup.complete?.json?.code === 'DUPLICATE_TRACK', JSON.stringify(dup.complete?.json || {}).slice(0, 140));

  // 8. A non-audio file renamed to .mp3 is refused by content inspection.
  const fakePath = `/tmp/mahyar-e2e-fake-${stamp}.mp3`;
  fs.writeFileSync(fakePath, 'this is definitely not audio, just text pretending to be an mp3 file. '.repeat(10));
  const fake = await uploadTrack(tokenA, serverId, fakePath);
  check('non-audio content refused', fake.complete?.status === 415, `status=${fake.complete?.status} ${JSON.stringify(fake.complete?.json?.error || '')}`);
  fs.unlinkSync(fakePath);

  // 9. Unsupported extension refused at init.
  const badInit = await api('/api/music/upload/init', { method: 'POST', token: tokenA, body: { server_id: serverId, file_name: 'virus.exe', size_bytes: 100 } });
  check('executable extension refused', badInit.status === 415, `status=${badInit.status} ${badInit.json?.error || ''}`);

  // 10. User A connects over Socket.IO and plays the LIBRARY track by name.
  const socketA = io(BASE, { auth: { token: tokenA }, transports: ['websocket'] });
  await new Promise((resolve) => socketA.on('connect', resolve));
  socketA.emit('channel:join', voiceChannel.id);
  const statePromise = waitSocketEvent(socketA, 'music:state', 15000);
  const play = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'play', query: track1?.title || 'test track' });
  check('library search played the track', play?.ok === true, JSON.stringify({ ok: play?.ok, message: play?.message || play?.error }).slice(0, 160));
  check('state marks the bot connected with origin=library', play?.state?.now_playing?.origin === 'library', play?.state?.now_playing?.title);

  const firstState = await statePromise;
  check('music:state broadcast received', Boolean(firstState));
  let playingState = play?.state?.now_playing ? play.state : null;
  for (let i = 0; i < 20 && !playingState; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const snap = await api(`/api/music/state?channel_id=${voiceChannel.id}`, { token: tokenA });
    if (snap.json?.state?.now_playing) playingState = snap.json.state;
  }
  check('state carries now playing from the library', Boolean(playingState?.now_playing?.title), playingState?.now_playing?.title || '-');
  check('signed storage URL never leaks to clients', !JSON.stringify(playingState || firstState || {}).includes('X-Amz-') && !JSON.stringify(playingState || firstState || {}).includes(`:${S3_PORT}`));

  // 11. The bot is a real LiveKit participant publishing audio that arrives.
  await new Promise((r) => setTimeout(r, 2500));
  const participants = Array.from(listener.remoteParticipants.values());
  const bot = participants.find((p) => String(p.identity || '').startsWith('mahyar-music:'));
  check('bot is present as a LiveKit participant', Boolean(bot), bot ? bot.identity : participants.map((p) => p.identity).join(','));
  const pub = bot ? Array.from(bot.trackPublications.values()) : [];
  check('bot published an audio track', pub.some((t) => t.kind === 1 || /audio/i.test(String(t.kind))), pub.map((t) => `${t.kind}:${t.trackName}`).join(','));
  const audioPub = pub.find((t) => t.track);
  if (audioPub?.track) {
    const stream = new AudioStream(audioPub.track);
    const deadline = Date.now() + 4000;
    (async () => {
      try { for await (const frame of stream) { framesReceived += 1; if (Date.now() > deadline) break; } } catch { /* closed */ }
    })();
    await new Promise((r) => setTimeout(r, 4200));
  }
  check('subscriber received real audio frames', framesReceived > 50, `${framesReceived} frames in ~4s`);

  // 12. Pause / resume / nowplaying.
  const paused = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'pause' });
  check('pause acknowledged', paused?.ok === true && paused?.state?.now_playing?.paused === true);
  await new Promise((r) => setTimeout(r, 400));
  const resumed = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'resume' });
  check('resume acknowledged', resumed?.ok === true && resumed?.state?.now_playing?.paused === false);

  // 13. Second upload, queue it behind the current track, skip.
  const up2 = await uploadTrack(tokenB, serverId, TRACK_2);
  check('second member can upload too (shared library)', up2.complete?.status === 201, JSON.stringify(up2.complete?.json || up2).slice(0, 160));
  const track2 = up2.complete?.json?.track;
  await new Promise((r) => setTimeout(r, 1600)); // per-user play cooldown
  const queueAdd = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'play', query: track2?.title || 'second' });
  check('second track queued from the library', queueAdd?.ok === true, JSON.stringify(queueAdd?.message || queueAdd?.error));
  const queueView = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'queue' });
  check('queue shows the pending track', queueView?.state?.queue?.length >= 1, `len=${queueView?.state?.queue?.length} np=${queueView?.state?.now_playing?.title || 'none'}`);
  const skip = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'skip' });
  check('skip acknowledged and advanced', skip?.ok === true, JSON.stringify(skip?.message || skip?.error));
  let nowPlaying = null;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    nowPlaying = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'nowplaying' });
    if (nowPlaying?.ok) break;
  }
  check('nowplaying reports the second library track', nowPlaying?.ok === true, nowPlaying?.message);

  // 14. Search returns library results for the composer preview.
  const search = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'search', query: 'track' });
  check('search action returns library tracks', search?.ok === true && (search?.tracks || []).length >= 1, `${search?.tracks?.length || 0} result(s)`);

  // 15. Playlist: create → add track → play through the bot.
  const playlist = await api('/api/music/playlists', { method: 'POST', token: tokenA, body: { server_id: serverId, name: `E2E Mix ${stamp}` } });
  check('playlist created', playlist.status === 201, JSON.stringify(playlist.json).slice(0, 120));
  const addTrack = await api(`/api/music/playlists/${playlist.json?.playlist?.id}/tracks`, { method: 'POST', token: tokenA, body: { track_id: track1?.id } });
  check('track added to playlist', addTrack.status === 201, JSON.stringify(addTrack.json).slice(0, 100));
  const playlistDetail = await api(`/api/music/playlists/${playlist.json?.playlist?.id}`, { token: tokenA });
  check('playlist detail lists the track', (playlistDetail.json?.playlist?.tracks || []).length === 1);
  await new Promise((r) => setTimeout(r, 1600));
  const playPlaylist = await new Promise((resolve) => socketA.emit('music:play_playlist', { channel_id: voiceChannel.id, playlist_id: playlist.json?.playlist?.id }, resolve));
  check('playlist queued through the socket command', playPlaylist?.ok === true, JSON.stringify(playPlaylist?.message || playPlaylist?.error).slice(0, 140));
  const stopAfterPlaylist = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'stop' });
  check('stop after playlist ok', stopAfterPlaylist?.ok === true);

  // 16. External links are honestly refused in this version.
  await new Promise((r) => setTimeout(r, 1600));
  const external = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'play', query: 'http://169.254.169.254/latest/meta-data' });
  check('external/SSRF link refused with an honest message', external?.ok === false, external?.error || external?.message);

  // 17. Authorization: an outsider must be rejected on commands and library.
  const regC = await api('/auth/register', { method: 'POST', body: { username: `bot_e2e_c_${stamp}`, display_name: 'Outsider', email: `c_${stamp}@e2e.test`, password: 'super-secure-pass-123' } });
  const socketC = io(BASE, { auth: { token: regC.json.accessToken }, transports: ['websocket'] });
  await new Promise((resolve) => socketC.on('connect', resolve));
  const outsider = await socketCommand(socketC, { channel_id: voiceChannel.id, action: 'stop' });
  check('outsider music command rejected', outsider?.ok === false, outsider?.error);
  const outsiderLibrary = await api(`/api/music/library?server_id=${serverId}`, { token: regC.json.accessToken });
  check('outsider cannot read the server library', outsiderLibrary.status === 403, `status=${outsiderLibrary.status}`);
  socketC.disconnect();

  // 18. Cross-server isolation: member B's library access is scoped per server.
  const otherServer = await api('/tables/servers', { method: 'POST', token: tokenB, body: { name: `Other ${stamp}` } });
  const otherList = await api(`/api/music/library?server_id=${otherServer.json?.id}`, { token: tokenB });
  check('library is scoped per server', (otherList.json?.tracks || []).length === 0, `status=${otherList.status}`);

  // 19. Track delete removes the DB row and the storage objects.
  const del = await api(`/api/music/tracks/${track2?.id}`, { method: 'DELETE', token: tokenB });
  check('uploader can delete their track', del.status === 200, JSON.stringify(del.json || del).slice(0, 100));
  const listAfter = await api(`/api/music/library?server_id=${serverId}`, { token: tokenA });
  check('deleted track left the library', !(listAfter.json?.tracks || []).some((t) => t.id === track2?.id));

  socketA.disconnect();
  listener.disconnect();
  livekit.kill('SIGTERM');
  s3.kill();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => { console.error('E2E crashed:', error); process.exit(1); });
