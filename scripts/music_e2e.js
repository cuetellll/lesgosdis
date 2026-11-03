/**
 * Mahyar Music — end-to-end verification against a REAL local LiveKit server.
 *
 * Flow:
 *   1. Register two users over REST.
 *   2. User A creates a server (voice channel included) and connects via Socket.IO.
 *   3. User B joins the server, gets a LiveKit token and joins the room as a real
 *      subscriber through @livekit/rtc-node.
 *   4. User A runs /mp play against a locally hosted audio file.
 *   5. We verify: ack ok, music:state broadcast, bot joins LiveKit and PUBLISHES a
 *      real audio track, the subscriber RECEIVES audio frames, pause/resume/skip/
 *      stop/queue/nowplaying all behave, and authorization blocks outsiders.
 */
const { io } = require('/home/z/my-project/mahyar-gap/node_modules/socket.io-client');
const { Room, RoomEvent, ConnectionState, AudioStream } = require('/home/z/my-project/mahyar-gap/node_modules/@livekit/rtc-node');
const { spawn } = require('child_process');
const net = require('net');

const BASE = 'http://127.0.0.1:3100';

/** Supervised LiveKit server: the E2E owns its full lifecycle (survives sandbox reaping).
 *  If a livekit is already listening on 7880 (e.g. kept warm across runs), reuse it. */
function startLiveKit() {
  return new Promise((resolve, reject) => {
    const probeOnce = () => {
      const sock = net.connect(7880, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve({ pid: 0, kill: () => {} }); });
      sock.once('error', () => sock.destroy());
    };
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
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await response.json(); } catch { /* 204 */ }
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

async function main() {
  const livekit = await startLiveKit();
  console.log('livekit-server supervised (pid', livekit.pid + ')');
  const stamp = Date.now();
  // 1. Register two fresh accounts.
  const regA = await api('/auth/register', { method: 'POST', body: { username: `bot_e2e_a_${stamp}`, display_name: 'Bot Tester A', email: `a_${stamp}@e2e.test`, password: 'super-secure-pass-123' } });
  const regB = await api('/auth/register', { method: 'POST', body: { username: `bot_e2e_b_${stamp}`, display_name: 'Bot Tester B', email: `b_${stamp}@e2e.test`, password: 'super-secure-pass-123' } });
  check('two accounts registered', regA.status < 300 && regB.status < 300, `A=${regA.status} B=${regB.status} ${JSON.stringify(regA.json?.error || regB.json?.error)}`);
  const tokenA = regA.json.accessToken, tokenB = regB.json.accessToken;
  const userA = regA.json.user, userB = regB.json.user;

  // 2. User A creates a server via the generic table API; the backend creates default channels.
  const created = await api('/tables/servers', { method: 'POST', token: tokenA, body: { name: `Music E2E ${stamp}` } });
  check('server created', created.status < 300, JSON.stringify(created.json).slice(0, 120));
  const serverId = created.json?.id;
  const inviteCode = created.json?.invite_code;
  const channels = await api(`/tables/channels?page=1&limit=50`, { token: tokenA });
  const voiceChannel = (channels.json.data || []).find((c) => String(c.type).toLowerCase() === 'voice' && c.server_id === serverId);
  check('voice channel exists', Boolean(voiceChannel && serverId));

  // 3. User B joins the server via invite, then joins the LiveKit room as a subscriber.
  const joinB = await api('/api/servers/join', { method: 'POST', token: tokenB, body: { code: inviteCode } });
  check('user B joined the server', joinB.status < 300);
  const voiceToken = await api('/api/voice/token', { method: 'POST', token: tokenB, body: { channelId: voiceChannel.id } });
  check('user B obtained a LiveKit voice token', voiceToken.status < 300, JSON.stringify(voiceToken.json).slice(0, 100));

  const listener = new Room();
  let framesReceived = 0;
  let trackSeen = null;
  listener.on(RoomEvent.TrackSubscribed, (track) => { trackSeen = track.kind; });
  // AudioStream pulls frames from the subscribed remote track.
  await listener.connect(voiceToken.json.url, voiceToken.json.token, { autoSubscribe: true });
  check('user B connected to the LiveKit room', listener.connectionState === ConnectionState.CONN_CONNECTED);

  // 4. User A connects over Socket.IO and runs the play command.
  const socketA = io(BASE, { auth: { token: tokenA }, transports: ['websocket'] });
  await new Promise((resolve) => socketA.on('connect', resolve));
  socketA.emit('channel:join', voiceChannel.id);
  const statePromise = waitSocketEvent(socketA, 'music:state', 15000);

  const play = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'play', query: 'http://127.0.0.1:9938/test-track.mp3' });
  check('play command accepted', play?.ok === true, JSON.stringify({ ok: play?.ok, message: play?.message || play?.error }).slice(0, 160));

  // The first broadcast announces the bot connection; playback state follows within a beat.
  const firstState = await statePromise;
  let playingState = play?.state?.now_playing ? play.state : null;
  for (let i = 0; i < 20 && !playingState; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const snap = await api(`/api/music/state?channel_id=${voiceChannel.id}`, { token: tokenA });
    if (snap.json?.state?.now_playing) playingState = snap.json.state;
  }
  check('music:state broadcast received', Boolean(firstState), firstState ? `bot=${firstState.bot_connected} np=${firstState.now_playing?.title}` : 'none');
  check('state marks the bot connected', Boolean(firstState?.bot_connected), firstState?.bot_identity || '-');
  check('state carries now playing', Boolean(playingState?.now_playing?.title), playingState?.now_playing?.title || '-');
  // The stream URL (host + protocol) must never reach clients; a bare user-typed
  // pathname inside a track id is not a secret, the fetchable URL is.
  check('stream URL never leaks to clients', !JSON.stringify(playingState || firstState || {}).includes('://127.0.0.1:9938'));

  // 5. The bot must be a real LiveKit participant publishing audio that arrives.
  await new Promise((r) => setTimeout(r, 2500));
  const participants = Array.from(listener.remoteParticipants.values());
  const bot = participants.find((p) => String(p.identity || '').startsWith('mahyar-music:'));
  check('bot is present as a LiveKit participant', Boolean(bot), bot ? bot.identity : participants.map((p) => p.identity).join(','));
  const pub = bot ? Array.from(bot.trackPublications.values()) : [];
  check('bot published an audio track', pub.some((t) => t.kind === 1 || /audio/i.test(String(t.kind))), pub.map((t) => `${t.kind}:${t.trackName}`).join(','));

  // Pull real audio frames from the subscribed track for ~4 seconds.
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

  // 6. Pause / resume / nowplaying.
  const paused = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'pause' });
  check('pause acknowledged', paused?.ok === true && paused?.state?.now_playing?.paused === true);
  await new Promise((r) => setTimeout(r, 400));
  const resumed = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'resume' });
  check('resume acknowledged', resumed?.ok === true && resumed?.state?.now_playing?.paused === false);

  // 7. Queue a second track (different file) and skip.
  const queueAdd = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'play', query: 'http://127.0.0.1:9938/test-track-2.mp3' });
  check('second track queued', queueAdd?.ok === true, JSON.stringify(queueAdd?.message || queueAdd?.error));
  const queueView = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'queue' });
  check('queue shows the pending track', queueView?.state?.queue?.length >= 1, `len=${queueView?.state?.queue?.length}`);
  const skip = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'skip' });
  check('skip acknowledged and advanced', skip?.ok === true, JSON.stringify(skip?.message || skip?.error));
  // The next track starts asynchronously (bot playback kick-off); give it a beat.
  let nowPlaying = null;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    nowPlaying = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'nowplaying' });
    if (nowPlaying?.ok) break;
  }
  check('nowplaying reports the second track', nowPlaying?.ok === true && /track 2|second/i.test(nowPlaying?.message || ''), nowPlaying?.message);

  // 8. Authorization: an outsider (user C) must be rejected.
  const regC = await api('/auth/register', { method: 'POST', body: { username: `bot_e2e_c_${stamp}`, display_name: 'Outsider', email: `c_${stamp}@e2e.test`, password: 'super-secure-pass-123' } });
  const socketC = io(BASE, { auth: { token: regC.json.accessToken }, transports: ['websocket'] });
  await new Promise((resolve) => socketC.on('connect', resolve));
  const outsider = await socketCommand(socketC, { channel_id: voiceChannel.id, action: 'stop' });
  check('outsider music command rejected', outsider?.ok === false, outsider?.error);
  socketC.disconnect();

  // 9. Stop clears the queue; then the engine should release the bot (sweeper, 45 s).
  const stop = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'stop' });
  check('stop acknowledged', stop?.ok === true);
  const afterStop = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'queue' });
  check('queue cleared after stop', afterStop?.state?.queue?.length === 0 && !afterStop?.state?.now_playing);

  // 10. Provider honesty: an unknown/private host must be refused (SSRF guard).
  await new Promise((r) => setTimeout(r, 1600)); // clear the per-user play cooldown
  const evil = await socketCommand(socketA, { channel_id: voiceChannel.id, action: 'play', query: 'http://169.254.169.254/latest/meta-data' });
  check('SSRF/private link refused', evil?.ok === false, evil?.error || evil?.message);

  socketA.disconnect();
  listener.disconnect();

  livekit.kill('SIGTERM');
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => { console.error('E2E crashed:', error); process.exit(1); });
