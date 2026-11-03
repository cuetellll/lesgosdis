/**
 * Mahyar Music — server integration.
 *
 * Wires the engine into the existing Express app and Socket.IO namespace:
 *   - socket `music:command` (authorized, validated, rate-limited by the global
 *     per-socket middleware) with ack responses;
 *   - REST reads: provider status + room state snapshots;
 *   - REST write: per-server music toggle (MANAGE_SERVER);
 *   - graceful shutdown hook.
 *
 * All authorization happens here on the backend: voice-channel access, CONNECT_VOICE
 * membership, and the per-server musicEnabled toggle. The default posture is open —
 * anyone who can join the voice channel and speak can use music.
 */
import { Express, Request, Response, NextFunction } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MusicEngine } from './engine';
import { providerStatuses } from './providers';

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
  const engine = liveKitConfigured
    ? new MusicEngine({
        io,
        liveKitUrl: deps.liveKit.clientUrl!,
        apiKey: deps.liveKit.apiKey!,
        apiSecret: deps.liveKit.apiSecret!,
        isMusicEnabled: async (serverId) => {
          const server = await prisma.server.findUnique({ where: { id: serverId }, select: { musicEnabled: true } });
          return Boolean(server?.musicEnabled);
        }
      })
    : null;

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
            if (!trimmed && !trackId) return ack?.({ ok: false, error: 'Tell Mahyar Music what to play — a song name or a supported link.' });
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
                id: t.id, title: t.title, artist: t.artist, provider: t.provider,
                artwork_url: t.artworkUrl || null, duration: t.duration,
                page_url: t.pageUrl || null
              })),
              error: result.ok ? undefined : result.message
            });
          }
          case 'pause': { const r = engine.pause({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
          case 'resume': { const r = engine.resume({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
          case 'skip': { const r = engine.skip({ channelId, serverId: allowed.serverId, userId }); return ack?.({ ok: r.ok, message: r.message, state: r.state }); }
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
  });

  // ------------------------------------------------------------ REST reads

  app.get('/api/music/providers', auth, async (_req: AuthedRequest, res: Response) => {
    return res.json({
      configured: Boolean(engine),
      providers: providerStatuses()
    });
  });

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
