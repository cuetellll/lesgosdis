/**
 * Mahyar Music — room engine.
 *
 * One MusicRoom per voice channel, created on demand, kept entirely in memory.
 * The engine owns: queue, playback state, command authorization, bot lifecycle
 * and state broadcasting over Socket.IO. Nothing about playback position touches
 * the DB (the library records only per-track play counts).
 *
 * Resource rules:
 *  - one bot worker per room, reused across tracks;
 *  - workers start on demand and are torn down when the room goes empty or idle;
 *  - a single sweeper timer (10 s) handles idle/empty cleanup for all rooms;
 *  - stream URLs are short-lived presigned GETs resolved at play time.
 */
import type { Server as SocketIOServer } from 'socket.io';
import { RoomServiceClient } from 'livekit-server-sdk';
import { MusicBotWorker } from './bot';
import { MusicTrack, MusicLibraryResolver, NowPlaying, PublicMusicState, QueueEntry } from './types';

const MAX_QUEUE_SIZE = Number(process.env.MUSIC_MAX_QUEUE || 50);
const BOT_IDLE_DISCONNECT_MS = 120_000;   // idle (no playback) grace before the bot leaves
const BOT_EMPTY_ROOM_DISCONNECT_MS = 45_000; // empty-room grace before the bot leaves
const PLAY_COMMAND_COOLDOWN_MS = 1_000;   // per user, avoids duplicate-queue races

interface MusicRoom {
  channelId: string;
  serverId: string;
  queue: QueueEntry[];
  nowPlaying: NowPlaying | null;
  paused: boolean;
  pausedAt: number;
  lastError: string | null;
  bot: MusicBotWorker | null;
  botConnectedSince: number;
  lastPlaybackEndedAt: number;
  emptySince: number | null;
  lastHumanCount: number;
  /** per-user play-command timestamps for duplicate suppression */
  recentPlays: Map<string, number>;
  /** pending search sessions: key = `${userId}`, value = results (short-lived) */
  searchSessions: Map<string, { tracks: MusicTrack[]; expiresAt: number }>;
}

export interface MusicDeps {
  io: SocketIOServer;
  liveKitUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Returns true when music is allowed in this server (musicEnabled toggle). */
  isMusicEnabled(serverId: string): Promise<boolean>;
  /** The shared library is the only track source. */
  library: MusicLibraryResolver;
}

export class MusicEngine {
  private rooms = new Map<string, MusicRoom>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private roomService: RoomServiceClient | null = null;

  constructor(private deps: MusicDeps) {
    this.sweeper = setInterval(() => void this.sweep(), 10_000);
    this.sweeper.unref?.();
    try {
      // Used only to observe participant counts as a fallback when the bot is between
      // connections; kept lazy so deployments without LiveKit never construct it.
      const url = this.deps.liveKitUrl.replace(/^ws(s):/, 'http$1:');
      this.roomService = new RoomServiceClient(url, this.deps.apiKey, this.deps.apiSecret);
    } catch { this.roomService = null; }
  }

  get library(): MusicLibraryResolver {
    return this.deps.library;
  }

  private room(channelId: string, serverId: string): MusicRoom {
    let room = this.rooms.get(channelId);
    if (!room) {
      room = {
        channelId, serverId, queue: [], nowPlaying: null, paused: false, pausedAt: 0,
        lastError: null, bot: null, botConnectedSince: 0, lastPlaybackEndedAt: 0,
        emptySince: null, lastHumanCount: 0, recentPlays: new Map(), searchSessions: new Map()
      };
      this.rooms.set(channelId, room);
    }
    return room;
  }

  /** Build the client-facing state (stream URLs are never included). */
  private publicState(room: MusicRoom): PublicMusicState {
    const nowPlaying = room.nowPlaying
      ? (() => {
          const elapsed = room.paused
            ? Math.max(0, (room.pausedAt - room.nowPlaying!.startedAt) / 1000)
            : Math.max(0, (Date.now() - room.nowPlaying!.startedAt) / 1000);
          const position = Math.min(room.nowPlaying.track.duration || Infinity, room.nowPlaying.offsetSeconds + elapsed);
          return {
            id: room.nowPlaying.track.id,
            title: room.nowPlaying.track.title,
            artist: room.nowPlaying.track.artist,
            origin: room.nowPlaying.track.origin,
            artwork_url: room.nowPlaying.track.artworkUrl || null,
            duration: room.nowPlaying.track.duration,
            requester_id: room.nowPlaying.requesterId,
            position: Number.isFinite(position) ? Math.round(position * 10) / 10 : 0,
            position_ts: Date.now(),
            paused: room.paused
          };
        })()
      : null;
    return {
      channel_id: room.channelId,
      server_id: room.serverId,
      bot_connected: Boolean(room.bot?.connected),
      bot_identity: room.bot ? room.bot.identity : null,
      now_playing: nowPlaying,
      queue: room.queue.slice(0, MAX_QUEUE_SIZE).map((entry, index) => ({
        position: index + 1,
        id: entry.track.id,
        title: entry.track.title,
        artist: entry.track.artist,
        origin: entry.track.origin,
        artwork_url: entry.track.artworkUrl || null,
        duration: entry.track.duration,
        requester_id: entry.requesterId
      })),
      last_error: room.lastError
    };
  }

  private emit(room: MusicRoom) {
    this.deps.io.to(`channel:${room.channelId}`).emit('music:state', this.publicState(room));
  }

  // ------------------------------------------------------------- lifecycle

  private async ensureBot(room: MusicRoom): Promise<MusicBotWorker> {
    if (room.bot && room.bot.connected) return room.bot;
    if (room.bot) { console.log(`[MahyarMusic] ${Date.now()} replacing non-connected worker in ${room.channelId}`); await room.bot.stop().catch(() => undefined); room.bot = null; }
    const bot = new MusicBotWorker(this.deps.liveKitUrl, this.deps.apiKey, this.deps.apiSecret, room.channelId, {
      onTrackEnded: () => { console.log(`[MahyarMusic] ${Date.now()} track-ended in ${room.channelId}`); void this.handleTrackEnded(room.channelId); },
      onConnectionLost: (reason) => { console.log(`[MahyarMusic] ${Date.now()} connection-lost in ${room.channelId}: ${reason}`); void this.handleBotConnectionLost(room.channelId, reason); },
      onDurationKnown: (seconds) => {
        if (room.nowPlaying && !room.nowPlaying.track.duration) {
          room.nowPlaying.track.duration = Math.round(seconds);
        }
      },
      onFatalError: (message) => {
        room.lastError = message;
        void this.advance(room, room.nowPlaying?.requesterId);
      }
    });
    await bot.ensureConnected();
    room.bot = bot;
    room.botConnectedSince = Date.now();
    room.emptySince = null;
    this.emit(room);
    return bot;
  }

  private async handleBotConnectionLost(channelId: string, reason: string) {
    const room = this.rooms.get(channelId);
    if (!room) return;
    console.warn(`[MahyarMusic] bot disconnected in room ${channelId}: ${reason}`);
    room.bot = null;
    // Keep the state (queue/now playing); the sweeper reconnects if humans remain
    // and playback should continue. Pause so users do not lose queue position silently.
    if (room.nowPlaying && !room.paused) {
      room.paused = true;
      room.pausedAt = Date.now();
    }
    this.emit(room);
  }

  /** Periodic cleanup: empty rooms, idle bots, expired search sessions. */
  private async sweep() {
    const now = Date.now();
    for (const [channelId, room] of this.rooms) {
      // Expire stale search sessions (5 min).
      for (const [userId, session] of room.searchSessions) {
        if (session.expiresAt < now) room.searchSessions.delete(userId);
      }
      // Trim duplicate-suppression map.
      for (const [userId, ts] of room.recentPlays) {
        if (now - ts > PLAY_COMMAND_COOLDOWN_MS * 10) room.recentPlays.delete(userId);
      }

      if (!room.bot) {
        if (!room.nowPlaying && room.queue.length === 0 && !room.lastError) {
          this.rooms.delete(channelId);
        }
        continue;
      }

      // A wedged worker (no heartbeats) is torn down; the next play command respawns it.
      if (room.bot.isStale()) {
        console.warn(`[MahyarMusic] worker for ${channelId} stopped responding; replacing it`);
        await room.bot.stop().catch(() => undefined);
        room.bot = null;
        continue;
      }

      // humanParticipantCount is cheap (in-memory, rtc-node).
      const humans = room.bot.humanParticipantCount;
      if (humans !== room.lastHumanCount) {
        room.lastHumanCount = humans;
        room.emptySince = humans === 0 ? now : null;
      }

      if (humans === 0 && room.emptySince && now - room.emptySince > BOT_EMPTY_ROOM_DISCONNECT_MS) {
        console.log(`[MahyarMusic] room ${channelId} empty; releasing bot`);
        await this.destroyRoom(channelId);
        continue;
      }

      const idle = !room.nowPlaying && room.queue.length === 0 && !room.bot.playing;
      if (idle && room.botConnectedSince && now - Math.max(room.lastPlaybackEndedAt, room.botConnectedSince) > BOT_IDLE_DISCONNECT_MS) {
        console.log(`[MahyarMusic] room ${channelId} idle; releasing bot`);
        await this.destroyRoom(channelId);
      }
    }
  }

  /** Full teardown of a room's bot and state (bot leaves LiveKit). */
  async destroyRoom(channelId: string) {
    const room = this.rooms.get(channelId);
    if (!room) return;
    const hadState = room.nowPlaying || room.queue.length > 0;
    room.nowPlaying = null;
    room.queue = [];
    room.paused = false;
    room.searchSessions.clear();
    if (room.bot) {
      await room.bot.stop().catch(() => undefined);
      room.bot = null;
    }
    this.rooms.delete(channelId);
    if (hadState) {
      // Emit final empty state so clients clear their panels.
      const shell = this.room(channelId, room.serverId);
      shell.lastError = room.lastError;
      this.emit(shell);
      this.rooms.delete(channelId);
    }
  }

  async shutdown() {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.allSettled([...this.rooms.keys()].map((id) => this.destroyRoom(id)));
  }

  // -------------------------------------------------------------- playback

  private async resolveStreamUrl(track: MusicTrack): Promise<string | null> {
    if (track.streamUrl) return track.streamUrl;
    return this.deps.library.streamUrl(track);
  }

  private async advance(room: MusicRoom, requesterId: string | undefined) {
    const next = room.queue.shift();
    if (!next) {
      room.nowPlaying = null;
      room.paused = false;
      room.lastPlaybackEndedAt = Date.now();
      this.emit(room);
      return;
    }
    await this.startTrack(room, next.track, next.requesterId);
  }

  private async startTrack(room: MusicRoom, track: MusicTrack, requesterId: string, offsetSeconds = 0) {
    if (!track.streamable) {
      room.lastError = track.unavailableReason || 'That track cannot be streamed.';
      this.emit(room);
      void this.advance(room, requesterId);
      return;
    }
    try {
      const streamUrl = await this.resolveStreamUrl(track);
      if (!streamUrl) throw new Error('Could not resolve a stream for that track from storage.');
      const bot = await this.ensureBot(room);
      await bot.play(streamUrl, offsetSeconds);
      room.nowPlaying = { track, requesterId, startedAt: Date.now(), offsetSeconds };
      room.paused = false;
      room.lastError = null;
      this.deps.library.recordPlay(track.trackId);
      console.log(`[MahyarMusic] ${Date.now()} now playing "${track.title}" in ${room.channelId}`);
      this.emit(room);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Playback failed.';
      room.lastError = message;
      room.nowPlaying = null;
      this.emit(room);
      console.error(`[MahyarMusic] failed to start track in ${room.channelId}:`, message);
    }
  }

  private async handleTrackEnded(channelId: string) {
    const room = this.rooms.get(channelId);
    if (!room) return;
    room.nowPlaying = null;
    await this.advance(room, undefined);
  }

  // --------------------------------------------------------------- commands

  state(channelId: string): PublicMusicState | null {
    const room = this.rooms.get(channelId);
    return room ? this.publicState(room) : null;
  }

  private duplicateGuard(room: MusicRoom, userId: string): boolean {
    const last = room.recentPlays.get(userId) || 0;
    const now = Date.now();
    if (now - last < PLAY_COMMAND_COOLDOWN_MS) return false;
    room.recentPlays.set(userId, now);
    return true;
  }

  private async enqueue(room: MusicRoom, tracks: MusicTrack[], requesterId: string): Promise<{ ok: boolean; message: string }> {
    const usable = tracks.filter((t) => t.streamable);
    if (!usable.length) {
      return { ok: false, message: tracks[0]?.unavailableReason || 'None of those tracks can be played.' };
    }
    const skipped = tracks.length - usable.length;
    if (room.queue.length + usable.length > MAX_QUEUE_SIZE) {
      return { ok: false, message: `The queue is full (max ${MAX_QUEUE_SIZE} tracks).` };
    }
    for (const track of usable) room.queue.push({ track, requesterId, addedAt: Date.now() });
    if (!room.nowPlaying) await this.advance(room, requesterId);
    this.emit(room);
    const note = skipped > 0 ? ` ${skipped} unavailable track(s) were skipped.` : '';
    return {
      ok: true,
      message: usable.length > 1 ? `Added ${usable.length} tracks to the queue.${note}` : `Added "${usable[0].title}" to the queue.${note}`
    };
  }

  /** `/mp play <query>` — search the shared library, enqueue, start playback if idle. */
  async play(params: { channelId: string; serverId: string; userId: string; query: string; trackRef?: string }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.room(params.channelId, params.serverId);
    if (!this.duplicateGuard(room, params.userId)) {
      return { ok: false, message: 'A play command is already being processed — give it a second.', state: this.publicState(room) };
    }

    const trimmed = params.query.trim();
    let picked: MusicTrack[] = [];
    let pickList: MusicTrack[] | null = null;

    if (/^https?:\/\//i.test(trimmed)) {
      return {
        ok: false,
        message: 'External music links are not played in this version. Upload the file to your server library and run /mp play again.',
        state: this.publicState(room)
      };
    } else if (params.trackRef) {
      // User picked a search result or library row — resolve the ref from their session,
      // falling back to a direct library lookup by id.
      const session = room.searchSessions.get(params.userId);
      const track = session?.tracks.find((t) => t.trackId === params.trackRef || t.id === params.trackRef);
      if (track) {
        session!.tracks = session!.tracks.filter((t) => t !== track);
        picked = [track];
      } else {
        const fresh = await this.deps.library.getPlayableTrack(params.serverId, String(params.trackRef));
        if (!fresh) {
          return { ok: false, message: 'That track is not in this server\'s library.', state: this.publicState(room) };
        }
        picked = [fresh];
      }
    } else if (!trimmed) {
      return { ok: false, message: 'Tell Mahyar Music what to play — a track from your server library.', state: this.publicState(room) };
    } else {
      // Library search: one unambiguous hit queues directly; several hits open the
      // interactive picker; zero hits say so honestly.
      const results = await this.deps.library.searchTracks(params.serverId, trimmed, 5);
      const playable = results.filter((t) => t.streamable);
      if (!playable.length) {
        return {
          ok: false,
          message: results.length
            ? 'Found matching track(s) but none are playable right now.'
            : `No track matching "${trimmed.slice(0, 60)}" in the library. Upload it from the Music Library panel first.`,
          state: this.publicState(room)
        };
      }
      if (playable.length === 1) {
        picked = [playable[0]];
      } else {
        room.searchSessions.set(params.userId, { tracks: playable, expiresAt: Date.now() + 5 * 60_000 });
        pickList = playable;
      }
    }

    if (pickList) {
      return { ok: true, message: 'PICK_RESULT', state: this.publicState(room) };
    }

    const result = await this.enqueue(room, picked, params.userId);
    return { ok: result.ok, message: result.message, state: this.publicState(room) };
  }

  /** Search without enqueueing (used by the command palette preview). */
  async search(params: { channelId: string; serverId: string; userId: string; query: string }): Promise<{ ok: boolean; tracks: MusicTrack[]; message: string }> {
    const room = this.room(params.channelId, params.serverId);
    const results = await this.deps.library.searchTracks(params.serverId, params.query, 6);
    const playable = results.filter((t) => t.streamable);
    room.searchSessions.set(params.userId, { tracks: playable, expiresAt: Date.now() + 5 * 60_000 });
    if (!playable.length) {
      return { ok: false, tracks: [], message: 'No matching tracks in the library. Upload music from the Music Library panel.' };
    }
    return { ok: true, tracks: playable, message: `Found ${playable.length} track(s). Pick one to add it to the queue.` };
  }

  /** Resolve a picked search result (interactive picker flow). */
  async pick(params: { channelId: string; serverId: string; userId: string; trackId: string }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.room(params.channelId, params.serverId);
    const session = room.searchSessions.get(params.userId);
    const track = session?.tracks.find((t) => t.trackId === params.trackId || t.id === params.trackId);
    if (track) {
      session!.tracks = session!.tracks.filter((t) => t !== track);
    } else {
      const fresh = await this.deps.library.getPlayableTrack(params.serverId, params.trackId);
      if (!fresh) return { ok: false, message: 'That search result has expired. Search again.', state: this.publicState(room) };
    }
    const result = await this.enqueue(room, [track!], params.userId);
    return { ok: result.ok, message: result.ok ? `Added "${track!.title}" to the queue.` : result.message, state: this.publicState(room) };
  }

  /** Queue an entire shared playlist (Play → append all tracks, in order). */
  async playPlaylist(params: { channelId: string; serverId: string; userId: string; playlistId: string }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.room(params.channelId, params.serverId);
    if (!this.duplicateGuard(room, params.userId)) {
      return { ok: false, message: 'A play command is already being processed — give it a second.', state: this.publicState(room) };
    }
    const tracks = await this.deps.library.playlistTracks(params.serverId, params.playlistId);
    if (!tracks.length) return { ok: false, message: 'That playlist is empty or does not exist on this server.', state: this.publicState(room) };
    const result = await this.enqueue(room, tracks, params.userId);
    return { ok: result.ok, message: result.message, state: this.publicState(room) };
  }

  pause(params: { channelId: string; serverId: string; userId: string }): { ok: boolean; message: string; state: PublicMusicState } {
    const room = this.rooms.get(params.channelId);
    if (!room || !room.nowPlaying || room.paused) {
      return { ok: false, message: 'Nothing is playing.', state: room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId) };
    }
    room.paused = true;
    room.pausedAt = Date.now();
    room.bot?.stopPlayback();
    this.emit(room);
    return { ok: true, message: 'Playback paused.', state: this.publicState(room) };
  }

  async resume(params: { channelId: string; serverId: string; userId: string }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.rooms.get(params.channelId);
    if (!room || !room.nowPlaying || !room.paused) {
      return { ok: false, message: 'Nothing is paused.', state: room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId) };
    }
    const offset = room.nowPlaying.offsetSeconds + Math.max(0, (room.pausedAt - room.nowPlaying.startedAt) / 1000);
    room.paused = false;
    await this.startTrack(room, room.nowPlaying.track, room.nowPlaying.requesterId, offset);
    return { ok: true, message: 'Playback resumed.', state: this.publicState(room) };
  }

  async skip(params: { channelId: string; serverId: string; userId: string }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.rooms.get(params.channelId);
    if (!room || !room.nowPlaying) {
      return { ok: false, message: 'Nothing is playing.', state: room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId) };
    }
    const skippedTitle = room.nowPlaying.track.title;
    room.bot?.stopPlayback();
    room.nowPlaying = null;
    await this.advance(room, params.userId);
    return { ok: true, message: `Skipped "${skippedTitle}".`, state: this.publicState(room) };
  }

  stop(params: { channelId: string; serverId: string; userId: string }): { ok: boolean; message: string; state: PublicMusicState } {
    const room = this.rooms.get(params.channelId);
    if (!room) return { ok: false, message: 'Nothing is playing.', state: this.emptyState(params.channelId, params.serverId) };
    room.queue = [];
    room.nowPlaying = null;
    room.paused = false;
    room.searchSessions.clear();
    room.bot?.stopPlayback();
    room.lastPlaybackEndedAt = Date.now();
    this.emit(room);
    return { ok: true, message: 'Playback stopped and the queue was cleared.', state: this.publicState(room) };
  }

  queue(params: { channelId: string; serverId: string; userId: string }): { ok: boolean; message: string; state: PublicMusicState } {
    const room = this.rooms.get(params.channelId);
    const state = room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId);
    const count = state.queue.length + (state.now_playing ? 1 : 0);
    return { ok: true, message: count ? `${count} track(s) queued.` : 'The queue is empty.', state };
  }

  nowPlaying(params: { channelId: string; serverId: string; userId: string }): { ok: boolean; message: string; state: PublicMusicState } {
    const room = this.rooms.get(params.channelId);
    if (process.env.MUSIC_DEBUG) console.log(`[MahyarMusic][debug] nowplaying poll room=${params.channelId} found=${Boolean(room)} np=${room?.nowPlaying?.track.title ?? 'null'} queue=${room?.queue.length ?? '-'} bot=${room ? Boolean(room.bot) : '-'} rooms=${this.rooms.size}`);
    const state = room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId);
    return {
      ok: Boolean(state.now_playing),
      message: state.now_playing
        ? `Now playing "${state.now_playing.title}" — ${state.now_playing.artist || 'unknown artist'} (from the server library).`
        : 'Nothing is playing right now.',
      state
    };
  }

  private emptyState(channelId: string, serverId: string): PublicMusicState {
    return {
      channel_id: channelId, server_id: serverId, bot_connected: false, bot_identity: null,
      now_playing: null, queue: [], last_error: null
    };
  }
}
