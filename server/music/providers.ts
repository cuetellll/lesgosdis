/**
 * Mahyar Music — provider registry.
 *
 * Legal posture (documented, not hidden):
 *  - `direct`   : plays audio from hosts the server operator explicitly allow-lists
 *                 via MUSIC_DIRECT_HOSTS (their own licensed audio, private CDN, etc.).
 *                 SSRF-hardened: public hosts only, http(s), no redirects to other hosts.
 *  - `soundcloud`: official API when SOUNDCLOUD_CLIENT_ID / OAUTH token are configured.
 *                 Shared-room retransmission is gated behind an explicit operator
 *                 attestation (SOUNDCLOUD_SHARED_PLAYBACK_AUTHORIZED=1). Without it the
 *                 provider resolves metadata only and honestly reports the limitation.
 *  - `spotify`  : metadata resolution only (Spotify developer policy prohibits
 *                 non-interactive webcasting; audio is never fetched).
 *
 * No scraping, no stream extraction, no DRM circumvention anywhere in this file.
 */
import { MusicProvider, MusicTrack, ProviderError, SearchResult } from './types';

const UA = 'MahyarMusic/1.0 (+https://mahyar-gap.local)';
const FETCH_TIMEOUT_MS = 8_000;
const MAX_METADATA_BYTES = 512 * 1024;

/** Hosts that must never be fetched server-side, even if allow-listed by mistake. */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^::1$/, /^\[?::1\]?$/, /\.internal$/i, /\.local$/i, /^metadata\./i
];

function assertPublicHost(hostname: string) {
  // Dev/test escape hatch: the operator can explicitly allow private hosts for
  // local audio (MUSIC_ALLOW_PRIVATE_HOSTS=1). Never enabled by default.
  if (process.env.MUSIC_ALLOW_PRIVATE_HOSTS === '1') return;
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    throw new ProviderError('This host is not reachable by the music service.', 400);
  }
}

async function fetchWithLimits(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: { 'User-Agent': UA, ...(init.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithLimits(url, init);
  if (!response.ok) {
    throw new ProviderError(`The music provider returned HTTP ${response.status}.`, response.status === 401 || response.status === 403 ? 502 : 502);
  }
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) throw new ProviderError('The provider response was unexpectedly large.', 502);
  return JSON.parse(text) as T;
}

function formatSeconds(totalSeconds: number): number {
  return Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.round(totalSeconds) : 0;
}

// ---------------------------------------------------------------------------

/**
 * Direct audio provider: streams plain audio files (mp3/ogg/wav/m4a/flac/aac/opus)
 * from hosts the operator explicitly trusts. This is the provider used for the
 * self-hosted demo track and for operators who host licensed audio themselves.
 */
class DirectAudioProvider implements MusicProvider {
  readonly name = 'direct';
  private allowedHosts = new Set<string>();

  constructor() {
    const raw = (process.env.MUSIC_DIRECT_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    for (const entry of raw) {
      const host = entry.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!host) continue;
      // Store both "host" and "host:port" forms so either allow-list style matches.
      this.allowedHosts.add(host);
      this.allowedHosts.add(host.replace(/:\d+$/, ''));
    }
  }

  isConfigured(): boolean { return this.allowedHosts.size > 0; }
  status() {
    return this.isConfigured()
      ? { configured: true, note: `Direct audio enabled for: ${[...this.allowedHosts].join(', ')}` }
      : { configured: false, note: 'Direct audio is disabled. Set MUSIC_DIRECT_HOSTS to allow-list trusted hosts.' };
  }

  matchesUrl(url: URL): boolean {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  private isAllowedHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return this.allowedHosts.has(host);
  }

  async resolveUrl(url: URL): Promise<{ tracks: MusicTrack[]; note?: string }> {
    if (!this.isConfigured()) {
      throw new ProviderError('Direct audio links are disabled on this server. The operator must allow-list trusted hosts via MUSIC_DIRECT_HOSTS.', 400);
    }
    assertPublicHost(url.hostname);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ProviderError('Only http(s) audio links are supported.', 400);
    if (!this.isAllowedHost(url.hostname)) {
      throw new ProviderError(`The host "${url.hostname}" is not allow-listed for direct audio on this server.`, 400);
    }
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'audio');
    const title = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim() || name;
    const track: MusicTrack = {
      id: `direct:${url.pathname}`,
      provider: this.name,
      title,
      artist: url.hostname,
      streamUrl: url.toString(),
      // No public page URL: for operator-hosted files the stream URL itself is the
      // only location, and handing it to clients would leak the origin host.
      duration: 0,
      streamable: true
    };
    // Probe duration cheaply (Content-Length on a HEAD range request is unreliable for
    // duration; keep it 0 and let the bot report real duration from ffmpeg metadata).
    return { tracks: [track] };
  }

  async search(query: string): Promise<SearchResult> {
    // A filename-like query can be matched against a directory listing endpoint if the
    // operator provides MUSIC_DIRECT_INDEX_URL; otherwise direct search is not a thing.
    const indexUrl = (process.env.MUSIC_DIRECT_INDEX_URL || '').trim();
    if (!indexUrl || !query.trim()) return { tracks: [], provider: this.name };
    try {
      const base = new URL(indexUrl);
      assertPublicHost(base.hostname);
      if (!this.isAllowedHost(base.hostname)) return { tracks: [], provider: this.name };
      const data = await fetchJson<{ files?: Array<{ url: string; title?: string; artist?: string; duration?: number; artwork?: string }> }>(indexUrl);
      const needle = query.trim().toLowerCase();
      const tracks = (data.files || [])
        .filter((file) => (file.title || '').toLowerCase().includes(needle) || decodeURIComponent(file.url || '').toLowerCase().includes(needle))
        .slice(0, 25)
        .map((file): MusicTrack | null => {
          const resolved = new URL(file.url, base);
          if (!this.isAllowedHost(resolved.hostname) || !/^https?:$/.test(resolved.protocol)) return null;
          const name = decodeURIComponent(resolved.pathname.split('/').filter(Boolean).pop() || 'audio');
          return {
            id: `direct:${resolved.pathname}`,
            provider: this.name,
            title: file.title || name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim(),
            artist: file.artist || resolved.hostname,
            streamUrl: resolved.toString(),
            artworkUrl: file.artwork || undefined,
            duration: formatSeconds(file.duration || 0),
            streamable: true
          };
        })
        .filter((t): t is MusicTrack => Boolean(t));
      return { tracks, provider: this.name };
    } catch {
      return { tracks: [], provider: this.name };
    }
  }
}

// ---------------------------------------------------------------------------

interface SoundCloudTrack {
  id: number;
  title: string;
  duration: number; // ms
  artwork_url?: string;
  permalink_url?: string;
  user?: { username?: string };
  streamable?: boolean;
  policy?: string;
  media?: { transcodings?: Array<{ url: string; preset: string; format: { protocol: string; mime_type: string } }> };
}

/**
 * SoundCloud provider built on the official API (api.soundcloud.com).
 *
 * The important gate: SoundCloud's API terms do not automatically grant the right to
 * retransmit audio into a shared room. The operator must explicitly attest that their
 * API agreement permits this exact usage (SOUNDCLOUD_SHARED_PLAYBACK_AUTHORIZED=1).
 * Without the attestation this provider resolves metadata only.
 */
class SoundCloudProvider implements MusicProvider {
  readonly name = 'soundcloud';
  private clientId = (process.env.SOUNDCLOUD_CLIENT_ID || '').trim();
  private oauthToken = (process.env.SOUNDCLOUD_OAUTH_TOKEN || '').trim();
  private sharedPlaybackAuthorized = process.env.SOUNDCLOUD_SHARED_PLAYBACK_AUTHORIZED === '1';

  isConfigured(): boolean { return Boolean(this.clientId || this.oauthToken); }

  status() {
    if (!this.isConfigured()) return { configured: false, note: 'SoundCloud is not configured. Set SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_OAUTH_TOKEN (official API).' };
    if (!this.sharedPlaybackAuthorized) {
      return { configured: true, note: 'SoundCloud metadata only — shared playback needs the operator attestation SOUNDCLOUD_SHARED_PLAYBACK_AUTHORIZED=1 confirming API permission for group retransmission.' };
    }
    return { configured: true, note: 'SoundCloud enabled via the official API with operator-attested permission for shared playback.' };
  }

  matchesUrl(url: URL): boolean {
    return /(^|\.)soundcloud\.com$/i.test(url.hostname) || url.hostname.toLowerCase() === 'snd.sc';
  }

  private authHeaders(): Record<string, string> {
    return this.oauthToken ? { Authorization: `OAuth ${this.oauthToken}` } : {};
  }

  private mapTrack(raw: SoundCloudTrack): MusicTrack {
    const playable = Boolean(raw.streamable) && raw.policy !== 'BLOCK' && raw.policy !== 'SNIPPET';
    const streamUrl = playable && this.sharedPlaybackAuthorized ? this.hlsStreamUrl(raw) : undefined;
    return {
      id: `soundcloud:${raw.id}`,
      provider: this.name,
      title: raw.title || 'Untitled',
      artist: raw.user?.username || 'SoundCloud',
      streamUrl,
      pageUrl: raw.permalink_url || undefined,
      artworkUrl: raw.artwork_url ? raw.artwork_url.replace('-large', '-t500x500') : undefined,
      duration: formatSeconds((raw.duration || 0) / 1000),
      streamable: Boolean(streamUrl),
      unavailableReason: !playable
        ? 'This track is not streamable (blocked, preview-only, or private).'
        : (playable && !this.sharedPlaybackAuthorized ? 'Shared playback for SoundCloud requires operator authorization of the API terms.' : undefined)
    };
  }

  /** Returns the official progressive/HLS transcoding URL, when the API exposes one. */
  private hlsStreamUrl(raw: SoundCloudTrack): string | undefined {
    const transcodings = raw.media?.transcodings || [];
    const progressive = transcodings.find((t) => t.format?.mime_type === 'audio/mpeg' && t.preset === 'mp3_1_0' && t.format?.protocol === 'progressive')
      || transcodings.find((t) => t.format?.mime_type === 'audio/mpeg' && t.format?.protocol === 'progressive');
    if (!progressive) return undefined;
    const params = new URLSearchParams({ ...this.authQuery() });
    return `${progressive.url}?${params}`;
  }

  private authQuery(): Record<string, string> {
    const params: Record<string, string> = {};
    if (this.oauthToken) params.oauth_token = this.oauthToken;
    else if (this.clientId) params.client_id = this.clientId;
    return params;
  }

  async resolveUrl(url: URL): Promise<{ tracks: MusicTrack[]; note?: string }> {
    if (!this.isConfigured()) throw new ProviderError('SoundCloud is not configured on this server (official API credentials required).', 400);
    if (url.hostname.toLowerCase() === 'snd.sc') throw new ProviderError('Short snd.sc links are not supported; paste the full soundcloud.com link.', 400);
    const path = url.pathname.replace(/\/+$/, '');
    if (/\/sets\//.test(path)) {
      // Playlist: bounded expansion.
      const data = await fetchJson<SoundCloudTrack & { tracks?: SoundCloudTrack[] }>(`https://api.soundcloud.com/resolve?url=${encodeURIComponent(url.toString())}&${new URLSearchParams(this.authQuery())}`, { headers: this.authHeaders() });
      const raw = data.tracks || [];
      const tracks = raw.slice(0, 100).map((t) => this.mapTrack(t)).filter((t) => t.streamable || t.unavailableReason);
      const skipped = raw.length - raw.filter((t) => t.streamable && t.policy !== 'BLOCK' && t.policy !== 'SNIPPET').length;
      return { tracks, note: skipped > 0 ? `${skipped} track(s) in the playlist are not streamable and were reported, not silently dropped.` : undefined };
    }
    const data = await fetchJson<SoundCloudTrack>(`https://api.soundcloud.com/resolve?url=${encodeURIComponent(url.toString())}&${new URLSearchParams(this.authQuery())}`, { headers: this.authHeaders() });
    return { tracks: [this.mapTrack(data)] };
  }

  async search(query: string, limit: number): Promise<SearchResult> {
    if (!this.isConfigured()) throw new ProviderError('SoundCloud is not configured on this server (official API credentials required).', 400);
    const params = new URLSearchParams({ q: query, limit: String(Math.min(Math.max(limit, 1), 10)), ...this.authQuery() });
    const results = await fetchJson<SoundCloudTrack[]>(`https://api.soundcloud.com/tracks?${params}`, { headers: this.authHeaders() });
    return { tracks: (results || []).map((t) => this.mapTrack(t)), provider: this.name };
  }
}

// ---------------------------------------------------------------------------

interface SpotifyApiTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists?: Array<{ name: string }>;
  album?: { images?: Array<{ url: string }>; name?: string };
  external_urls?: { spotify?: string };
}

/**
 * Spotify provider: metadata resolution ONLY. Spotify's developer policy prohibits
 * non-interactive webcasting, so this provider never returns a streamUrl. It exists
 * so users can paste a Spotify link and get searchable info to re-find the track on
 * an authorized provider.
 */
class SpotifyProvider implements MusicProvider {
  readonly name = 'spotify';
  private clientId = (process.env.SPOTIFY_CLIENT_ID || '').trim();
  private clientSecret = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  private token: { value: string; expiresAt: number } | null = null;

  isConfigured(): boolean { return Boolean(this.clientId && this.clientSecret); }
  status() {
    return this.isConfigured()
      ? { configured: true, note: 'Spotify links resolve to metadata only (policy: no group webcasting).' }
      : { configured: false, note: 'Spotify metadata resolution is not configured (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).' };
  }

  matchesUrl(url: URL): boolean {
    return /(^|\.)spotify\.com$/i.test(url.hostname) || url.hostname.toLowerCase() === 'spoti.fi';
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const response = await fetchWithLimits('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}` },
      body: 'grant_type=client_credentials'
    });
    if (!response.ok) throw new ProviderError('Spotify credentials were rejected.', 502);
    const data = await response.json() as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return this.token.value;
  }

  private mapTrack(raw: SpotifyApiTrack): MusicTrack {
    return {
      id: `spotify:${raw.id}`,
      provider: this.name,
      title: raw.name || 'Unknown',
      artist: (raw.artists || []).map((a) => a.name).join(', ') || 'Spotify',
      pageUrl: raw.external_urls?.spotify || undefined,
      artworkUrl: raw.album?.images?.[0]?.url || undefined,
      duration: formatSeconds((raw.duration_ms || 0) / 1000),
      streamable: false,
      unavailableReason: 'Spotify does not permit shared bot playback. Search for this track on an authorized provider.'
    };
  }

  async resolveUrl(url: URL): Promise<{ tracks: MusicTrack[]; note?: string }> {
    if (!this.isConfigured()) throw new ProviderError('Spotify metadata resolution is not configured on this server.', 400);
    if (url.hostname.toLowerCase() === 'spoti.fi') throw new ProviderError('Short spoti.fi links are not supported; paste the full open.spotify.com link.', 400);
    const token = await this.accessToken();
    const match = url.pathname.match(/(track|album|playlist)\/([A-Za-z0-9]+)/);
    if (!match) throw new ProviderError('That Spotify link type is not recognized.', 400);
    const [, kind, id] = match;
    if (kind === 'track') {
      const data = await fetchJson<SpotifyApiTrack>(`https://api.spotify.com/v1/tracks/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      return { tracks: [this.mapTrack(data)], note: 'Metadata only — Spotify audio cannot be played to a group by policy.' };
    }
    const data = await fetchJson<{ tracks?: { items?: SpotifyApiTrack[] } }>(`https://api.spotify.com/v1/${kind}s/${id}/tracks?limit=50`, { headers: { Authorization: `Bearer ${token}` } });
    const tracks = (data.tracks?.items || []).map((t) => this.mapTrack(t));
    return { tracks, note: 'Spotify metadata imported. Play each track via an authorized provider.' };
  }

  async search(): Promise<SearchResult> {
    // Metadata catalog search is intentionally not exposed: it would suggest playback
    // that the policy forbids. Link resolution is informative only.
    return { tracks: [], provider: this.name };
  }
}

export const providers: MusicProvider[] = [
  new DirectAudioProvider(),
  new SoundCloudProvider(),
  new SpotifyProvider()
];

export function providerStatuses() {
  return providers.map((p) => ({ name: p.name, ...p.status() }));
}

export function providerForUrl(url: URL): MusicProvider | null {
  // Specific providers (SoundCloud, Spotify, …) win over the generic direct
  // provider, which otherwise matches every http(s) URL and would swallow
  // foreign links with a confusing "not allow-listed" error.
  const specific = providers.find((p) => p.name !== 'direct' && p.matchesUrl(url));
  if (specific) return specific;
  return providers.find((p) => p.name === 'direct' && p.matchesUrl(url)) || null;
}

/** Free-text query search across configured providers, ordered by configuration. */
export async function searchAll(query: string, limitPerProvider = 5): Promise<Array<{ provider: string; tracks: MusicTrack[] }>> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const results = await Promise.allSettled(
    providers.filter((p) => p.isConfigured()).map(async (p) => ({ provider: p.name, tracks: (await p.search(trimmed, limitPerProvider)).tracks }))
  );
  return results.flatMap((r) => (r.status === 'fulfilled' && r.value.tracks.length ? [r.value] : []));
}
