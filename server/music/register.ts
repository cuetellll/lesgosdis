/**
 * Mahyar Music — server integration.
 *
 * Wires the engine + shared music library into the existing Express app and
 * Socket.IO namespace:
 *   - socket `music:command` (authorized, validated, rate-limited by the global
 *     per-socket middleware) with ack responses;
 *   - REST reads: library browse/search/recent, playlists, room state snapshots;
 *   - REST writes: upload init/complete, track edit/delete, playlist management,
 *     per-server music toggle (MANAGE_SERVER);
 *   - graceful shutdown hook.
 *
 * All authorization happens here on the backend: voice-channel access,
 * CONNECT_VOICE membership and the per-server musicEnabled toggle for playback;
 * library membership + MUSIC_* role nodes for uploads and administration.
 * The default posture is open — anyone who can join the voice channel and speak
 * can use music, and every member can contribute to the library (five friends).
 */
import { Express, Request, Response, NextFunction } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MusicEngine } from './engine';
import { MusicLibraryResolver, MusicTrack as PlayableTrack } from './types';
import { registerMusicLibrary, libraryLimits } from './library';
import { presignDownload } from './storage';

type AuthedRequest = Request & { userId?: string };

export interface MusicSystemDeps {
  app: Express;
  io: SocketIOServer;
  prisma: PrismaClient;
  auth: (req: AuthedRequest, res: Response, next: NextFunction) => void;
  canAccessChannel: (userId: string, channel: { id: string; serverId: string; isPrivate: boolean; type?: string }) => Promise<boolean>;
  serverPermission: (userId: string, serverId: string, permission: string) => Promise<boolean>;
  requireServerPermission: (userId: string, serverId: string, permission: string) => Promise<void>;
  liveKit: { ok: boolean; apiKey?: string; apiSecret?: string; clientUrl?: string; status?: number; body?: unknown };
}

export interface MusicSystem {
  engine: MusicEngine | null;
  shutdown: () => Promise<void>;
}

const commandSchema = z.object({
  channel_id: z.string().min(1).max(64),
  action: z.enum(['play', 'pick', 'search', 'pause', 'resume', 'skip', 'stop', 'queue', 'nowplaying']),
  query: z.string().max(300).optional(),
  track_id: z.string().max(200).optional()
});

export function registerMusicSystem(deps: MusicSystemDeps): MusicSystem {
  const { app, io, prisma, auth } = deps;

  // The engine exists only when LiveKit is fully configured; music commands report an
  // honest configuration error otherwise (never a fake "playing" state).
  const liveKitConfigured = deps.liveKit.ok;

  // ------------------------------------------------------------ permissions

  /** Upload gate: owner always can; when MUSIC_UPLOAD is configured on any role only
   *  holders may upload; otherwise the default-open posture applies to all members. */
  async function canUploadMusic(userId: string, serverId: string): Promise<boolean> {
    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
    if (!server) return false;
    if (server.ownerId === userId) return true;
    const configured = await prisma.permission.count({ where: { node: 'MUSIC_UPLOAD', role: { serverId } } });
    if (!configured) return true;
    return deps.serverPermission(userId, serverId, 'MUSIC_UPLOAD').catch(() => false);
  }

  /** Library administration (edit/remove other members' tracks & playlists): owner,
   *  ADMINISTRATOR or MANAGE_SERVER; plus MUSIC_MANAGE holders when configured, and
   *  MANAGE_MESSAGES holders by default. */
  async function canManageLibrary(userId: string, serverId: string): Promise<boolean> {
    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
    if (!server) return false;
    if (server.ownerId === userId) return true;
    if (await deps.serverPermission(userId, serverId, 'ADMINISTRATOR').catch(() => false)) return true;
    if (await deps.serverPermission(userId, serverId, 'MANAGE_SERVER').catch(() => false)) return true;
    const configured = await prisma.permission.count({ where: { node: 'MUSIC_MANAGE', role: { serverId } } });
    if (configured) return deps.serverPermission(userId, serverId, 'MUSIC_MANAGE').catch(() => false);
    return deps.serverPermission(userId, serverId, 'MANAGE_MESSAGES').catch(() => false);
  }

  async function isMemberOfServer(userId: string, serverId: string): Promise<boolean> {
    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
    if (!server) return false;
    if (server.ownerId === userId) return true;
    const membership = await prisma.serverMember.findUnique({ where: { serverId_userId: { serverId, userId } }, select: { id: true } });
    return Boolean(membership);
  }

  // ------------------------------------------------------ library resolver

  function rowToPlayable(row: {
    id: string; title: string; artist: string; duration: number; storageKey: string; artworkKey: string | null;
  }): PlayableTrack {
    return {
      id: `lib:${row.id}`,
      origin: 'library',
      trackId: row.id,
      title: row.title,
      artist: row.artist,
      artworkUrl: row.artworkKey ? `/api/music/tracks/${row.id}/artwork` : undefined,
      duration: row.duration,
      streamable: true,
      storageKey: row.storageKey
    };
  }

  const libraryResolver: MusicLibraryResolver = {
    async searchTracks(serverId, query, limit) {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const rows = await prisma.musicTrack.findMany({
        where: {
          serverId,
          OR: [
            { title: { contains: trimmed, mode: 'insensitive' } },
            { artist: { contains: trimmed, mode: 'insensitive' } },
            { originalName: { contains: trimmed, mode: 'insensitive' } }
          ]
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 10),
        select: { id: true, title: true, artist: true, duration: true, storageKey: true, artworkKey: true }
      });
      return rows.map(rowToPlayable);
    },
    async getPlayableTrack(serverId, trackId) {
      const row = await prisma.musicTrack.findFirst({
        where: { id: trackId, serverId },
        select: { id: true, title: true, artist: true, duration: true, storageKey: true, artworkKey: true }
      });
      return row ? rowToPlayable(row) : null;
    },
    async streamUrl(track) {
      if (!track.storageKey) return null;
      return presignDownload(track.storageKey);
    },
    async playlistTracks(serverId, playlistId) {
      const playlist = await prisma.musicPlaylist.findFirst({ where: { id: playlistId, serverId }, select: { id: true } });
      if (!playlist) return [];
      const items = await prisma.musicPlaylistTrack.findMany({
        where: { playlistId: playlist.id },
        orderBy: { position: 'asc' },
        include: { track: { select: { id: true, title: true, artist: true, duration: true, storageKey: true, artworkKey: true } } }
      });
      return items.map((item) => rowToPlayable(item.track));
    },
    recordPlay(trackId) {
      // Fire-and-forget play counter; never blocks or fails playback.
      void prisma.musicTrack.update({
        where: { id: trackId },
        data: { playCount: { increment: 1 }, lastPlayedAt: new Date() }
      }).catch(() => undefined);
    }
  };

  // ------------------------------------------------------------- engine

  const engine = liveKitConfigured
    ? new MusicEngine({
        io,
        liveKitUrl: deps.liveKit.clientUrl!,
        apiKey: deps.liveKit.apiKey!,
        apiSecret: deps.liveKit.apiSecret!,
        isMusicEnabled: async (serverId) => {
          const server = await prisma.server.findUnique({ where: { id: serverId }, select: { musicEnabled: true } });
          return Boolean(server?.musicEnabled);
        },
        library: libraryResolver
      })
    : null;

  // ------------------------------------------------------- library routes

  registerMusicLibrary({
    app,
    prisma,
    auth,
    isMember: isMemberOfServer,
    musicPermission: async (userId, serverId, action) => (action === 'upload' ? canUploadMusic(userId, serverId) : canManageLibrary(userId, serverId)),
    broadcast: (serverId, event, payload) => io.to(`server:${serverId}`).emit(event, payload)
  });

  // Library status for the client (storage configured? limits? counts?).
  app.get('/api/music/library/status', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = String(req.query.server_id || '');
      let trackCount = 0;
      let usedBytes = 0;
      if (serverId && await isMemberOfServer(req.userId!, serverId)) {
        const [count, agg] = await Promise.all([
          prisma.musicTrack.count({ where: { serverId } }),
          prisma.musicTrack.aggregate({ where: { serverId }, _sum: { fileSize: true } })
        ]);
        trackCount = count;
        usedBytes = Number(agg._sum?.fileSize || 0);
      }
      return res.json({ ...libraryLimits(), track_count: trackCount, used_bytes: usedBytes, playback_configured: Boolean(engine) });
    } catch (error) { return next(error); }
  });

  /** Shared authorization for every music command: voice channel + membership + toggle. */
  async function authorizeMusic(userId: string, channelId: string): Promise<{ ok: true; serverId: string } | { ok: false; status: number; error: string }> {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, type: true, isPrivate: true } });
    if (!channel || channel.type !== 'VOICE') return { ok: false, status: 404, error: 'Voice channel not found' };
    if (!await deps.canAccessChannel(userId, channel).catch(() => false)) return { ok: false, status: 403, error: 'You cannot use music in this voice channel' };
    if (!await deps.serverPermission(userId, channel.serverId, 'CONNECT_VOICE').catch(() => false)) return { ok: false, status: 403, error: 'You do not have voice access on this server' };
    const server = await prisma.server.findUnique({ where: { id: channel.serverId }, select: { musicEnabled: true } });
    if (!server?.musicEnabled) return { ok: false, status: 403, error: 'Music is disabled on this server' };
    return { ok: true, serverId: channel.serverId };
  }

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    socket.on('music:command', async (payload: unknown, ack?: (result: unknown) => void) => {
      const parsed = commandSchema.safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'Invalid music command' });
      const { channel_id: channelId, action, query, track_id: trackId } = parsed.data;

      const allowed = await authorizeMusic(userId, channelId);
      if (!allowed.ok) return ack?.({ ok: false, error: allowed.error });
      if (!engine) {
        return ack?.({ ok: false, error: 'Mahyar Music is not configured on this server (LiveKit credentials required).' });
      }

      try {
        switch (action) {
          case 'play': {
            const trimmed = (query || '').trim();
            if (!trimmed && !trackId) return ack?.({ ok: false, error: 'Tell Mahyar Music what to play — a track from your server library.' });
            const result = await engine.play({ channelId, serverId: allowed.serverId, userId, query: trimmed, trackRef: trackId || undefined });
            if (result.message === 'PICK_RESULT') {
              // Multiple candidates: the client opens the interactive picker.
              return ack?.({ ok: true, action: 'pick_result', message: 'Several tracks matched — pick one.', state: result.state });
            }
            return ack?.({ ok: result.ok, message: result.message, state: result.state, error: result.ok ? undefined : result.message });
          }
          case 'pick': {
            if (!trackId) return ack?.({ ok: false, error: 'No track was selected.' });
            const result = await engine.pick({ channelId, serverId: allowed.serverId, userId, trackId });
            return ack?.({ ok: result.ok, message: result.message, state: result.state, error: result.ok ? undefined : result.message });
          }
          case 'search': {
            const result = await engine.search({ channelId, serverId: allowed.serverId, userId, query: (query || '').trim() });
            return ack?.({
              ok: result.ok,
              message: result.message,
              tracks: result.tracks.map((t) => ({
                id: t.id, track_id: t.trackId, title: t.title, artist: t.artist, origin: t.origin,
                artwork_url: t.artworkUrl || null, duration: t.duration
              })),
              error: result.ok ? undefined : result.message
            });
          }
          case 'pause': { const r = engine.pause({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
          case 'resume': { const r = await engine.resume({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
          case 'skip': { const r = await engine.skip({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
          case 'stop': { const r = engine.stop({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
          case 'queue': { const r = engine.queue({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
          case 'nowplaying': { const r = engine.nowPlaying({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
          default:
            return ack?.({ ok: false, error: 'Unknown music command' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The music command failed.';
        return ack?.({ ok: false, error: message });
      }
    });

    socket.on('music:subscribe', async (rawChannelId: unknown, ack?: (result: unknown) => void) => {
      const channelId = String(rawChannelId || '');
      if (!channelId.length || channelId.length > 64) return ack?.({ ok: false });
      const allowed = await authorizeMusic(userId, channelId).catch(() => ({ ok: false as const }));
      if (!allowed.ok) return ack?.({ ok: false });
      // Joining the channel room is enough; music:state is broadcast there.
      socket.join(`channel:${channelId}`);
      ack?.({ ok: true, state: engine ? engine.state(channelId) : null });
    });

    // Queue an entire shared playlist into a voice channel from the library UI.
    socket.on('music:play_playlist', async (payload: unknown, ack?: (result: unknown) => void) => {
      const parsed = z.object({ channel_id: z.string().min(1).max(64), playlist_id: z.string().min(1).max(64) }).safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'Invalid playlist play request' });
      const allowed = await authorizeMusic(userId, parsed.data.channel_id);
      if (!allowed.ok) return ack?.({ ok: false, error: allowed.error });
      if (!engine) return ack?.({ ok: false, error: 'Mahyar Music is not configured on this server (LiveKit credentials required).' });
      try {
        const result = await engine.playPlaylist({ channelId: parsed.data.channel_id, serverId: allowed.serverId, userId, playlistId: parsed.data.playlist_id });
        return ack?.({ ok: result.ok, message: result.message, state: result.state, error: result.ok ? undefined : result.message });
      } catch (error) {
        return ack?.({ ok: false, error: error instanceof Error ? error.message : 'The playlist could not be queued.' });
      }
    });
  });

  // ------------------------------------------------------------ REST reads

  app.get('/api/music/state', auth, async (req: AuthedRequest, res: Response) => {
    const channelId = String(req.query.channel_id || '');
    if (!channelId || channelId.length > 64) return res.status(400).json({ error: 'channel_id is required' });
    const allowed = await authorizeMusic(req.userId!, channelId).catch(() => null);
    if (!allowed || !allowed.ok) return res.status(403).json({ error: 'You cannot view music state for this channel' });
    if (!engine) return res.json({ configured: false, state: null });
    return res.json({ configured: true, state: engine.state(channelId) });
  });

  // ----------------------------------------------------------- REST writes

  app.patch('/api/servers/:serverId/music', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const input = z.object({ music_enabled: z.boolean() }).parse(req.body);
      await deps.requireServerPermission(req.userId!, req.params.serverId, 'MANAGE_SERVER');
      const server = await prisma.server.update({ where: { id: req.params.serverId }, data: { musicEnabled: input.music_enabled }, select: { id: true, musicEnabled: true } });
      return res.json({ id: server.id, music_enabled: server.musicEnabled });
    } catch (error) { return next(error); }
  });

  return {
    engine,
    shutdown: async () => { await engine?.shutdown(); }
  };
}
