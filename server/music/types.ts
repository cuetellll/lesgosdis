/**
 * Mahyar Music — shared types for the music engine.
 *
 * The engine is intentionally small: one in-memory state object per voice room,
 * no playback progress persisted to the database, no per-participant audio copies.
 */

export type TrackSource = string;

export interface MusicTrack {
  /** Provider-stable id (e.g. provider:key). Used by the search picker. */
  id: string;
  /** Provider that resolved this track ("direct", "soundcloud", ...). */
  provider: TrackSource;
  title: string;
  artist: string;
  /** Absolute streamable audio URL (server-side only; never sent to clients). */
  streamUrl?: string;
  /** Non-streaming page URL for attribution, safe to show in the UI. */
  pageUrl?: string;
  /** Artwork URL, safe to show in the UI (https: or /api/files/). */
  artworkUrl?: string;
  /** Duration in seconds; 0 when unknown. */
  duration: number;
  /** true when the provider confirmed the stream is playable right now. */
  streamable: boolean;
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
    provider: string;
    page_url: string | null;
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
    provider: string;
    artwork_url: string | null;
    duration: number;
    requester_id: string;
  }>;
  /** Populated on state errors like provider blocks (kept short-lived). */
  last_error: string | null;
}

export interface SearchResult {
  tracks: MusicTrack[];
  provider: string;
}

/**
 * A music provider resolves user input into tracks. Playback happens ONLY through
 * `streamUrl` handed to the bot worker; providers must never return unauthorized
 * stream URLs. A provider that cannot legally support shared playback simply
 * reports metadata without `streamUrl` (streamable=false).
 */
export interface MusicProvider {
  readonly name: string;
  /** true when the provider has enough configuration to answer requests. */
  isConfigured(): boolean;
  /** One-line status for the UI/logs (configured, blocked, disabled...). */
  status(): { configured: boolean; note: string };
  /** True when the input is a URL belonging to this provider. */
  matchesUrl(url: URL): boolean;
  /** Resolve a direct link into a single track or an (expanding) playlist. */
  resolveUrl(url: URL, requesterId: string): Promise<{ tracks: MusicTrack[]; note?: string }>;
  /** Search the provider catalog; may return empty results. */
  search(query: string, limit: number): Promise<SearchResult>;
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
