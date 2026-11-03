/**
 * Mahyar Music — shared types for the music engine.
 *
 * The engine is intentionally small: one in-memory state object per voice room,
 * no playback progress persisted to the database, no per-participant audio copies.
 *
 * This version's only audio source is the shared server library (uploaded files
 * in private object storage). There are no external search providers.
 */

/** Where a queued track came from. Only "library" exists in this version. */
export type TrackOrigin = 'library';

export interface MusicTrack {
  /** Stable id — "lib:<MusicTrack.id>" for library tracks. */
  id: string;
  origin: TrackOrigin;
  /** Library track id (the MusicTrack row id) for library tracks. */
  trackId: string;
  title: string;
  artist: string;
  /** Short-lived presigned URL resolved at play time (server-side only; never sent to clients). */
  streamUrl?: string;
  /** Artwork route, safe to show in the UI (authenticated /api/music/... path). */
  artworkUrl?: string;
  /** Duration in seconds; 0 when unknown. */
  duration: number;
  streamable: boolean;
  /** Object key in the private bucket — server-side only, never sent to clients. */
  storageKey?: string;
  /** Explicit note for the UI when a track cannot be played. */
  unavailableReason?: string;
}

export interface QueueEntry {
  track: MusicTrack;
  /** User id that requested the track. */
  requesterId: string;
  addedAt: number;
}

export interface NowPlaying {
  track: MusicTrack;
  requesterId: string;
  /** Epoch ms when playback of this track started (excludes paused time). */
  startedAt: number;
  /** Seconds already elapsed before startedAt (after a resume). */
  offsetSeconds: number;
}

export interface PublicMusicState {
  channel_id: string;
  server_id: string;
  /** True when the bot participant is connected to the LiveKit room. */
  bot_connected: boolean;
  bot_identity: string | null;
  now_playing: null | {
    id: string;
    title: string;
    artist: string;
    origin: string;
    artwork_url: string | null;
    duration: number;
    requester_id: string;
    /** Server-computed playback position at `position_ts`, seconds. */
    position: number;
    position_ts: number;
    paused: boolean;
  };
  queue: Array<{
    position: number;
    id: string;
    title: string;
    artist: string;
    origin: string;
    artwork_url: string | null;
    duration: number;
    requester_id: string;
  }>;
  /** Populated on state errors like a failed decode (kept short-lived). */
  last_error: string | null;
}

export interface SearchResult {
  tracks: MusicTrack[];
}

/**
 * The engine talks to the library through this narrow interface so it can be
 * unit-tested without a database, and so playback never depends on providers.
 */
export interface MusicLibraryResolver {
  /** Case-insensitive search of the server's library (title/artist/filename). */
  searchTracks(serverId: string, query: string, limit: number): Promise<MusicTrack[]>;
  /** Loads one library track as playable (or returns null). */
  getPlayableTrack(serverId: string, trackId: string): Promise<MusicTrack | null>;
  /** Resolves a fresh short-lived stream URL for a library track. */
  streamUrl(track: MusicTrack): Promise<string | null>;
  /** Ordered tracks of a playlist (empty when the playlist is not on this server). */
  playlistTracks(serverId: string, playlistId: string): Promise<MusicTrack[]>;
  /** Marks a track as played (play count / last played). Fire and forget. */
  recordPlay(trackId: string): void;
}

export class MusicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
