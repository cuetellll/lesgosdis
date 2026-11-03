/**
 * Mahyar Music — bot worker manager (parent side).
 *
 * The manager owns the worker child process per voice room. The child (see
 * worker-main.ts) holds the real @livekit/rtc-node connection and the ffmpeg
 * decoder; isolating it means a wedged native runtime or a crashed decoder can
 * never take down the main HTTP server, and every teardown is a process exit.
 *
 * Contract with the engine (BotEvents):
 *  - onTrackEnded()      : current decode reached EOF
 *  - onConnectionLost()  : worker died or LiveKit connection dropped
 *  - onDurationKnown(s)  : ffmpeg reported the real duration
 *  - onFatalError(msg)   : playback-level failure (engine advances the queue)
 */
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

export interface BotEvents {
  onTrackEnded: () => void;
  onConnectionLost: (reason: string) => void;
  onDurationKnown: (seconds: number) => void;
  onFatalError: (message: string) => void;
}

const READY_TIMEOUT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;

export class MusicBotWorker {
  readonly identity: string;
  private child: ChildProcess | null = null;
  private ready = false;
  private lastHeartbeatAt = 0;
  private humanCount = 0;
  private stopping = false;
  private starting: Promise<void> | null = null;
  private currentUrl: string | null = null;
  private currentOffset = 0;
  private playingFlag = false;
  private events: BotEvents;

  constructor(
    private readonly liveKitUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly roomId: string,
    events: BotEvents
  ) {
    this.identity = `mahyar-music:${roomId}`;
    this.events = events;
  }

  /** Worker process alive and reporting. */
  get connected(): boolean {
    return Boolean(this.child && this.ready && !this.stopping && this.child.exitCode === null);
  }

  get humanParticipantCount(): number { return this.humanCount; }
  get playing(): boolean { return this.playingFlag; }
  get currentStreamUrl(): string | null { return this.currentUrl; }
  get playbackOffset(): number { return this.currentOffset; }

  private workerEntry(): string {
    // dist/server/music/worker-main.js sits next to this compiled file.
    return path.join(__dirname, 'worker-main.js');
  }

  /** Spawn the worker and wait until it reports the room joined + track published. */
  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        this.stopping = false;
        this.ready = false;
        this.playingFlag = false;
        this.humanCount = 0;
        const child = spawn(process.execPath, [this.workerEntry()], {
          env: {
            ...process.env,
            MUSIC_WORKER_INIT: JSON.stringify({ url: this.liveKitUrl, apiKey: this.apiKey, apiSecret: this.apiSecret, roomId: this.roomId, identity: this.identity })
          },
          stdio: ['ipc', 'pipe', 'pipe']
        });
        this.child = child;

        let stderrTail = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-4_000);
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          // rtc-node logs to stdout; keep the tail for startup-failure diagnostics.
          stderrTail = (stderrTail + chunk.toString()).slice(-4_000);
        });

        child.on('message', (message: any) => this.handleWorkerMessage(message));
        child.on('error', (error) => {
          // Spawn/IPC failures (ENOENT, EAGAIN...) otherwise hang the startup wait silently.
          console.error(`[MahyarMusic] worker spawn error for ${this.roomId}:`, error.message);
          stderrTail = `${stderrTail}\nspawn-error: ${error.message}`.slice(-4_000);
        });
        console.log(`[MahyarMusic] worker spawned for room ${this.roomId} (pid ${child.pid})`);
        child.on('exit', (code, signal) => {
          const wasReady = this.ready;
          this.ready = false;
          this.playingFlag = false;
          this.child = null;
          if (this.stopping) return;
          if (wasReady) this.events.onConnectionLost(`worker exited (code ${code} ${signal || ''})`.trim());
        });

        // Wait for 'ready' with a hard timeout; a worker that cannot join is killed.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const detail = stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ');
            reject(new Error(`Music worker did not become ready in time (pid ${child.pid}).${detail ? ` Worker output: ${detail}` : ' No output captured.'}`));
          }, READY_TIMEOUT_MS);
          const onReady = (message: any) => {
            if (message?.type === 'ready') { clearTimeout(timer); resolve(); }
            else if (message?.type === 'fatal' || message?.type === 'fatal-error') {
              clearTimeout(timer);
              reject(new Error(String(message.message || 'Worker failed to start')));
            }
          };
          child.once('message', onReady);
          child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Music worker exited during startup (code ${code})`)); });
        });
        this.ready = true;
        this.lastHeartbeatAt = Date.now();
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private handleWorkerMessage(message: any) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.lastHeartbeatAt = Date.now();
        break;
      case 'playing':
        this.playingFlag = true;
        break;
      case 'duration':
        if (Number(message.seconds) > 0) this.events.onDurationKnown(Number(message.seconds));
        break;
      case 'track-ended':
        this.playingFlag = false;
        this.currentUrl = null;
        this.events.onTrackEnded();
        break;
      case 'fatal-error':
        this.playingFlag = false;
        this.events.onFatalError(String(message.message || 'Playback failed.'));
        break;
      case 'disconnected':
        this.ready = false;
        this.playingFlag = false;
        this.events.onConnectionLost(String(message.reason || 'LiveKit disconnected'));
        break;
      case 'participants':
        this.humanCount = Math.max(0, Number(message.count) || 0);
        this.lastHeartbeatAt = Date.now();
        break;
      case 'heartbeat':
        this.lastHeartbeatAt = Date.now();
        break;
      case 'decode-debug':
        if (process.env.MUSIC_DEBUG) console.log(`[MahyarMusic][worker] ${message.message}`);
        break;
      case 'fatal':
        // Worker cannot continue at all: treat like a lost connection.
        this.ready = false;
        this.playingFlag = false;
        this.events.onConnectionLost(String(message.message || 'worker fatal'));
        break;
      default:
        break;
    }
  }

  /** True when the worker stopped responding (used by the engine sweeper). */
  isStale(): boolean {
    return this.connected && Date.now() - this.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS;
  }

  /** Start playing a stream URL. Resolves once the decoder is producing audio. */
  async play(url: string, offsetSeconds = 0): Promise<void> {
    if (!this.connected) throw new Error('Bot is not connected');
    this.send({ type: 'stop-playback' });
    this.playingFlag = false;
    this.currentUrl = url;
    this.currentOffset = offsetSeconds;
    await new Promise<void>((resolve, reject) => {
      const child = this.child!;
      const timer = setTimeout(() => {
        child.removeListener('message', onMessage);
        reject(new Error('Music worker did not acknowledge the new track in time.'));
      }, READY_TIMEOUT_MS);
      const onMessage = (message: any) => {
        if (message?.type === 'playing') { clearTimeout(timer); child.removeListener('message', onMessage); resolve(); }
        else if (message?.type === 'fatal-error') { clearTimeout(timer); child.removeListener('message', onMessage); reject(new Error(String(message.message))); }
      };
      child.on('message', onMessage);
      this.send({ type: 'play', url, offset: offsetSeconds });
    });
  }

  /** Stop the current decode without killing the worker. */
  stopPlayback(): void {
    this.playingFlag = false;
    this.currentUrl = null;
    this.send({ type: 'stop-playback' });
  }

  /** Kill the worker; the child releases LiveKit + ffmpeg on exit. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.playingFlag = false;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { this.send({ type: 'shutdown' }); } catch { /* ipc gone */ }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }

  private send(message: Record<string, unknown>) {
    try { this.child?.connected && this.child.send(message); } catch { /* child gone */ }
  }
}
