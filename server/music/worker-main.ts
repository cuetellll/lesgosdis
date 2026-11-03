/**
 * Mahyar Music — dedicated worker process entrypoint.
 *
 * Each active music room gets its own short-lived Node process that owns the
 * @livekit/rtc-node room connection, the audio source and the ffmpeg decoder.
 * Rationale: the native RTC runtime must never be able to wedge the main HTTP
 * server, and a crashed/finished worker releases EVERY resource (LiveKit
 * connection, audio track, ffmpeg) simply by exiting.
 *
 * Protocol (JSON lines over IPC via process.send/on('message')):
 *   parent → worker : { type: 'play', url, offset }
 *                     { type: 'stop-playback' }
 *                     { type: 'shutdown' }
 *   worker → parent : { type: 'ready' }                       (room joined, track published)
 *                     { type: 'playing' }                     (decoder producing audio)
 *                     { type: 'duration', seconds }
 *                     { type: 'track-ended' }
 *                     { type: 'fatal-error', message }
 *                     { type: 'disconnected', reason }
 *                     { type: 'participants', count }         (periodic + on change)
 *                     { type: 'fatal', message }              (worker cannot continue)
 */
import { spawn, ChildProcess } from 'child_process';
import { AccessToken } from 'livekit-server-sdk';
import { TrackPublishOptions } from '@livekit/rtc-ffi-bindings';
import { Room, LocalAudioTrack, AudioSource, AudioFrame, ConnectionState, RoomEvent } from '@livekit/rtc-node';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * 20; // 20 ms frames
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * CHANNELS * 2; // s16le interleaved
const PARTICIPANT_REPORT_MS = 5_000;

let lastParticipantCount = -1;

function send(message: Record<string, unknown>) {
  try { if (process.send) process.send(message); } catch { /* parent gone */ }
}

function debugLog(message: string) {
  if (process.env.MUSIC_DEBUG) send({ type: 'decode-debug', message });
}

async function resolveFfmpeg(): Promise<string | null> {
  const { access } = await import('fs/promises');
  const exists = async (bin: string) => { try { await access(bin); return true; } catch { return false; } };
  for (const candidate of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (await exists(candidate)) return candidate;
  }
  try {
    const moduleSpec = 'ffmpeg-static';
    const mod = (await import(moduleSpec).catch(() => null)) as { default?: string } | null;
    if (mod?.default && await exists(mod.default)) return mod.default;
  } catch { /* optional */ }
  return null;
}

let room: Room | null = null;
let audioSource: AudioSource | null = null;
let ffmpeg: ChildProcess | null = null;
let shuttingDown = false;
/** Monotonic decode epoch: every startPlayback bumps it; stale async events from a
 *  killed ffmpeg must never be attributed to the newer track. */
let decodeEpoch = 0;
/**
 * rtc-node allows exactly ONE pending captureFrame per AudioSource. When a track is
 * killed mid-frame, its pump can still be awaiting captureFrame; if the next track's
 * pump calls captureFrame concurrently the source throws "InvalidState" and the whole
 * playback dies. Every pump therefore queues its captures: a stale pump's pending
 * capture settles first, and only then does the live pump push its frame.
 */
let captureChain: Promise<unknown> = Promise.resolve();

function captureFrameQueued(source: AudioSource, frame: AudioFrame, epoch: number): Promise<void> {
  const result = captureChain.then(() => {
    if (epoch !== decodeEpoch) return; // stale pump — drop the frame silently
    return source.captureFrame(frame);
  });
  captureChain = result.catch(() => undefined);
  return result;
}

function stopPlayback() {
  decodeEpoch += 1;
  const child = ffmpeg;
  ffmpeg = null;
  if (child) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
}

async function startPlayback(url: string, offsetSeconds: number) {
  if (!room || room.connectionState !== ConnectionState.CONN_CONNECTED) {
    send({ type: 'fatal-error', message: 'Worker is not connected to the voice room.' });
    return;
  }
  stopPlayback();
  const epoch = decodeEpoch; // this track's own epoch

  const bin = await resolveFfmpeg();
  if (!bin) {
    send({ type: 'fatal-error', message: 'ffmpeg is not available on the server (required for audio decoding).' });
    return;
  }
  const seek = offsetSeconds > 0 ? ['-ss', String(Math.floor(offsetSeconds))] : [];
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', ...seek, '-i', url, '-vn', '-map', '0:a:0', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpeg = child;

  let stderrHead = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (epoch !== decodeEpoch) return;
    stderrHead = (stderrHead + chunk.toString()).slice(-2_000);
    if (stderrHead.length > 8_000) return;
    const match = stderrHead.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/);
    if (match) {
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100;
      if (seconds > 0) send({ type: 'duration', seconds });
    }
  });
  child.on('error', (error) => {
    if (epoch !== decodeEpoch || shuttingDown) return;
    send({ type: 'fatal-error', message: `Audio decoder failed: ${error.message}` });
  });
  child.on('close', (code) => {
    if (ffmpeg === child) ffmpeg = null;
    debugLog(`ffmpeg close epoch=${epoch} current=${decodeEpoch} code=${code}`);
    // A killed predecessor must never be reported as the current track's failure.
    if (epoch !== decodeEpoch || shuttingDown) return;
    if (code === 0) { send({ type: 'track-ended' }); return; }
    // Surface the decoder's own error lines so failures are diagnosable in the UI.
    const stderrTail = stderrHead.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).slice(-2).join(' | ');
    send({ type: 'fatal-error', message: `Audio decoder exited unexpectedly (code ${code}).${stderrTail ? ` Decoder said: ${stderrTail}` : ''}` });
  });

  const source = audioSource!;
  let buffer = Buffer.alloc(0);
  const pump = async (): Promise<void> => {
    try {
      for await (const chunk of child.stdout) {
        if (epoch !== decodeEpoch) return;
        buffer = Buffer.concat([buffer, chunk as Buffer]);
        while (buffer.length >= BYTES_PER_FRAME) {
          const frameBytes = buffer.subarray(0, BYTES_PER_FRAME);
          buffer = buffer.subarray(BYTES_PER_FRAME);
          const samples = new Int16Array(frameBytes.buffer, frameBytes.byteOffset, frameBytes.length / 2);
          await captureFrameQueued(source, new AudioFrame(samples, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME), epoch);
        }
      }
    } catch (error) {
      // A real failure on the LIVE pump kills the decoder and reports honestly
      // (the engine advances the queue; the UI shows the error state).
      if (epoch !== decodeEpoch || shuttingDown) return;
      debugLog(`pump error epoch=${epoch}: ${error instanceof Error ? error.message : error}`);
      stopPlayback(); // kills ffmpeg and bumps the epoch so the close handler stays silent
      send({ type: 'fatal-error', message: `Audio pipeline error: ${error instanceof Error ? error.message : 'unknown failure'}` });
    }
  };
  void pump();
  debugLog(`ffmpeg spawned epoch=${epoch} url=${url.slice(0, 60)}...`);
  send({ type: 'playing' });
}

function reportParticipants() {
  if (!room || shuttingDown) return;
  const count = room.remoteParticipants.size;
  if (count !== lastParticipantCount) {
    lastParticipantCount = count;
    send({ type: 'participants', count });
  } else {
    send({ type: 'participants', count });
  }
}

async function main() {
  const init = JSON.parse(process.env.MUSIC_WORKER_INIT || '{}');
  const { url, apiKey, apiSecret, roomId, identity } = init as { url: string; apiKey: string; apiSecret: string; roomId: string; identity: string };
  if (!url || !apiKey || !apiSecret || !roomId) {
    send({ type: 'fatal', message: 'Worker initialization is incomplete.' });
    process.exit(1);
  }

  const at = new AccessToken(apiKey, apiSecret, { identity, name: 'Mahyar Music', ttl: '2h', metadata: JSON.stringify({ bot: 'mahyar-music', room: roomId }) });
  at.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: false, canPublishData: false });
  const token = await at.toJwt();

  room = new Room();
  room.on(RoomEvent.Disconnected, (reason?: unknown) => {
    if (shuttingDown) return;
    stopPlayback();
    send({ type: 'disconnected', reason: String(reason ?? 'disconnected') });
  });

  await room.connect(url, token, { autoSubscribe: false, dynacast: false });
  if (!room.localParticipant) throw new Error('connected without local participant');
  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('MahyarMusic Audio', source);
  await room.localParticipant.publishTrack(track, new TrackPublishOptions({}));
  audioSource = source;
  send({ type: 'ready' });

  const participantTimer = setInterval(reportParticipants, PARTICIPANT_REPORT_MS);
  participantTimer.unref?.();

  process.on('message', (message: any) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'play') void startPlayback(String(message.url || ''), Number(message.offset) || 0);
    else if (message.type === 'stop-playback') stopPlayback();
    else if (message.type === 'shutdown') void shutdown();
  });

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  // Periodic keepalive so the parent can detect a wedged child.
  setInterval(() => send({ type: 'heartbeat' }), 10_000).unref?.();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPlayback();
  try { audioSource?.close(); } catch { /* ignore */ }
  try { await room?.disconnect(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((error) => {
  send({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
