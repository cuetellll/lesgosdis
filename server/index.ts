import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import { Prisma, PrismaClient } from '@prisma/client';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import bcrypt from 'bcrypt';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';
import { registerMusicSystem } from './music/register';

const prisma = new PrismaClient();
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const allowedOrigin = process.env.CORS_ORIGIN || false;
const io = new SocketIOServer(server, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
  pingInterval: 10000,
  pingTimeout: 20000
});

type AuthedRequest = Request & { userId?: string };

// Live presence is derived from authenticated sockets, not from a stored column.
const onlineUsers = new Map<string, number>();
function broadcastPresence() { io.emit('presence:update', { userIds: [...onlineUsers.keys()] }); }
const secret = process.env.JWT_ACCESS_SECRET;
if (process.env.NODE_ENV === 'production' && (!secret || secret.length < 32)) {
  throw new Error('JWT_ACCESS_SECRET must contain at least 32 characters in production');
}
const jwtSecret = secret || 'local-development-only-secret-change-before-deploy';
// 7-day access tokens combined with POST /auth/refresh (see below) keep long voice and chat
// sessions alive without storing cookies or a server-side session table.
const issueToken = (userId: string) => jwt.sign({}, jwtSecret, { subject: userId, expiresIn: '7d' });

// Music uploads bypass the server entirely (browser → bucket presigned PUT), so the
// storage endpoint's origin must be a legal connect target. https: origins are already
// covered; http endpoints (local MinIO/s3rver in development) are added explicitly.
const storageEndpointOrigin = (() => {
  const raw = process.env.S3_ENDPOINT?.trim();
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
})();

app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net', 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'", 'blob:', 'https:'],
  connectSrc: ["'self'", 'https:', 'wss:', ...(storageEndpointOrigin ? [storageEndpointOrigin] : [])],
  objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"]
} } }));
app.use(compression());
app.use(cors({ origin: allowedOrigin }));
// 512kb: a 256 KB avatar payload is ~349 KB once base64-encoded (plus JSON envelope),
// so the previous 256kb limit silently rejected perfectly valid avatar uploads.
app.use(express.json({ limit: '512kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false }));
app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/tables/', rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false }));

function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, jwtSecret) as JwtPayload;
    if (typeof decoded.sub !== 'string') throw new Error('Missing subject');
    req.userId = decoded.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}

function toCamel(value: string) { return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()); }
function toSnake(value: string) { return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function serialize(table: string, row: any): any {
  if (!row) return row;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'passwordHash' || key === 'refreshToken' || key === 'email') continue;
    if (key === 'permissions' && table === 'roles') out.permissions = (value as any[]).map((p) => p.node);
    else if (key === 'roles' && table === 'server_members') out.role_ids = (value as any[]).map((r) => r.id);
    else out[toSnake(key)] = value;
  }
  if (row.createdAt) out.created_iso = row.createdAt.toISOString();
  if (row.createdAt && table !== 'users') out.timestamp_iso = row.createdAt.toISOString();
  if (row.joinedAt) out.joined_iso = row.joinedAt.toISOString();
  if (table === 'users') {
    out.display_name = row.displayName;
    out.avatar_color = row.avatarColor;
    if (row.status) out.status = String(row.status).toLowerCase();
  }
  if (table === 'servers') {
    out.owner_id = row.ownerId;
    out.invite_code = row.inviteCode;
    out.icon_text = row.iconText;
    out.icon_color = row.iconColor;
  }
  if (table === 'channels') { out.server_id = row.serverId; if (row.type) out.type = String(row.type).toLowerCase(); }
  if (table === 'friends' && row.status) out.status = String(row.status).toLowerCase();
  if (table === 'messages') {
    out.channel_id = row.channelId; out.server_id = row.channel?.serverId;
    out.user_id = row.userId; out.reply_to_id = row.replyToId;
    out.attachments_json = row.attachmentsJson || '[]'; out.reactions_json = row.reactionsJson || '{}';
    out.author = row.author ? serialize('users', row.author) : undefined;
  }
  if (table === 'direct_messages') {
    out.conversation_id = row.conversationId; out.participant_ids = row.participantIds;
    out.sender_id = row.senderId; out.reply_to_id = row.replyToId;
    out.group_name = row.groupName; out.is_group = row.isGroup;
    out.attachments_json = row.attachmentsJson || '[]'; out.reactions_json = row.reactionsJson || '{}';
    out.author = row.sender ? serialize('users', row.sender) : undefined;
  }
  if (table === 'server_members') { out.server_id = row.serverId; out.user_id = row.userId; out.joined_at = row.joinedAt; }
  if (table === 'voice_sessions') { out.channel_id = row.channelId; out.user_id = row.userId; out.server_id = row.channel?.serverId; }
  if (table === 'audit_logs') { out.server_id = row.serverId; out.actor_id = row.actorId; }
  return out;
}

const tableModels: Record<string, { delegate: any; allowed: string[] }> = {
  users: { delegate: prisma.user, allowed: ['displayName', 'avatarUrl', 'avatarColor', 'bannerColor', 'status', 'customStatus', 'bio'] },
  servers: { delegate: prisma.server, allowed: ['name', 'description', 'iconUrl', 'iconText', 'iconColor', 'ownerId', 'inviteCode', 'region', 'verificationLevel'] },
  roles: { delegate: prisma.role, allowed: ['serverId', 'name', 'color', 'position', 'hoist'] },
  server_members: { delegate: prisma.serverMember, allowed: ['serverId', 'userId', 'nickname'] },
  channels: { delegate: prisma.channel, allowed: ['serverId', 'name', 'category', 'type', 'topic', 'position', 'slowmode', 'isPrivate'] },
  messages: { delegate: prisma.message, allowed: ['channelId', 'userId', 'content', 'replyToId', 'attachmentsJson', 'reactionsJson', 'pinned', 'edited', 'threadName'] },
  direct_messages: { delegate: prisma.directMessage, allowed: ['conversationId', 'participantIds', 'senderId', 'content', 'replyToId', 'attachmentsJson', 'reactionsJson', 'isGroup', 'groupName', 'pinned', 'edited'] },
  friends: { delegate: prisma.friend, allowed: ['userId', 'friendId', 'status'] },
  voice_sessions: { delegate: prisma.voiceSession, allowed: ['channelId', 'userId', 'muted', 'deafened', 'videoEnabled', 'screenSharing'] },
  audit_logs: { delegate: prisma.auditLog, allowed: ['serverId', 'actorId', 'actionType', 'targetName', 'details'] },
  notifications: { delegate: prisma.notification, allowed: ['userId', 'title', 'body', 'type', 'read'] }
};
const tableOrderFields: Record<string, 'createdAt' | 'joinedAt'> = {
  users: 'createdAt', servers: 'createdAt', roles: 'createdAt', server_members: 'joinedAt',
  channels: 'createdAt', messages: 'createdAt', direct_messages: 'createdAt', friends: 'createdAt',
  voice_sessions: 'joinedAt', audit_logs: 'createdAt', notifications: 'createdAt'
};

const ATTACHMENT_URL_PATTERN = /^(\/api\/files\/[A-Za-z0-9_-]{1,200}|https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]{1,400})$/;
const ATTACHMENT_MIME_ALLOWLIST = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'application/pdf', 'text/plain']);
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 52_428_800; // 50 MB
/** Validates a client-supplied attachment list (URL shape, MIME allowlist, size ceiling). */
function sanitizeAttachments(value: unknown): string {
  if (value === null || value === undefined || value === '') return '[]';
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw Object.assign(new Error('Invalid attachment payload'), { status: 400 }); }
  if (!Array.isArray(parsed)) throw Object.assign(new Error('Attachments must be a list'), { status: 400 });
  if (parsed.length > MAX_ATTACHMENTS) throw Object.assign(new Error(`A message can carry at most ${MAX_ATTACHMENTS} attachments`), { status: 400 });
  const clean = parsed.map((item) => {
    const att = item as Record<string, unknown>;
    const url = String(att?.url || '');
    const name = String(att?.name || 'file');
    const contentType = String(att?.content_type || att?.contentType || 'application/octet-stream');
    const size = Number(att?.size || 0);
    if (!ATTACHMENT_URL_PATTERN.test(url)) throw Object.assign(new Error('Attachment URL is not allowed'), { status: 400 });
    if (!name || name.length > 256 || /[\u0000-\u001f]/.test(name)) throw Object.assign(new Error('Attachment name is invalid'), { status: 400 });
    if (!ATTACHMENT_MIME_ALLOWLIST.has(contentType)) throw Object.assign(new Error(`Attachment type ${contentType} is not allowed`), { status: 400 });
    if (!Number.isFinite(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('Attachment exceeds the 50 MB limit'), { status: 400 });
    return { url, name, size: Math.round(size), content_type: contentType };
  });
  return JSON.stringify(clean);
}

function cleanData(table: string, input: Record<string, any>) {
  const allowed = tableModels[table].allowed;
  const data: Record<string, any> = {};
  for (const [key, value] of Object.entries(input || {})) {
    const field = toCamel(key);
    if (allowed.includes(field) && value !== undefined) data[field] = value;
  }
  if (table === 'channels' && data.type) data.type = String(data.type).toUpperCase();
  if (table === 'friends' && data.status) data.status = String(data.status).toUpperCase();
  if (table === 'users' && data.status) data.status = String(data.status).toUpperCase();
  if (table === 'messages' || table === 'direct_messages') {
    for (const key of ['attachmentsJson', 'reactionsJson']) {
      const legacy = input?.[toSnake(key)];
      if (typeof legacy === 'string') data[key] = legacy;
    }
  }
  if (table === 'messages' || table === 'direct_messages') {
    data.attachmentsJson = sanitizeAttachments(input?.attachments_json ?? input?.attachmentsJson);
    if (data.content !== undefined) {
      if (typeof data.content !== 'string' || data.content.length > 8000) throw Object.assign(new Error('Message content must be between 1 and 8000 characters'), { status: 400 });
      if (data.content.length === 0 && data.attachmentsJson === '[]') throw Object.assign(new Error('Message content must be between 1 and 8000 characters'), { status: 400 });
    }
  }
  if (table === 'messages' || table === 'direct_messages') {
    try {
      const reactions = JSON.parse(data.reactionsJson || '{}');
      const allowed = new Set(['🚀', '🔥', '👍', '❤️', '🎉', '⚡', '👀', '💯', '✅', '🎧', '🛡️', '💜']);
      if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions) || Object.keys(reactions).some((key) => !allowed.has(key) || !Array.isArray(reactions[key]) || reactions[key].some((id: any) => typeof id !== 'string' || id.length > 64))) throw new Error('bad reactions');
      data.reactionsJson = JSON.stringify(reactions);
    } catch { throw Object.assign(new Error('Invalid reaction payload'), { status: 400 }); }
  }
  if (table === 'direct_messages' && Array.isArray(input?.participant_ids)) data.participantIds = input.participant_ids.map(String);
  return data;
}

async function serverPermission(userId: string, serverId: string, permission: string): Promise<boolean> {
  const row = await prisma.server.findUnique({ where: { id: serverId }, include: { members: { where: { userId }, include: { roles: { include: { permissions: true } } } }, roles: { where: { name: '@everyone' }, include: { permissions: true } } } });
  if (!row) return false;
  if (row.ownerId === userId) return true;
  const member = row.members[0];
  if (!member) return false;
  return [...member.roles, ...row.roles].some((role) => role.permissions.some((p) => p.node === 'ADMINISTRATOR' || p.node === permission));
}
async function requireServerPermission(userId: string, serverId: string, permission: string) {
  if (!await serverPermission(userId, serverId, permission)) throw Object.assign(new Error(`Missing ${permission} permission`), { status: 403 });
}
async function hasBlockedConversationPair(userId: string, participantIds: string[]) {
  const others = participantIds.filter((id) => id !== userId);
  if (!others.length) return false;
  return Boolean(await prisma.friend.findFirst({ where: { status: 'BLOCKED', OR: [
    { userId, friendId: { in: others } }, { friendId: userId, userId: { in: others } }
  ] }, select: { id: true } }));
}
async function refreshMemberVoicePermissions(serverId: string, userId: string) {
  const channels = await prisma.channel.findMany({ where: { serverId }, select: { id: true, type: true } });
  const voiceChannels = channels.filter((channel) => channel.type === 'VOICE');
  const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  let livekitUrl = process.env.LIVEKIT_URL;
  if (livekitUrl && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
    livekitUrl = livekitUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const rooms = new RoomServiceClient(livekitUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await Promise.allSettled(voiceChannels.map((channel) => rooms.removeParticipant(channel.id, userId, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) })));
  }
  const staleSessions = await prisma.voiceSession.findMany({ where: { userId, channelId: { in: channels.map((channel) => channel.id) } }, select: { id: true, channelId: true } });
  await prisma.voiceSession.deleteMany({ where: { id: { in: staleSessions.map((session) => session.id) } } });
  for (const session of staleSessions) io.to(`channel:${session.channelId}`).emit('voice:updated', { channel_id: session.channelId, user_id: userId, removed: true });
  io.to(`user:${userId}`).emit('server:permissions_changed', { server_id: serverId });
}
async function revokeServerMember(serverId: string, userId: string) {
  const channels = await prisma.channel.findMany({ where: { serverId }, select: { id: true } });
  await refreshMemberVoicePermissions(serverId, userId);
  const userSockets = await io.in(`user:${userId}`).fetchSockets();
  for (const socket of userSockets) {
    for (const channel of channels) await socket.leave(`channel:${channel.id}`);
    socket.emit('server:membership_revoked', { server_id: serverId });
  }
}
async function channelContext(channelId: string) {
  return prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, type: true } });
}
/**
 * Full channel visibility check: server-level VIEW_CHANNELS plus private-channel membership.
 * Private channels are enforced here for every read/write path (messages, voice tokens, socket
 * rooms) so frontend restrictions are never the only barrier.
 */
async function canAccessChannel(userId: string, channel: { id: string; serverId: string; isPrivate: boolean } | null): Promise<boolean> {
  if (!channel) return false;
  if (!await serverPermission(userId, channel.serverId, 'VIEW_CHANNELS').catch(() => false)) return false;
  if (!channel.isPrivate) return true;
  // Owners and channel managers always retain access; everyone else needs an explicit grant.
  const privileged = await serverPermission(userId, channel.serverId, 'MANAGE_CHANNELS').catch(() => false);
  if (privileged) return true;
  return Boolean(await prisma.channelAccess.findUnique({ where: { channelId_userId: { channelId: channel.id, userId } }, select: { channelId: true } }));
}
async function checkTableAccess(table: string, userId: string, row: any, operation: 'read' | 'write' | 'delete') {
  if (table === 'users') return operation === 'read' || row?.id === userId;
  if (table === 'servers') return operation === 'read' ? serverPermission(userId, row.id, 'VIEW_CHANNELS') : row.ownerId === userId || serverPermission(userId, row.id, 'MANAGE_SERVER');
  if (table === 'roles') return serverPermission(userId, row.serverId, operation === 'read' ? 'VIEW_CHANNELS' : 'MANAGE_ROLES');
  if (table === 'channels') return canAccessChannel(userId, row);
  if (table === 'server_members') return serverPermission(userId, row.serverId, operation === 'read' ? 'VIEW_CHANNELS' : (row.userId === userId ? 'VIEW_CHANNELS' : 'KICK_MEMBERS'));
  if (table === 'messages') {
    const ctx = row.channelId ? await prisma.channel.findUnique({ where: { id: row.channelId }, select: { id: true, serverId: true, type: true, isPrivate: true } }) : await prisma.message.findUnique({ where: { id: row.id }, select: { channel: { select: { id: true, serverId: true, type: true, isPrivate: true } } } }).then((m) => m?.channel);
    if (!ctx) return false;
    if (operation === 'read') return canAccessChannel(userId, ctx);
    if (operation === 'write') return (await canAccessChannel(userId, ctx)) && await serverPermission(userId, ctx.serverId, 'SEND_MESSAGES');
    return row.userId === userId || serverPermission(userId, ctx.serverId, 'MANAGE_MESSAGES');
  }
  if (table === 'direct_messages') return Array.isArray(row.participantIds) && row.participantIds.includes(userId) && (operation === 'read' || row.senderId === userId);
  if (table === 'friends') return row.userId === userId || row.friendId === userId;
  if (table === 'voice_sessions') {
    const ctx = await channelContext(row.channelId);
    if (!ctx) return false;
    const permitted = await serverPermission(userId, ctx.serverId, operation === 'read' ? 'VIEW_CHANNELS' : 'CONNECT_VOICE');
    if (!permitted) return false;
    if (operation === 'write' && row.userId !== userId && !await serverPermission(userId, ctx.serverId, 'MOVE_MEMBERS')) return false;
    return operation !== 'delete' || row.userId === userId || await serverPermission(userId, ctx.serverId, 'KICK_MEMBERS');
  }
  if (table === 'audit_logs') return serverPermission(userId, row.serverId, 'VIEW_AUDIT_LOG');
  if (table === 'notifications') return row.userId === userId;
  return false;
}

const AVATAR_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/;
/** Validates a client-cropped avatar (max 256 KB after base64 decode) and returns a safe data URL. */
function sanitizeAvatar(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw Object.assign(new Error('Avatar must be an image data URL'), { status: 400 });
  if (value.length > 400_000) throw Object.assign(new Error('Avatar image is too large (max 256 KB)'), { status: 400 });
  const match = value.match(AVATAR_PATTERN);
  if (!match) throw Object.assign(new Error('Avatar must be a PNG, JPEG or WebP image'), { status: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 262_144) throw Object.assign(new Error('Avatar image is too large (max 256 KB)'), { status: 400 });
  const signatureOk = match[1] === 'png'
    ? buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    : match[1] === 'webp'
      ? buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      : buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (!signatureOk) throw Object.assign(new Error('Avatar image content does not match its declared type'), { status: 400 });
  return value;
}
function validateDisplayName(value: unknown) {
  if (typeof value !== 'string') throw Object.assign(new Error('Display name must be text'), { status: 400 });
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) throw Object.assign(new Error('Display name must be 1-64 characters'), { status: 400 });
  return trimmed;
}

function liveKitClientConfig() {
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  const rawUrl = process.env.LIVEKIT_URL?.trim();
  const missingVariables = [!rawUrl && 'LIVEKIT_URL', !apiKey && 'LIVEKIT_API_KEY', !apiSecret && 'LIVEKIT_API_SECRET'].filter((name): name is string => Boolean(name));
  if (missingVariables.length) return { ok: false as const, status: 503, body: { error: 'LiveKit service is not configured', code: 'LIVEKIT_CONFIG_MISSING', missingVariables } };
  let parsedUrl: URL;
  try { parsedUrl = new URL(rawUrl!); } catch { return { ok: false as const, status: 503, body: { error: 'LIVEKIT_URL must be a valid LiveKit server URL', code: 'LIVEKIT_URL_INVALID' } } };
  const isSecure = parsedUrl.protocol === 'wss:' || parsedUrl.protocol === 'https:';
  const isSupported = isSecure || parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'http:';
  if (!isSupported || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/')) {
    return { ok: false as const, status: 503, body: { error: 'LIVEKIT_URL must be a server origin using ws://, wss://, http://, or https:// without credentials or a path', code: 'LIVEKIT_URL_INVALID' } };
  }
  if (process.env.NODE_ENV === 'production' && !isSecure) return { ok: false as const, status: 503, body: { error: 'LIVEKIT_URL must use a secure wss:// or https:// URL in production', code: 'LIVEKIT_URL_INSECURE' } };
  return { ok: true as const, apiKey: apiKey!, apiSecret: apiSecret!, clientUrl: `${isSecure ? 'wss:' : 'ws:'}//${parsedUrl.host}` };
}

async function signLiveKitToken(res: Response, options: { apiKey: string; apiSecret: string; identity: string; name: string; room: string; canSpeak: boolean; canStream: boolean }) {
  const at = new AccessToken(options.apiKey, options.apiSecret, { identity: options.identity, name: options.name, ttl: '30m' });
  const allowedSources: TrackSource[] = [
    ...(options.canSpeak ? [TrackSource.MICROPHONE] : []),
    ...(options.canStream ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [])
  ];
  at.addGrant({ roomJoin: true, room: options.room, canPublish: allowedSources.length > 0, canPublishSources: allowedSources, canSubscribe: true, canPublishData: true });
  try { return await at.toJwt(); }
  catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = [process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, process.env.LIVEKIT_URL]
      .flatMap((value) => value ? [value, value.trim()] : [])
      .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
      .reduce((result, value) => result.split(value).join('[REDACTED]'), message)
      .slice(0, 500);
    const errorId = randomUUID();
    console.error('[LiveKit] token signing failed', { errorId, name: error instanceof Error ? error.constructor.name : 'UnknownError', message: safeMessage });
    res.status(500).json({ error: 'LiveKit token generation failed', code: 'LIVEKIT_TOKEN_ISSUE_FAILED', errorId });
    return null;
  }
}

const registerSchema = z.object({ username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/), display_name: z.string().trim().min(1).max(64), email: z.string().email().max(254), password: z.string().min(12).max(128), avatar_url: z.string().max(400_000).optional() });
app.post('/auth/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const user = await prisma.user.create({ data: { username: input.username.toLowerCase(), displayName: validateDisplayName(input.display_name), email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, Number(process.env.BCRYPT_ROUNDS) || 12), avatarUrl: sanitizeAvatar(input.avatar_url) } });
    res.status(201).json({ accessToken: issueToken(user.id), user: serialize('users', user) });
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'Email or username is already registered' });
    next(error);
  }
});
app.post('/auth/login', async (req, res, next) => {
  try {
    const schema = z.object({ email: z.string().email(), password: z.string().min(1).max(128) });
    const input = schema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !await bcrypt.compare(input.password, user.passwordHash)) return res.status(401).json({ error: 'Invalid email or password' });
    return res.json({ accessToken: issueToken(user.id), user: serialize('users', user) });
  } catch (error) { return next(error); }
});
app.get('/auth/me', auth, async (req: AuthedRequest, res, next) => {
  try { const user = await prisma.user.findUnique({ where: { id: req.userId } }); if (!user) return res.status(401).json({ error: 'Account no longer exists' }); return res.json({ user: serialize('users', user) }); }
  catch (error) { return next(error); }
});
// Sliding-session refresh: an authenticated client can rotate its access token before it
// expires. Long-running voice sessions survive without re-prompting for credentials.
app.post('/auth/refresh', auth, async (req: AuthedRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { id: true } });
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    return res.json({ accessToken: issueToken(user.id) });
  } catch (error) { return next(error); }
});

app.get('/api/health', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ok', service: 'mahyar-gap-api', onlineUsers: onlineUsers.size, connectedSockets: io.engine.clientsCount, uptimeSeconds: Math.round(process.uptime()) }); }
  catch { res.status(503).json({ status: 'degraded', error: 'Database connectivity check failed' }); }
});

app.get('/api/invites/:code', auth, async (req: AuthedRequest, res, next) => {
  try {
    const code = String(req.params.code || '');
    const server = await prisma.server.findUnique({ where: { inviteCode: code } });
    if (server) {
      if (await prisma.ban.findUnique({ where: { serverId_userId: { serverId: server.id, userId: req.userId! } } })) return res.status(403).json({ error: 'You are banned from this server' });
      return res.json({ id: server.id, name: server.name, description: server.description, invite_code: server.inviteCode });
    }
    const invitation = await findValidInvitation(code);
    if (!invitation) return res.status(404).json({ error: 'Invite not found' });
    if (await prisma.ban.findUnique({ where: { serverId_userId: { serverId: invitation.serverId, userId: req.userId! } } })) return res.status(403).json({ error: 'You are banned from this server' });
    return res.json({ id: invitation.server.id, name: invitation.server.name, description: invitation.server.description, invite_code: invitation.code });
  } catch (error) { return next(error); }
});

/** Resolves an Invitation row that is still within its usage limits and lifetime. */
async function findValidInvitation(code: string) {
  const invitation = await prisma.invitation.findUnique({ where: { code }, include: { server: { select: { id: true, name: true, description: true } } } });
  if (!invitation) return null;
  if (invitation.expiresAt && invitation.expiresAt.getTime() < Date.now()) return null;
  if (invitation.maxUses !== null && invitation.uses >= invitation.maxUses) return null;
  return invitation;
}

app.post('/api/servers/join', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(3).max(64) }).parse(req.body);
    let server = await prisma.server.findUnique({ where: { inviteCode: code } });
    let invitation: Awaited<ReturnType<typeof findValidInvitation>> = null;
    if (!server) {
      invitation = await findValidInvitation(code);
      if (!invitation) return res.status(404).json({ error: 'Invite not found' });
      server = await prisma.server.findUnique({ where: { id: invitation.serverId } });
      if (!server) return res.status(404).json({ error: 'Invite not found' });
    }
    if (await prisma.ban.findUnique({ where: { serverId_userId: { serverId: server.id, userId: req.userId! } } })) return res.status(403).json({ error: 'You are banned from this server' });
    const member = await prisma.serverMember.upsert({ where: { serverId_userId: { serverId: server.id, userId: req.userId! } }, update: {}, create: { serverId: server.id, userId: req.userId! } });
    if (invitation) await prisma.invitation.update({ where: { id: invitation.id }, data: { uses: { increment: 1 } } });
    return res.json({ server: { id: server.id, name: server.name, invite_code: server.inviteCode }, member: serialize('server_members', member) });
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------------------
// Invitation management: create with expiry/usage limits, list, revoke.
// ---------------------------------------------------------------------------
app.post('/api/servers/:serverId/invites', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { serverId } = req.params;
    const input = z.object({ max_uses: z.number().int().min(1).max(500).nullable().optional(), expires_in_hours: z.number().min(0.5).max(168).nullable().optional() }).parse(req.body || {});
    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!server) return res.status(404).json({ error: 'Server not found' });
    await requireServerPermission(req.userId!, serverId, 'MANAGE_SERVER');
    const invitation = await prisma.invitation.create({
      data: {
        serverId,
        code: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        maxUses: input.max_uses ?? null,
        expiresAt: input.expires_in_hours ? new Date(Date.now() + input.expires_in_hours * 3_600_000) : null
      }
    });
    return res.status(201).json({ id: invitation.id, code: invitation.code, max_uses: invitation.maxUses, uses: invitation.uses, expires_at: invitation.expiresAt ? invitation.expiresAt.toISOString() : null });
  } catch (error) { return next(error); }
});

app.get('/api/servers/:serverId/invites', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { serverId } = req.params;
    await requireServerPermission(req.userId!, serverId, 'MANAGE_SERVER');
    const invitations = await prisma.invitation.findMany({ where: { serverId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return res.json({ data: invitations.map((invitation) => ({
      id: invitation.id, code: invitation.code, max_uses: invitation.maxUses, uses: invitation.uses,
      expires_at: invitation.expiresAt ? invitation.expiresAt.toISOString() : null,
      created_at: invitation.createdAt.toISOString()
    })) });
  } catch (error) { return next(error); }
});

app.delete('/api/invites/:inviteId', auth, async (req: AuthedRequest, res, next) => {
  try {
    const invitation = await prisma.invitation.findUnique({ where: { id: req.params.inviteId }, select: { id: true, serverId: true } });
    if (!invitation) return res.status(404).json({ error: 'Invite not found' });
    await requireServerPermission(req.userId!, invitation.serverId, 'MANAGE_SERVER');
    await prisma.invitation.delete({ where: { id: invitation.id } });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------------------
// Group DM conversation settings (rename). Conversation metadata lives on every
// row, so the rename is applied to all rows of the conversation and broadcast.
// ---------------------------------------------------------------------------
app.patch('/api/dm/conversations/:conversationId', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { conversationId } = req.params;
    const input = z.object({ group_name: z.string().trim().min(1).max(64) }).parse(req.body);
    const conversation = await prisma.directMessage.findFirst({ where: { conversationId, participantIds: { has: req.userId! }, isGroup: true }, select: { participantIds: true } });
    if (!conversation) return res.status(404).json({ error: 'Group conversation not found' });
    await prisma.directMessage.updateMany({ where: { conversationId }, data: { groupName: input.group_name } });
    for (const participantId of conversation.participantIds) {
      io.to(`user:${participantId}`).emit('direct_message:conversation_updated', { conversation_id: conversationId, group_name: input.group_name });
    }
    return res.json({ conversation_id: conversationId, group_name: input.group_name });
  } catch (error) { return next(error); }
});

app.post('/api/notifications/read-all', auth, async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.notification.updateMany({ where: { userId: req.userId!, read: false }, data: { read: true } });
    return res.json({ updated: result.count });
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------------------
// File attachments. Bytes are streamed straight to an S3-compatible bucket
// (Cloudflare R2 works) and never proxied through the Node process longer than
// necessary, keeping CPU/RAM use low on the small deployment target. When the
// storage environment variables are absent the endpoint fails honestly with 501.
// ---------------------------------------------------------------------------
const FILE_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'application/pdf', 'text/plain'];
const FILE_MAX_BYTES = 52_428_800; // 50 MB
function storageConfig() {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const region = process.env.S3_REGION?.trim() || 'auto';
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || '';
  const ready = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, publicBaseUrl, ready };
}

app.post('/api/files/upload', auth, express.raw({ type: 'application/octet-stream', limit: FILE_MAX_BYTES + 1024 }), async (req: AuthedRequest, res, next) => {
  try {
    const fileName = String(req.query.name || 'file').slice(0, 256).replace(/[\u0000-\u001f]/g, '');
    const contentType = String(req.query.type || '');
    if (!fileName) return res.status(400).json({ error: 'A file name is required (?name=...)' });
    if (!FILE_MIME_ALLOWLIST.includes(contentType)) return res.status(415).json({ error: `Files of type "${contentType || 'unknown'}" are not allowed` });
    const body = req.body as Buffer;
    if (!body || !body.length) return res.status(400).json({ error: 'Request body must be the raw file bytes' });
    if (body.length > FILE_MAX_BYTES) return res.status(413).json({ error: 'Files are limited to 50 MB' });
    const storage = storageConfig();
    if (!storage.ready) {
      return res.status(501).json({
        error: 'Attachment storage is not configured on this deployment; the file was not uploaded.',
        code: 'FILE_STORAGE_NOT_CONFIGURED',
        missingVariables: [
          !storage.endpoint && 'S3_ENDPOINT', !storage.bucket && 'S3_BUCKET',
          !storage.accessKeyId && 'S3_ACCESS_KEY_ID', !storage.secretAccessKey && 'S3_SECRET_ACCESS_KEY'
        ].filter((name): name is string => Boolean(name))
      });
    }
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: storage.region, endpoint: storage.endpoint, credentials: { accessKeyId: storage.accessKeyId!, secretAccessKey: storage.secretAccessKey! } });
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120)}`;
    await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }));
    return res.status(201).json({
      url: storage.publicBaseUrl ? `${storage.publicBaseUrl}/${key}` : `/api/files/${key}`,
      name: fileName, size: body.length, content_type: contentType
    });
  } catch (error) { return next(error); }
});

app.get('/api/files/*', auth, async (req: AuthedRequest, res, next) => {
  try {
    const key = req.params[0] || '';
    if (!key || key.includes('..')) return res.status(400).json({ error: 'Invalid file key' });
    const storage = storageConfig();
    if (!storage.ready) return res.status(501).json({ error: 'Attachment storage is not configured on this deployment.', code: 'FILE_STORAGE_NOT_CONFIGURED' });
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: storage.region, endpoint: storage.endpoint, credentials: { accessKeyId: storage.accessKeyId!, secretAccessKey: storage.secretAccessKey! } });
    const object = await client.send(new GetObjectCommand({ Bucket: storage.bucket!, Key: key }));
    res.setHeader('Content-Type', String(object.ContentType || 'application/octet-stream'));
    res.setHeader('Content-Length', String(object.ContentLength || ''));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (object.Body && typeof (object.Body as any).pipe === 'function') {
      (object.Body as any).pipe(res);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of object.Body as any) chunks.push(Buffer.from(chunk));
      res.end(Buffer.concat(chunks));
    }
  } catch (error: any) {
    if (error?.name === 'NoSuchKey') return res.status(404).json({ error: 'File not found' });
    return next(error);
  }
});
app.post('/api/servers/:serverId/bans', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { userId, reason } = z.object({ userId: z.string().min(1).max(64), reason: z.string().max(500).optional() }).parse(req.body);
    const server = await prisma.server.findUnique({ where: { id: req.params.serverId } });
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.ownerId === userId) return res.status(400).json({ error: 'The server owner cannot be banned' });
    await requireServerPermission(req.userId!, server.id, 'BAN_MEMBERS');
    const ban = await prisma.$transaction(async (tx) => {
      await tx.serverMember.deleteMany({ where: { serverId: server.id, userId } });
      const created = await tx.ban.upsert({ where: { serverId_userId: { serverId: server.id, userId } }, update: { reason }, create: { serverId: server.id, userId, reason } });
      await tx.auditLog.create({ data: { serverId: server.id, actorId: req.userId!, actionType: 'MEMBER_BAN', targetName: userId, details: reason || 'Banned member' } });
      return created;
    });
    await revokeServerMember(server.id, userId);
    return res.status(201).json({ id: ban.id, server_id: ban.serverId, user_id: ban.userId });
  } catch (error) { return next(error); }
});

app.get('/tables/:table', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { table } = req.params; const model = tableModels[table];
    if (!model) return res.status(404).json({ error: 'Unknown resource' });
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
    const page = Math.max(1, Number(req.query.page) || 1);
    const where: any = {};
    if (table === 'users') { /* public profile directory; serializer omits credentials */ }
    else if (table === 'servers') where.OR = [{ ownerId: req.userId }, { members: { some: { userId: req.userId } } }];
    else if (table === 'roles' || table === 'server_members' || table === 'audit_logs') where.server = { members: { some: { userId: req.userId } } };
    else if (table === 'channels') where.server = { members: { some: { userId: req.userId } } };
    else if (table === 'messages') {
      // Scoped fetch: the client requests one channel/conversation at a time with an optional
      // `before` cursor instead of pulling every accessible message into the browser.
      const channelId = typeof req.query.channel_id === 'string' ? req.query.channel_id : '';
      const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 64) : '';
      const before = typeof req.query.before === 'string' ? req.query.before : '';
      if (channelId) {
        const channelRow = await prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, type: true, isPrivate: true } });
        if (!channelRow) return res.status(404).json({ error: 'Channel not found' });
        if (!await canAccessChannel(req.userId!, channelRow)) return res.status(403).json({ error: 'You cannot read this channel' });
        where.channelId = channelId;
      } else {
        where.channel = { server: { members: { some: { userId: req.userId } } } };
      }
      if (search) where.content = { contains: search, mode: 'insensitive' };
      if (before && !Number.isNaN(Date.parse(before))) where.createdAt = { lt: new Date(before) };
    }
    else if (table === 'direct_messages') {
      where.participantIds = { has: req.userId };
      const conversationId = typeof req.query.conversation_id === 'string' ? req.query.conversation_id : '';
      const before = typeof req.query.before === 'string' ? req.query.before : '';
      if (conversationId) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return res.status(400).json({ error: 'Invalid conversation id' });
        where.conversationId = conversationId;
      }
      if (before && !Number.isNaN(Date.parse(before))) where.createdAt = { lt: new Date(before) };
    }
    else if (table === 'friends') where.OR = [{ userId: req.userId }, { friendId: req.userId }];
    else if (table === 'voice_sessions') where.channel = { server: { members: { some: { userId: req.userId } } } };
    else if (table === 'notifications') where.userId = req.userId;
    const include: any = table === 'roles' ? { permissions: true } : table === 'server_members' ? { roles: true } : table === 'messages' ? { author: true, channel: true } : table === 'direct_messages' ? { sender: true } : table === 'voice_sessions' ? { channel: { select: { serverId: true } } } : undefined;
    const orderByField = tableOrderFields[table];
    const rows = await model.delegate.findMany({ where, include, orderBy: { [orderByField]: 'desc' }, take: limit, skip: (page - 1) * limit });
    const visible = [];
    for (const row of rows) if (await checkTableAccess(table, req.userId!, row, 'read')) visible.push(serialize(table, row));
    // checkTableAccess('channels') routes through canAccessChannel, so private channels without
    // an explicit grant never reach the member's channel list in the first place.
    return res.json({ data: visible, page, limit });
  } catch (error) { return next(error); }
});
app.get('/tables/:table/:id', auth, async (req: AuthedRequest, res, next) => {
  try {
    const model = tableModels[req.params.table]; if (!model) return res.status(404).json({ error: 'Unknown resource' });
    const include: any = req.params.table === 'roles' ? { permissions: true } : req.params.table === 'server_members' ? { roles: true } : req.params.table === 'messages' ? { author: true, channel: true } : req.params.table === 'direct_messages' ? { sender: true } : undefined;
    const row = await model.delegate.findUnique({ where: { id: req.params.id }, include });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!await checkTableAccess(req.params.table, req.userId!, row, 'read')) return res.status(403).json({ error: 'Forbidden' });
    return res.json(serialize(req.params.table, row));
  } catch (error) { return next(error); }
});
app.post('/tables/:table', auth, async (req: AuthedRequest, res, next) => {
  try {
    const table = req.params.table; const model = tableModels[table];
    if (!model || table === 'users') return res.status(404).json({ error: 'Unknown or restricted resource' });
    const data = cleanData(table, req.body);
    if (table === 'messages') {
      const channelRow = await prisma.channel.findUnique({ where: { id: String(data.channelId || '') }, select: { id: true, serverId: true, type: true, isPrivate: true } });
      if (!channelRow) return res.status(404).json({ error: 'Channel not found' });
      if (!await canAccessChannel(req.userId!, channelRow)) return res.status(403).json({ error: 'You cannot send messages in this channel' });
      await requireServerPermission(req.userId!, channelRow.serverId, 'SEND_MESSAGES');
      data.userId = req.userId; data.channelId = channelRow.id;
      if (req.body.reply_to_id) data.replyToId = String(req.body.reply_to_id);
      if (typeof data.content !== 'string') {
        if (data.attachmentsJson && data.attachmentsJson !== '[]') data.content = '';
        else return res.status(400).json({ error: 'Message content must be between 1 and 8000 characters' });
      }
    } else if (table === 'servers') {
      data.ownerId = req.userId; data.inviteCode = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    } else if (table === 'channels' || table === 'roles') {
      if (table === 'roles' && String(data.name || '').trim().toLowerCase() === '@everyone') return res.status(400).json({ error: 'The @everyone role name is reserved' });
      await requireServerPermission(req.userId!, String(data.serverId), table === 'channels' ? 'MANAGE_CHANNELS' : 'MANAGE_ROLES');
    } else if (table === 'server_members') {
      const server = await prisma.server.findUnique({ where: { id: String(data.serverId) } });
      if (!server) return res.status(404).json({ error: 'Server not found' });
      if (data.userId !== req.userId) await requireServerPermission(req.userId!, server.id, 'MANAGE_SERVER');
      else if (req.body.invite_code !== server.inviteCode && server.ownerId !== req.userId) return res.status(403).json({ error: 'A valid invite code is required' });
      data.userId = data.userId === req.userId ? req.userId : data.userId;
    } else if (table === 'direct_messages') {
      const participants = Array.isArray(req.body.participant_ids) ? req.body.participant_ids.map(String) : [];
      const uniqueParticipants: string[] = [...new Set<string>(participants)];
      if (!uniqueParticipants.includes(req.userId!) || uniqueParticipants.length < 2 || uniqueParticipants.length > 50) return res.status(403).json({ error: 'Conversation must include the sender and 1-49 other users' });
      if (Boolean(data.isGroup) !== (uniqueParticipants.length > 2)) return res.status(400).json({ error: 'Group status must match the participant count' });
      if (await hasBlockedConversationPair(req.userId!, uniqueParticipants)) return res.status(403).json({ error: 'A blocked relationship prevents this direct message' });
      const existingUsers = await prisma.user.findMany({ where: { id: { in: uniqueParticipants } }, select: { id: true } });
      if (existingUsers.length !== uniqueParticipants.length) return res.status(400).json({ error: 'A conversation participant does not exist' });
      const conversationId = String(data.conversationId || '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return res.status(400).json({ error: 'Invalid conversation id' });
      const priorMessage = await prisma.directMessage.findFirst({ where: { conversationId }, select: { participantIds: true } });
      if (priorMessage) {
        const original = [...priorMessage.participantIds].sort();
        const incoming = [...uniqueParticipants].sort();
        if (original.length !== incoming.length || original.some((id, index) => id !== incoming[index])) return res.status(409).json({ error: 'Conversation participants cannot be changed' });
      }
      data.participantIds = uniqueParticipants; data.senderId = req.userId;
      if (typeof data.content !== 'string') {
        if (data.attachmentsJson && data.attachmentsJson !== '[]') data.content = '';
        else return res.status(400).json({ error: 'Message content must be between 1 and 8000 characters' });
      }
    } else if (table === 'friends') {
      if (data.userId !== req.userId) return res.status(403).json({ error: 'Friend request must be created by the current user' });
      if (!data.friendId || data.friendId === req.userId || !await prisma.user.findUnique({ where: { id: String(data.friendId) }, select: { id: true } })) return res.status(400).json({ error: 'Invalid friend target' });
      if (await prisma.friend.findFirst({ where: { OR: [{ userId: req.userId!, friendId: String(data.friendId) }, { userId: String(data.friendId), friendId: req.userId! }] }, select: { id: true } })) return res.status(409).json({ error: 'A friend request or connection already exists' });
      data.status = 'PENDING';
    } else if (table === 'voice_sessions') {
      const channelRow = await prisma.channel.findUnique({ where: { id: String(data.channelId || '') }, select: { id: true, serverId: true, type: true, isPrivate: true } });
      if (!channelRow || channelRow.type !== 'VOICE') return res.status(404).json({ error: 'Voice channel not found' });
      if (!await canAccessChannel(req.userId!, channelRow)) return res.status(403).json({ error: 'You cannot join this voice channel' });
      await requireServerPermission(req.userId!, channelRow.serverId, 'CONNECT_VOICE'); data.userId = req.userId;
    } else if (table === 'audit_logs') {
      await requireServerPermission(req.userId!, String(data.serverId), 'MANAGE_SERVER'); data.actorId = req.userId;
    } else if (table === 'notifications') return res.status(403).json({ error: 'Notifications are system-managed' });
    if (req.body.id) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(req.body.id))) return res.status(400).json({ error: 'Invalid identifier' });
      data.id = String(req.body.id);
    }
    if (table === 'roles' && Array.isArray(req.body.permissions)) {
      const nodes = req.body.permissions.map(String);
      const known = new Set(['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'STREAM_VIDEO', 'VIEW_CHANNELS', 'VIEW_AUDIT_LOG', 'MOVE_MEMBERS']);
      if (nodes.some((node: string) => !known.has(node))) return res.status(400).json({ error: 'Unknown permission node' });
      const owner = await prisma.server.findUnique({ where: { id: String(data.serverId) }, select: { ownerId: true } });
      const privileged = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MOVE_MEMBERS', 'VIEW_AUDIT_LOG', 'STREAM_VIDEO'];
      if (!owner || owner.ownerId !== req.userId && nodes.some((node: string) => privileged.includes(node))) return res.status(403).json({ error: 'Only the server owner may grant privileged permissions' });
      data.permissions = { create: nodes.map((node: string) => ({ node })) };
    }
    if (table === 'server_members' && Array.isArray(req.body.role_ids)) {
      const roleIds = req.body.role_ids.map(String);
      const server = await prisma.server.findUnique({ where: { id: String(data.serverId) }, select: { id: true, ownerId: true } });
      const mayAssign = data.userId !== req.userId || server?.ownerId === req.userId;
      if (!mayAssign && roleIds.length) return res.status(403).json({ error: 'Members cannot assign roles to themselves' });
      if (roleIds.length) {
        const matching = await prisma.role.findMany({ where: { id: { in: roleIds }, serverId: String(data.serverId) }, select: { id: true } });
        if (matching.length !== roleIds.length) return res.status(400).json({ error: 'A role does not belong to this server' });
        data.roles = { connect: roleIds.map((id: string) => ({ id })) };
      }
    }
    if (table === 'servers') {
      const created = await prisma.$transaction(async (tx) => {
        const server = await tx.server.create({ data: data as Prisma.ServerUncheckedCreateInput });
        await tx.role.create({ data: { serverId: server.id, name: '@everyone', color: '#99AAB5', position: 0, permissions: { create: ['VIEW_CHANNELS', 'SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE'].map((node) => ({ node })) } } });
        // The owner is a member from the very first moment; relying on the client to create
        // this row left fresh servers with an invisible owner in member listings.
        await tx.serverMember.create({ data: { serverId: server.id, userId: req.userId! } });
        // Default channels are part of the server itself so every client sees a usable space
        // immediately, even if the creating tab closes mid-setup.
        await tx.channel.createMany({ data: [
          { serverId: server.id, name: 'general', category: 'TEXT CHANNELS', type: 'TEXT', topic: 'General discussion', position: 1 },
          { serverId: server.id, name: 'General Voice', category: 'VOICE CHANNELS', type: 'VOICE', topic: 'Voice, video and screen sharing', position: 2 }
        ] });
        return server;
      });
      return res.status(201).json(serialize(table, created));
    }
    const row = await model.delegate.create({ data, include: table === 'roles' ? { permissions: true } : table === 'server_members' ? { roles: true } : table === 'messages' ? { author: true, channel: true } : undefined }).catch(async (error: any) => {
      // Two devices joining the same voice channel race on the unique [channelId, userId];
      // treat the conflict as an update so the second device does not error out.
      if (table === 'voice_sessions' && error?.code === 'P2002') {
        return model.delegate.update({ where: { channelId_userId: { channelId: data.channelId, userId: data.userId } }, data });
      }
      throw error;
    });
    if (table === 'channels' && data.isPrivate) {
      const accessIds = [...new Set<string>((Array.isArray(req.body.access_user_ids) ? req.body.access_user_ids : []).map((id: unknown) => String(id)))];
      const grants = accessIds.filter((id: string) => id !== req.userId);
      if (grants.length) {
        await prisma.channelAccess.createMany({ data: grants.map((userId: string) => ({ channelId: row.id, userId })), skipDuplicates: true });
      }
    }
    if (table === 'messages') {
      // Mentions become real, persisted notifications (mentioned users + @everyone members).
      const mentionIds = Array.isArray(req.body.mentions) ? [...new Set<string>(req.body.mentions.map((id: unknown) => String(id)))] : [];
      const targets = new Set<string>();
      const knownUsers = mentionIds.length ? await prisma.user.findMany({ where: { id: { in: mentionIds.filter((id: string) => id !== '@everyone') } }, select: { id: true } }) : [];
      knownUsers.forEach((user) => { if (user.id !== req.userId) targets.add(user.id); });
      if (mentionIds.includes('@everyone')) {
        const members = await prisma.serverMember.findMany({ where: { serverId: row.channel.serverId, userId: { not: req.userId! } }, select: { userId: true } });
        members.forEach((member) => targets.add(member.userId));
      }
      for (const targetId of targets) {
        const notification = await prisma.notification.create({ data: { userId: targetId, title: `${row.author.displayName} mentioned you`, body: (row.content || '(attachment)').slice(0, 180), type: 'mention' } });
        io.to(`user:${targetId}`).emit('notification:new', serialize('notifications', notification));
      }
    }
    if (table === 'friends') {
      const requester = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
      const notification = await prisma.notification.create({ data: { userId: String(data.friendId), title: `${requester?.displayName || 'Someone'} sent you a friend request`, body: 'Open the Friends tab to accept or ignore it.', type: 'friend_request' } });
      io.to(`user:${String(data.friendId)}`).emit('notification:new', serialize('notifications', notification));
    }
    const result = serialize(table, row);
    if (table === 'messages') io.to(`channel:${row.channelId}`).emit('message:new', result);
    if (table === 'voice_sessions') {
      const serverId = row.channel?.serverId;
      io.to(`channel:${row.channelId}`).emit('voice:updated', result);
      if (serverId) io.to(`server:${serverId}`).emit('voice:updated', result);
    }
    if (table === 'direct_messages') for (const participantId of row.participantIds) io.to(`user:${participantId}`).emit('direct_message:new', result);
    return res.status(201).json(result);
  } catch (error) { return next(error); }
});
app.patch('/tables/:table/:id', auth, async (req: AuthedRequest, res, next) => {
  try {
    const table = req.params.table; const model = tableModels[table];
    if (!model || table === 'users' && req.params.id !== req.userId) return res.status(404).json({ error: 'Unknown resource' });
    if (table === 'audit_logs') return res.status(403).json({ error: 'Audit log records are append-only' });
    const include: any = table === 'roles' ? { permissions: true } : table === 'server_members' ? { roles: true } : table === 'messages' ? { author: true, channel: true } : table === 'direct_messages' ? { sender: true } : table === 'voice_sessions' ? { channel: { select: { serverId: true } } } : undefined;
    const old = await model.delegate.findUnique({ where: { id: req.params.id }, include });
    if (!old) return res.status(404).json({ error: 'Not found' });
    // A patch that only touches the reaction map must stay possible for every participant,
    // otherwise reacting to someone else's message would require MANAGE_MESSAGES.
    const bodyKeys = Object.keys(req.body || {});
    const reactionOnlyPatch = (table === 'messages' || table === 'direct_messages') && bodyKeys.length > 0 && bodyKeys.every((key) => key === 'reactions_json' || key === 'reactionsJson');
    if (reactionOnlyPatch) {
      if (table === 'messages') {
        const writable = old.channel && await canAccessChannel(req.userId!, old.channel) && await serverPermission(req.userId!, old.channel.serverId, 'SEND_MESSAGES');
        if (!writable) return res.status(403).json({ error: 'Forbidden' });
      } else {
        const writable = Array.isArray(old.participantIds) && old.participantIds.includes(req.userId!) && !await hasBlockedConversationPair(req.userId!, old.participantIds);
        if (!writable) return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (table === 'server_members' && Array.isArray(req.body.role_ids)) {
      await requireServerPermission(req.userId!, old.serverId, 'MANAGE_ROLES');
      const server = await prisma.server.findUnique({ where: { id: old.serverId }, select: { ownerId: true } });
      if (old.userId === server?.ownerId) return res.status(403).json({ error: 'The server owner role assignment cannot be changed here' });
    } else if (!reactionOnlyPatch && !await checkTableAccess(table, req.userId!, old, 'write')) return res.status(403).json({ error: 'Forbidden' });
    if (table === 'direct_messages' && !reactionOnlyPatch && old.senderId === req.userId && await hasBlockedConversationPair(req.userId!, old.participantIds)) return res.status(403).json({ error: 'A blocked relationship prevents this direct message' });
    if (table === 'friends' && String(req.body.status || '').toLowerCase() === 'accepted' && old.friendId !== req.userId) return res.status(403).json({ error: 'Only the recipient may accept a friend request' });
    if (table === 'messages' && !reactionOnlyPatch && old.userId !== req.userId) {
      const serverId = old.channel.serverId; await requireServerPermission(req.userId!, serverId, 'MANAGE_MESSAGES');
    }
    const data = cleanData(table, req.body);
    for (const key of ['ownerId', 'userId', 'senderId', 'actorId', 'serverId', 'channelId', 'participantIds']) delete data[key];
    if (table === 'users' && 'avatarUrl' in data) data.avatarUrl = sanitizeAvatar(data.avatarUrl);
    if (table === 'users' && 'displayName' in data) data.displayName = validateDisplayName(data.displayName);
    if (table === 'server_members' && Array.isArray(req.body.role_ids)) {
      const roleIds: string[] = [...new Set((req.body.role_ids as unknown[]).map(String))];
      const server = await prisma.server.findUnique({ where: { id: old.serverId }, select: { ownerId: true } });
      const roles = await prisma.role.findMany({ where: { id: { in: roleIds }, serverId: old.serverId }, select: { id: true } });
      const rolePermissions = await prisma.permission.findMany({ where: { roleId: { in: roleIds } }, select: { roleId: true, node: true } });
      if (roles.length !== roleIds.length) return res.status(400).json({ error: 'A role does not belong to this server' });
      const privileged = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MOVE_MEMBERS', 'VIEW_AUDIT_LOG', 'STREAM_VIDEO'];
      if (server?.ownerId !== req.userId && rolePermissions.some((permission) => roleIds.includes(permission.roleId) && privileged.includes(permission.node))) return res.status(403).json({ error: 'Only the server owner may assign privileged roles' });
      data.roles = { set: roleIds.map((id) => ({ id })) };
    }
    if (table === 'roles' && String(data.name || '').trim().toLowerCase() === '@everyone') return res.status(400).json({ error: 'The @everyone role name is reserved' });
    if (table === 'roles' && Array.isArray(req.body.permissions)) {
      const nodes = req.body.permissions.map(String);
      const known = new Set(['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'STREAM_VIDEO', 'VIEW_CHANNELS', 'VIEW_AUDIT_LOG', 'MOVE_MEMBERS']);
      if (nodes.some((node: string) => !known.has(node))) return res.status(400).json({ error: 'Unknown permission node' });
      const owner = await prisma.server.findUnique({ where: { id: old.serverId }, select: { ownerId: true } });
      const privileged = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MOVE_MEMBERS', 'VIEW_AUDIT_LOG', 'STREAM_VIDEO'];
      if (!owner || owner.ownerId !== req.userId && nodes.some((node: string) => privileged.includes(node))) return res.status(403).json({ error: 'Only the server owner may grant privileged permissions' });
      data.permissions = { deleteMany: {}, create: nodes.map((node: string) => ({ node })) };
    }
    const row = await model.delegate.update({ where: { id: req.params.id }, data, include });
    if (table === 'channels' && 'isPrivate' in data) {
      const accessIds = [...new Set<string>((Array.isArray(req.body.access_user_ids) ? req.body.access_user_ids : []).map((id: unknown) => String(id)))];
      if (req.body.access_user_ids !== undefined) {
        await prisma.channelAccess.deleteMany({ where: { channelId: row.id } });
        const grants = accessIds.filter((id: string) => id !== req.userId);
        if (grants.length) await prisma.channelAccess.createMany({ data: grants.map((userId: string) => ({ channelId: row.id, userId })), skipDuplicates: true });
      }
    }
    if (table === 'server_members' && Array.isArray(req.body.role_ids)) await refreshMemberVoicePermissions(row.serverId, row.userId);
    if (table === 'roles' && Array.isArray(req.body.permissions)) {
      const members = await prisma.serverMember.findMany({ where: { serverId: row.serverId, roles: { some: { id: row.id } } }, select: { userId: true } });
      await Promise.allSettled(members.map((member) => refreshMemberVoicePermissions(row.serverId, member.userId)));
    }
    if (table === 'voice_sessions') {
      io.to(`channel:${row.channelId}`).emit('voice:updated', serialize(table, row));
      if (row.channel?.serverId) io.to(`server:${row.channel.serverId}`).emit('voice:updated', serialize(table, row));
    }
    if (table === 'messages') io.to(`channel:${row.channelId}`).emit('message:updated', serialize(table, row));
    if (table === 'direct_messages') for (const participantId of row.participantIds) io.to(`user:${participantId}`).emit('direct_message:updated', serialize(table, row));
    return res.json(serialize(table, row));
  } catch (error) { return next(error); }
});
app.delete('/tables/:table/:id', auth, async (req: AuthedRequest, res, next) => {
  try {
    const table = req.params.table; const model = tableModels[table];
    if (!model || table === 'users') return res.status(404).json({ error: 'Unknown resource' });
    if (table === 'audit_logs') return res.status(403).json({ error: 'Audit log records are append-only' });
    const row = await model.delegate.findUnique({ where: { id: req.params.id }, include: table === 'messages' ? { channel: true } : table === 'voice_sessions' ? { channel: { select: { serverId: true } } } : undefined });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (table === 'roles' && row.name === '@everyone') return res.status(403).json({ error: 'The @everyone role cannot be deleted' });
    if (table === 'server_members' && row.userId === req.userId) {
      const server = await prisma.server.findUnique({ where: { id: row.serverId }, select: { ownerId: true } });
      if (server?.ownerId === req.userId) return res.status(403).json({ error: 'The server owner cannot leave without transferring ownership' });
    }
    if (!await checkTableAccess(table, req.userId!, row, 'delete')) return res.status(403).json({ error: 'Forbidden' });
    if (table === 'servers' && row.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner may delete a server' });
    if (table === 'channels') await requireServerPermission(req.userId!, row.serverId, 'MANAGE_CHANNELS');
    if (table === 'roles') await requireServerPermission(req.userId!, row.serverId, 'MANAGE_ROLES');
    const roleMembers = table === 'roles' ? await prisma.serverMember.findMany({ where: { serverId: row.serverId, roles: { some: { id: row.id } } }, select: { userId: true } }) : [];
    await model.delegate.delete({ where: { id: req.params.id } });
    if (table === 'roles') await Promise.allSettled(roleMembers.map((member) => refreshMemberVoicePermissions(row.serverId, member.userId)));
    if (table === 'server_members') await revokeServerMember(row.serverId, row.userId);
    if (table === 'voice_sessions') {
      io.to(`channel:${row.channelId}`).emit('voice:updated', { channel_id: row.channelId, user_id: row.userId, removed: true });
      if (row.channel?.serverId) io.to(`server:${row.channel.serverId}`).emit('voice:updated', { channel_id: row.channelId, user_id: row.userId, removed: true });
    }
    if (table === 'messages') io.to(`channel:${row.channelId}`).emit('message:deleted', { id: row.id, channel_id: row.channelId });
    if (table === 'direct_messages') for (const participantId of row.participantIds) io.to(`user:${participantId}`).emit('direct_message:deleted', { id: row.id, conversation_id: row.conversationId });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

app.post('/api/voice/token', auth, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({ channelId: z.string().min(1) }).parse(req.body);
    const channel = await prisma.channel.findUnique({ where: { id: input.channelId }, include: { server: true } });
    if (!channel || channel.type !== 'VOICE') return res.status(404).json({ error: 'Voice channel not found' });
    if (!await canAccessChannel(req.userId!, channel)) return res.status(403).json({ error: 'You cannot join this voice channel' });
    await requireServerPermission(req.userId!, channel.serverId, 'CONNECT_VOICE');
    const canSpeak = await serverPermission(req.userId!, channel.serverId, 'SPEAK_VOICE');
    const canStream = await serverPermission(req.userId!, channel.serverId, 'STREAM_VIDEO');
    const apiKey = process.env.LIVEKIT_API_KEY?.trim();
    const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
    const rawUrl = process.env.LIVEKIT_URL?.trim();
    const missingVariables = [
      !rawUrl && 'LIVEKIT_URL',
      !apiKey && 'LIVEKIT_API_KEY',
      !apiSecret && 'LIVEKIT_API_SECRET'
    ].filter((name): name is string => Boolean(name));
    if (missingVariables.length) {
      console.error('[LiveKit] token configuration incomplete', { missingVariables });
      return res.status(503).json({ error: 'LiveKit service is not configured', code: 'LIVEKIT_CONFIG_MISSING', missingVariables });
    }

    let parsedUrl: URL;
    try { parsedUrl = new URL(rawUrl!); }
    catch { return res.status(503).json({ error: 'LIVEKIT_URL must be a valid LiveKit server URL', code: 'LIVEKIT_URL_INVALID' }); }
    const isSecure = parsedUrl.protocol === 'wss:' || parsedUrl.protocol === 'https:';
    const isSupportedProtocol = isSecure || parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'http:';
    if (!isSupportedProtocol || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/')) {
      return res.status(503).json({ error: 'LIVEKIT_URL must be a server origin using ws://, wss://, http://, or https:// without credentials or a path', code: 'LIVEKIT_URL_INVALID' });
    }
    if (process.env.NODE_ENV === 'production' && !isSecure) {
      return res.status(503).json({ error: 'LIVEKIT_URL must use a secure wss:// or https:// URL in production', code: 'LIVEKIT_URL_INSECURE' });
    }
    const authority = parsedUrl.host;
    const clientUrl = `${isSecure ? 'wss:' : 'ws:'}//${authority}`;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const at = new AccessToken(apiKey, apiSecret, { identity: user.id, name: user.displayName, ttl: '30m' });
    const allowedSources: TrackSource[] = [
      ...(canSpeak ? [TrackSource.MICROPHONE] : []),
      ...(canStream ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [])
    ];
    at.addGrant({ roomJoin: true, room: channel.id, canPublish: allowedSources.length > 0, canPublishSources: allowedSources, canSubscribe: true, canPublishData: true });
    let token: string;
    try { token = await at.toJwt(); }
    catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = [process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, process.env.LIVEKIT_URL]
        .flatMap((value) => value ? [value, value.trim()] : [])
        .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
        .reduce((result, value) => result.split(value).join('[REDACTED]'), message)
        .slice(0, 500);
      const errorId = randomUUID();
      console.error('[LiveKit] token signing failed', { errorId, name: error instanceof Error ? error.constructor.name : 'UnknownError', message: safeMessage });
      return res.status(500).json({ error: 'LiveKit token generation failed', code: 'LIVEKIT_TOKEN_ISSUE_FAILED', errorId });
    }
    return res.json({ token, url: clientUrl, permissions: { canSpeak, canStream } });
  } catch (error) { return next(error); }
});

app.post('/api/dm/call-token', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { conversationId } = z.object({ conversationId: z.string().min(1).max(128) }).parse(req.body);
    const conversation = await prisma.directMessage.findFirst({ where: { conversationId, participantIds: { has: req.userId! } }, select: { participantIds: true } });
    if (!conversation) return res.status(403).json({ error: 'You are not part of this conversation' });
    if (await hasBlockedConversationPair(req.userId!, conversation.participantIds)) return res.status(403).json({ error: 'A blocked relationship prevents this call' });
    const config = liveKitClientConfig();
    if (!config.ok) return res.status(config.status).json(config.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const room = `dm_${conversationId}`.slice(0, 120);
    const token = await signLiveKitToken(res, {
      apiKey: config.apiKey, apiSecret: config.apiSecret, identity: user.id, name: user.displayName,
      room, canSpeak: true, canStream: true
    });
    if (!token) return;
    for (const participantId of conversation.participantIds) {
      if (participantId === req.userId) continue;
      io.to(`user:${participantId}`).emit('dm:call_started', { conversationId, startedBy: req.userId });
      const caller = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
      const notification = await prisma.notification.create({ data: { userId: participantId, title: `Incoming call from ${caller?.displayName || 'a friend'}`, body: 'Open the conversation to join the call.', type: 'dm_call' } });
      io.to(`user:${participantId}`).emit('notification:new', serialize('notifications', notification));
    }
    return res.json({ token, url: config.clientUrl, room, participantIds: conversation.participantIds });
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------------------
// Mahyar Music — real Discord-style music bot over LiveKit.
// Registered before socket middleware so its handlers attach on every connection.
// ---------------------------------------------------------------------------
const musicSystem = registerMusicSystem({
  app, io, prisma, auth,
  canAccessChannel,
  serverPermission,
  requireServerPermission,
  liveKit: liveKitClientConfig()
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string') return next(new Error('Authentication required'));
  try { const decoded = jwt.verify(token, jwtSecret) as JwtPayload; if (typeof decoded.sub !== 'string' || typeof decoded.exp !== 'number') throw new Error('bad subject'); socket.data.userId = decoded.sub; socket.data.expiresAt = decoded.exp * 1000; next(); }
  catch { next(new Error('Invalid or expired token')); }
});
io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  onlineUsers.set(socket.data.userId, (onlineUsers.get(socket.data.userId) || 0) + 1);
  broadcastPresence();
  const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
  expiryTimer.unref();
  socket.on('disconnect', async () => {
    clearTimeout(expiryTimer);
    const remaining = (onlineUsers.get(socket.data.userId) || 1) - 1;
    if (remaining > 0) onlineUsers.set(socket.data.userId, remaining);
    else onlineUsers.delete(socket.data.userId);
    broadcastPresence();
    // When the last socket of a user disappears (tab closed, crash, network drop), their voice
    // session rows are stale by definition: LiveKit drops the peer but nothing deletes the row.
    // Clean them up here so ghost participants never linger in the channel sidebar.
    if (remaining <= 0) {
      try {
        const stale = await prisma.voiceSession.findMany({ where: { userId: socket.data.userId }, select: { id: true, channelId: true, channel: { select: { serverId: true } } } });
        if (stale.length) {
          await prisma.voiceSession.deleteMany({ where: { id: { in: stale.map((session) => session.id) } } });
          for (const session of stale) {
            const payload = { channel_id: session.channelId, user_id: socket.data.userId, removed: true };
            io.to(`channel:${session.channelId}`).emit('voice:updated', payload);
            if (session.channel?.serverId) io.to(`server:${session.channel.serverId}`).emit('voice:updated', payload);
          }
        }
      } catch (error) { console.error('Voice session cleanup failed:', error); }
    }
  });
  let eventStart = Date.now(), eventCount = 0;
  socket.use((_packet, next) => {
    if (Date.now() - eventStart > 10_000) { eventStart = Date.now(); eventCount = 0; }
    eventCount += 1;
    next(eventCount > 60 ? new Error('Socket event rate limit exceeded') : undefined);
  });
  socket.on('server:join', async (serverId: string, ack?: (result: any) => void) => {
    const ok = await serverPermission(socket.data.userId, String(serverId), 'VIEW_CHANNELS').catch(() => false);
    if (!ok) return ack?.({ error: 'Forbidden' });
    socket.join(`server:${serverId}`); ack?.({ ok: true });
  });
  socket.on('channel:join', async (channelId: string, ack?: (result: any) => void) => {
    const channel = await prisma.channel.findUnique({ where: { id: String(channelId) }, select: { id: true, serverId: true, type: true, isPrivate: true } }).catch(() => null);
    const ok = channel && await canAccessChannel(socket.data.userId, channel).catch(() => false);
    if (!ok) return ack?.({ error: 'Forbidden' });
    socket.join(`channel:${channelId}`); ack?.({ ok: true });
  });
  socket.on('server:leave', (serverId: string) => socket.leave(`server:${String(serverId)}`));
  socket.on('channel:leave', (channelId: string) => socket.leave(`channel:${String(channelId)}`));
  socket.on('typing:start', async ({ channelId }: { channelId: string }, ack?: (result: any) => void) => {
    const channel = await prisma.channel.findUnique({ where: { id: String(channelId) }, select: { id: true, serverId: true, type: true, isPrivate: true } }).catch(() => null);
    const ok = channel && await canAccessChannel(socket.data.userId, channel).catch(() => false);
    if (!ok) return ack?.({ error: 'Forbidden' });
    socket.to(`channel:${channelId}`).emit('typing:update', { channelId, userId: socket.data.userId, isTyping: true }); ack?.({ ok: true });
  });
  socket.on('dm:typing', async ({ conversationId }: { conversationId: string }, ack?: (result: any) => void) => {
    const conversation = await prisma.directMessage.findFirst({ where: { conversationId: String(conversationId), participantIds: { has: socket.data.userId } }, select: { participantIds: true } }).catch(() => null);
    if (!conversation) return ack?.({ error: 'Forbidden' });
    for (const participantId of conversation.participantIds) {
      if (participantId !== socket.data.userId) io.to(`user:${participantId}`).emit('dm:typing', { conversationId, userId: socket.data.userId });
    }
    ack?.({ ok: true });
  });
  socket.on('dm:call_ended', async ({ conversationId }: { conversationId: string }) => {
    const conversation = await prisma.directMessage.findFirst({ where: { conversationId: String(conversationId), participantIds: { has: socket.data.userId } }, select: { participantIds: true } }).catch(() => null);
    if (!conversation) return;
    for (const participantId of conversation.participantIds) {
      if (participantId !== socket.data.userId) io.to(`user:${participantId}`).emit('dm:call_ended', { conversationId });
    }
  });
});

// Serve only known static assets; an unknown API route must never fall through to index.html.
const rootDir = path.resolve(process.cwd());
// Asset URLs are not content-hashed, so they must revalidate on every load: a long max-age
// would keep serving the previous deploy's CSS/JS until the cache expired. ETag +
// Last-Modified still answer unchanged files with a cheap 304.
const revalidatingAssets = { fallthrough: false, maxAge: 0, etag: true, lastModified: true } as const;
app.use('/css', express.static(path.join(rootDir, 'css'), revalidatingAssets));
app.use('/js', express.static(path.join(rootDir, 'js'), revalidatingAssets));
app.use('/vendor', express.static(path.join(rootDir, 'public/vendor'), { fallthrough: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use('/landing', express.static(path.join(rootDir, 'public', 'landing'), revalidatingAssets));
app.get('/favicon.ico', (_req, res, next) => res.sendFile(path.join(rootDir, 'favicon.ico'), (error) => error && next(error)));
app.get('/favicon.svg', (_req, res, next) => res.sendFile(path.join(rootDir, 'favicon.svg'), { headers: { 'Content-Type': 'image/svg+xml' } }, (error) => error && next(error)));

// ---------------------------------------------------------------------------
// Public landing page (Persian default, English secondary) and the app itself.
// Visitors land on the marketing site; the authenticated workspace lives at /app.
// ---------------------------------------------------------------------------
const landingFile = (lang: 'fa' | 'en') => path.join(rootDir, 'public', 'landing', lang === 'fa' ? 'fa.html' : 'en.html');
const sendLanding = (lang: 'fa' | 'en') => (_req: Request, res: Response, next: NextFunction) =>
  res.sendFile(landingFile(lang), (error) => error && next(error));

app.get('/', (req, res) => {
  // Honor the visitor's persisted language choice (cookie set by the landing page);
  // Persian is the product default.
  const cookieMatch = /(?:^|;\s*)mahyar_lang=(en|fa)(?:;|$)/.exec(String(req.headers.cookie || ''));
  return res.redirect(302, cookieMatch?.[1] === 'en' ? '/en' : '/fa');
});
app.get('/fa', sendLanding('fa'));
app.get('/en', sendLanding('en'));
// Per-language legal pages (privacy, terms) live next to the landing files.
app.use('/fa', express.static(path.join(rootDir, 'public', 'landing', 'fa'), revalidatingAssets));
app.use('/en', express.static(path.join(rootDir, 'public', 'landing', 'en'), revalidatingAssets));
app.get('/app', (_req, res, next) => res.sendFile(path.join(rootDir, 'index.html'), (error) => error && next(error)));

app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/tables/') || req.path.startsWith('/files/')) return res.status(404).json({ error: 'Route not found' });
  return res.status(404).type('text').send('Not found');
});
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', details: error.issues.map((i) => ({ path: i.path, message: i.message })) });
  const status = Number(error?.status) || (error instanceof Prisma.PrismaClientKnownRequestError ? 400 : 500);
  if (status >= 500) console.error('Request failed:', error);
  return res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`[Mahyar Gap] listening on 0.0.0.0:${PORT}`));

// Graceful shutdown: release music bots (LiveKit connections + ffmpeg) first.
async function shutdownGracefully(signal: string) {
  console.log(`[Mahyar Gap] ${signal} received; shutting down`);
  try { await musicSystem.shutdown(); } catch (error) { console.error('Music shutdown failed:', error); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => void shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => void shutdownGracefully('SIGINT'));
