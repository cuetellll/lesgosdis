/**
 * Mahyar Music — shared music library.
 *
 * The library is the ONLY audio source for playback in this version. Members
 * upload files they own or are authorized to share with their private server;
 * audio bytes live in the private object bucket and only metadata lives in
 * PostgreSQL. There is no external search provider, no scraping and no
 * unauthorized downloading anywhere in the playback path.
 *
 * Upload flow (per the master prompt §2.5):
 *   1. POST /api/music/upload/init   — auth, permission, format/size/quota checks,
 *                                      returns a short-lived presigned PUT URL.
 *   2. Browser PUTs the file straight into the bucket (never through Express).
 *   3. POST /api/music/upload/complete — backend verifies the object (HEAD + magic
 *                                      bytes + ffprobe), extracts artwork, then
 *                                      stores metadata in PostgreSQL.
 *
 * Failures are honest: without storage configuration the endpoints answer 501
 * with the missing variable names, and invalid files are deleted from the
 * bucket and reported with a useful message.
 */
import { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { access, rm } from 'fs/promises';
import path from 'path';
import type { PrismaClient, MusicTrack } from '@prisma/client';
import {
  storageConfig, missingStorageVariables, musicObjectKey, presignUpload,
  headObject, downloadToTempFile, removeTempFile, deleteObject, putLocalFile
} from './storage';

type AuthedRequest = Request & { userId?: string };

// ------------------------------------------------------------- configuration

const MAX_FILE_BYTES = Math.max(1, Number(process.env.MUSIC_MAX_FILE_MB) || 25) * 1024 * 1024;
const SERVER_QUOTA_BYTES = Math.max(MAX_FILE_BYTES, (Number(process.env.MUSIC_SERVER_QUOTA_MB) || 500) * 1024 * 1024);
const MAX_DURATION_SECONDS = Math.max(30, Number(process.env.MUSIC_MAX_DURATION_SEC) || 1800);
const MAX_TRACKS_PER_SERVER = Math.max(10, Number(process.env.MUSIC_MAX_TRACKS) || 500);
const MAX_PLAYLIST_ITEMS = 200;
const PENDING_TTL_MS = 15 * 60_000;

/**
 * Formats the playback pipeline (ffmpeg decode → LiveKit) handles reliably.
 * MP3 is the primary format; the others are enabled because ffmpeg decodes
 * them everywhere the bot runs. Anything else is rejected with a clear message.
 */
export const AUDIO_FORMATS: Record<string, { mime: string; label: string }> = {
  mp3: { mime: 'audio/mpeg', label: 'MP3' },
  m4a: { mime: 'audio/mp4', label: 'M4A (AAC)' },
  aac: { mime: 'audio/aac', label: 'AAC (ADTS)' },
  ogg: { mime: 'audio/ogg', label: 'OGG' },
  opus: { mime: 'audio/ogg', label: 'Opus (OGG)' },
  wav: { mime: 'audio/wav', label: 'WAV' },
  flac: { mime: 'audio/flac', label: 'FLAC' }
};

const ACCEPTED_EXTENSIONS = Object.keys(AUDIO_FORMATS);

export function libraryLimits() {
  return {
    max_file_mb: Math.round(MAX_FILE_BYTES / (1024 * 1024)),
    server_quota_mb: Math.round(SERVER_QUOTA_BYTES / (1024 * 1024)),
    max_duration_sec: MAX_DURATION_SECONDS,
    max_tracks: MAX_TRACKS_PER_SERVER,
    formats: ACCEPTED_EXTENSIONS,
    storage_configured: storageConfig().ready,
    missing_variables: storageConfig().ready ? [] : missingStorageVariables()
  };
}

// ----------------------------------------------------- signature + metadata

/**
 * Detects the actual audio container from the file's leading bytes. The file
 * extension is advisory; the signature decides. Returns null for anything we
 * cannot confirm (executables, text, images — always rejected).
 */
export function sniffAudioFormat(header: Buffer): string | null {
  if (!header || header.length < 4) return null;
  if (header.length >= 3 && header.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (header.length >= 4 && header.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (header.length >= 4 && header.subarray(0, 4).toString('ascii') === 'OggS') {
    // Opus streams carry an "OpusHead" identification page right after OggS.
    const head = header.subarray(0, 40).toString('latin1');
    return head.includes('OpusHead') ? 'opus' : 'ogg';
  }
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (header.length >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  const b0 = header[0], b1 = header[1];
  // ADTS (AAC): 12-bit syncword FFF + MPEG ID bit 0 (MPEG-4) or 1 with layer bits 00.
  // The strict mask keeps common MP3 frame syncs (0xFFEx/0xFFFx like 0xFFFB) unambiguous.
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return 'aac';
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return 'mp3'; // MPEG audio frame sync
  return null;
}

/** Sensible defaults derived from the filename when no embedded tags exist. */
export function metadataFromFilename(originalName: string): { title: string; artist: string } {
  const base = path.basename(originalName, path.extname(originalName));
  const cleaned = base.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  // "Artist - Title" (any dash separator) splits before punctuation cleanup.
  const dashParts = cleaned.split(/\s[-–]\s/);
  if (dashParts.length >= 2 && dashParts[0].trim() && dashParts.slice(1).join(' - ').trim()) {
    return { artist: dashParts[0].trim().slice(0, 120), title: dashParts.slice(1).join(' - ').trim().slice(0, 200) };
  }
  const readable = cleaned.replace(/[-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { artist: '', title: (readable || 'Untitled track').slice(0, 200) };
}

async function toolExists(bin: string): Promise<string | null> {
  for (const candidate of [bin, `/usr/bin/${bin}`, `/usr/local/bin/${bin}`]) {
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  return null;
}

interface ProbeResult {
  duration: number;
  title: string;
  artist: string;
  album: string | null;
  formatName: string;
  hasCover: boolean;
}

/** Server-side metadata probe (bounded: runs once per upload, never during playback). */
export async function probeAudio(filePath: string): Promise<ProbeResult | null> {
  const bin = await toolExists('ffprobe');
  if (!bin) return null;
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffprobe timed out')); }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`ffprobe exited with ${code}`)); });
  });
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed?.format) return null;
  const duration = Math.round(Number(parsed.format.duration) || 0);
  const tags = parsed.format.tags || {};
  const hasCover = (parsed.streams || []).some((stream: any) => stream.codec_type === 'video');
  const first = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));
  return {
    duration,
    title: first(tags.title ?? tags.TITLE ?? tags.Tit2).trim(),
    artist: first(tags.artist ?? tags.ARTIST ?? tags.TP1).trim(),
    album: first(tags.album ?? tags.ALBUM ?? tags.TAL).trim() || null,
    formatName: String(parsed.format.format_name || ''),
    hasCover
  };
}

/** Extracts embedded cover art to a small JPEG. Returns null when there is none. */
export async function extractArtwork(filePath: string, destPath: string): Promise<boolean> {
  const bin = await toolExists('ffmpeg');
  if (!bin) return false;
  return new Promise((resolve) => {
    // -map 0:v:0 selects the embedded picture stream (mp3 APIC, m4a covr, flac picture).
    const child = spawn(bin, ['-v', 'quiet', '-i', filePath, '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=w=512:h=512:force_original_aspect_ratio=decrease', '-q:v', '4', '-y', destPath],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 15_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

// ------------------------------------------------------------ pending uploads

interface PendingUpload {
  token: string;
  serverId: string;
  userId: string;
  key: string;
  extension: string;
  mimeType: string;
  fileName: string;
  declaredSize: number;
  titleHint: string;
  artistHint: string;
  expiresAt: number;
}

const pendingUploads = new Map<string, PendingUpload>();

/** Frees expired pending slots; called from a low-frequency timer. */
export function sweepPendingUploads(now = Date.now()): number {
  let removed = 0;
  for (const [token, pending] of pendingUploads) {
    if (pending.expiresAt <= now) {
      pendingUploads.delete(token);
      void deleteObject(pending.key);
      removed += 1;
    }
  }
  return removed;
}

// ----------------------------------------------------------------- serializer

export interface LibraryDeps {
  app: Express;
  prisma: PrismaClient;
  auth: (req: AuthedRequest, res: Response, next: NextFunction) => void;
  /** True when the user may view this server (membership). */
  isMember: (userId: string, serverId: string) => Promise<boolean>;
  /** Configurable per-action music permissions (MUSIC_* role nodes, default-open). */
  musicPermission: (userId: string, serverId: string, action: MusicPermissionAction) => Promise<boolean>;
  /** Notifies listeners that library content changed (socket broadcast). */
  broadcast: (serverId: string, event: string, payload: unknown) => void;
}

export type MusicPermissionAction = 'upload' | 'manage';

export function serializeTrack(track: MusicTrack & { uploader?: { displayName?: string; username?: string } | null }) {
  return {
    id: track.id,
    server_id: track.serverId,
    title: track.title,
    artist: track.artist,
    album: track.album || null,
    duration: track.duration,
    format: track.format,
    mime_type: track.mimeType,
    file_size: track.fileSize,
    artwork_url: track.artworkKey ? `/api/music/tracks/${track.id}/artwork` : null,
    original_name: track.originalName,
    uploader_id: track.uploaderId,
    uploader_name: track.uploader?.displayName || track.uploader?.username || 'Unknown',
    play_count: track.playCount,
    last_played_at: track.lastPlayedAt ? track.lastPlayedAt.toISOString() : null,
    created_at: track.createdAt.toISOString()
  };
}

// ------------------------------------------------------------ REST registration

const initSchema = z.object({
  server_id: z.string().min(1).max(64),
  file_name: z.string().min(1).max(255),
  content_type: z.string().min(3).max(120).optional(),
  size_bytes: z.number().int().min(1),
  title: z.string().max(200).optional(),
  artist: z.string().max(120).optional()
});

const completeSchema = z.object({
  upload_token: z.string().min(16).max(128),
  title: z.string().max(200).optional(),
  artist: z.string().max(120).optional()
});

export function registerMusicLibrary(deps: LibraryDeps): void {
  const { app, prisma, auth } = deps;

  // Every library route sits behind the same authentication middleware as the app.

  app.get('/api/music/library', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = String(req.query.server_id || '');
      const query = String(req.query.q || '').trim().slice(0, 120);
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 60));
      const offset = Math.max(0, Math.min(5000, Number(req.query.offset) || 0));
      if (!serverId) return res.status(400).json({ error: 'server_id is required' });
      if (!await deps.isMember(req.userId!, serverId)) return res.status(403).json({ error: 'You are not a member of this server' });

      const where: any = { serverId };
      if (query) {
        where.OR = [
          { title: { contains: query, mode: 'insensitive' } },
          { artist: { contains: query, mode: 'insensitive' } },
          { album: { contains: query, mode: 'insensitive' } },
          { originalName: { contains: query, mode: 'insensitive' } }
        ];
      }
      const [tracks, total, usedAgg] = await Promise.all([
        prisma.musicTrack.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          include: { uploader: { select: { displayName: true, username: true } } }
        }),
        prisma.musicTrack.count({ where }),
        prisma.musicTrack.aggregate({ where: { serverId }, _sum: { fileSize: true } })
      ]);
      return res.json({
        tracks: tracks.map(serializeTrack),
        total,
        limits: libraryLimits(),
        used_bytes: Number(usedAgg._sum.fileSize || 0)
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/music/recent', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = String(req.query.server_id || '');
      const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 10));
      if (!serverId) return res.status(400).json({ error: 'server_id is required' });
      if (!await deps.isMember(req.userId!, serverId)) return res.status(403).json({ error: 'You are not a member of this server' });
      const tracks = await prisma.musicTrack.findMany({
        where: { serverId, lastPlayedAt: { not: null } },
        orderBy: [{ lastPlayedAt: 'desc' }],
        take: limit,
        include: { uploader: { select: { displayName: true, username: true } } }
      });
      return res.json({ tracks: tracks.map(serializeTrack) });
    } catch (error) { return next(error); }
  });

  app.post('/api/music/upload/init', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = initSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid upload request' });
      const { server_id: serverId, file_name: fileName, size_bytes: sizeBytes } = parsed.data;
      if (!storageConfig().ready) {
        return res.status(501).json({
          error: 'Music storage is not configured on this deployment; uploads are disabled.',
          code: 'MUSIC_STORAGE_NOT_CONFIGURED',
          missingVariables: missingStorageVariables()
        });
      }
      if (!await deps.isMember(req.userId!, serverId)) return res.status(403).json({ error: 'You are not a member of this server' });
      if (!await deps.musicPermission(req.userId!, serverId, 'upload')) return res.status(403).json({ error: 'You do not have permission to upload music on this server' });

      const extension = path.extname(fileName).replace('.', '').toLowerCase();
      const format = AUDIO_FORMATS[extension];
      if (!format) {
        return res.status(415).json({ error: `"${extension || 'unknown'}" files are not supported. Supported formats: ${ACCEPTED_EXTENSIONS.join(', ')}.` });
      }
      if (sizeBytes > MAX_FILE_BYTES) {
        return res.status(413).json({ error: `Audio files are limited to ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.` });
      }
      const [trackCount, usedAgg] = await Promise.all([
        prisma.musicTrack.count({ where: { serverId } }),
        prisma.musicTrack.aggregate({ where: { serverId }, _sum: { fileSize: true } })
      ]);
      if (trackCount >= MAX_TRACKS_PER_SERVER) {
        return res.status(413).json({ error: `This server's library is full (max ${MAX_TRACKS_PER_SERVER} tracks).` });
      }
      const usedBytes = Number(usedAgg._sum?.fileSize || 0) + sizeBytes;
      if (usedBytes > SERVER_QUOTA_BYTES) {
        return res.status(413).json({ error: `This server's music storage quota (${Math.round(SERVER_QUOTA_BYTES / (1024 * 1024))} MB) is exhausted.` });
      }

      const key = musicObjectKey(serverId, extension);
      const uploadUrl = await presignUpload(key, format.mime, MAX_FILE_BYTES);
      const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const fallbackMeta = metadataFromFilename(fileName);
      pendingUploads.set(token, {
        token, serverId, userId: req.userId!, key, extension,
        mimeType: parsed.data.content_type || format.mime,
        fileName: fileName.slice(0, 255),
        declaredSize: sizeBytes,
        titleHint: parsed.data.title || fallbackMeta.title,
        artistHint: parsed.data.artist || fallbackMeta.artist,
        expiresAt: Date.now() + PENDING_TTL_MS
      });
      return res.status(201).json({
        upload_url: uploadUrl,
        upload_token: token,
        key,
        content_type: format.mime,
        expires_in_sec: 900,
        suggested_title: fallbackMeta.title,
        suggested_artist: fallbackMeta.artist
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/music/upload/complete', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    let tempPath: string | null = null;
    try {
      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid upload completion request' });
      const pending = pendingUploads.get(parsed.data.upload_token);
      if (!pending) return res.status(404).json({ error: 'This upload session expired or was already completed. Start the upload again.' });
      if (pending.userId !== req.userId) return res.status(403).json({ error: 'Only the uploader can complete this upload.' });
      pendingUploads.delete(parsed.data.upload_token);
      if (pending.expiresAt <= Date.now()) { void deleteObject(pending.key); return res.status(410).json({ error: 'The upload session expired. Start again.' }); }

      // 1) The object must really exist and match the announced shape.
      const head = await headObject(pending.key);
      if (!head) return res.status(400).json({ error: 'The uploaded file never reached storage. Try again.' });
      if (head.size <= 0 || head.size > MAX_FILE_BYTES) {
        await deleteObject(pending.key);
        return res.status(413).json({ error: `The uploaded file is ${head.size > 0 ? 'too large' : 'empty'}; the limit is ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.` });
      }

      // 2) Verify actual content: signature + decodability + duration (bounded download to disk).
      tempPath = await downloadToTempFile(pending.key, MAX_FILE_BYTES);
      const { readFile } = await import('fs/promises');
      const header = await readFile(tempPath).then((buf) => buf.subarray(0, 64)).catch(() => Buffer.alloc(0));
      const sniffed = sniffAudioFormat(header);
      if (!sniffed || !AUDIO_FORMATS[sniffed]) {
        await removeTempFile(tempPath); tempPath = null;
        await deleteObject(pending.key);
        return res.status(415).json({ error: 'That file is not a recognizable audio file (checked by content, not just the extension).' });
      }
      const probe = await probeAudio(tempPath);
      if (!probe) {
        await removeTempFile(tempPath); tempPath = null;
        await deleteObject(pending.key);
        return res.status(415).json({ error: 'The audio could not be decoded on the server (corrupt file or unsupported codec).' });
      }
      if (probe.duration > MAX_DURATION_SECONDS) {
        await removeTempFile(tempPath); tempPath = null;
        await deleteObject(pending.key);
        return res.status(413).json({ error: `Tracks are limited to ${Math.round(MAX_DURATION_SECONDS / 60)} minutes (this one is ${Math.round(probe.duration / 60)} minutes).` });
      }

      // 3) Exact duplicate detection (same server + same bucket ETag).
      if (head.etag) {
        const duplicate = await prisma.musicTrack.findFirst({ where: { serverId: pending.serverId, contentHash: head.etag }, select: { id: true, title: true } });
        if (duplicate) {
          await removeTempFile(tempPath); tempPath = null;
          await deleteObject(pending.key);
          return res.status(409).json({ error: `This exact file is already in the library as "${duplicate.title}".`, code: 'DUPLICATE_TRACK', existing_track_id: duplicate.id });
        }
      }

      // 4) Optional embedded artwork, stored as a separate private object.
      let artworkKey: string | null = null;
      if (probe.hasCover) {
        const artworkPath = `${tempPath}-art.jpg`;
        if (await extractArtwork(tempPath, artworkPath)) {
          artworkKey = `${pending.key}.jpg`;
          await putLocalFile(artworkKey, artworkPath, 'image/jpeg').catch(() => { artworkKey = null; });
          await rm(artworkPath, { force: true }).catch(() => undefined);
        }
      }

      // 5) Metadata row — the bucket keeps the bytes, PostgreSQL keeps the catalog.
      const track = await prisma.musicTrack.create({
        data: {
          serverId: pending.serverId,
          uploaderId: pending.userId,
          title: (parsed.data.title || pending.titleHint || 'Untitled track').slice(0, 200),
          artist: (parsed.data.artist || pending.artistHint || '').slice(0, 120),
          album: probe.album ? probe.album.slice(0, 200) : null,
          duration: probe.duration,
          format: sniffed,
          mimeType: AUDIO_FORMATS[sniffed].mime,
          fileSize: head.size,
          storageKey: pending.key,
          artworkKey,
          contentHash: head.etag,
          originalName: pending.fileName
        },
        include: { uploader: { select: { displayName: true, username: true } } }
      });
      await removeTempFile(tempPath); tempPath = null;
      deps.broadcast(pending.serverId, 'music_library_updated', { server_id: pending.serverId, kind: 'track_added', track: serializeTrack(track) });
      return res.status(201).json({ track: serializeTrack(track) });
    } catch (error) {
      if (tempPath) await removeTempFile(tempPath).catch(() => undefined);
      return next(error);
    }
  });

  app.get('/api/music/tracks/:id/artwork', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const track = await prisma.musicTrack.findUnique({ where: { id: req.params.id }, select: { serverId: true, artworkKey: true } });
      if (!track || !track.artworkKey) return res.status(404).json({ error: 'Artwork not found' });
      if (!await deps.isMember(req.userId!, track.serverId)) return res.status(403).json({ error: 'Forbidden' });
      const { streamObjectTo } = await import('./storage');
      const streamed = await streamObjectTo(track.artworkKey, res).catch(() => false);
      if (!streamed && !res.headersSent) return res.status(404).json({ error: 'Artwork not found' });
      return undefined;
    } catch (error) { return next(error); }
  });

  app.patch('/api/music/tracks/:id', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = z.object({ title: z.string().min(1).max(200).optional(), artist: z.string().max(120).optional() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid metadata update' });
      const track = await prisma.musicTrack.findUnique({ where: { id: req.params.id }, select: { id: true, serverId: true, uploaderId: true } });
      if (!track) return res.status(404).json({ error: 'Track not found' });
      const allowed = track.uploaderId === req.userId || await deps.musicPermission(req.userId!, track.serverId, 'manage');
      if (!allowed) return res.status(403).json({ error: 'You can only edit tracks you uploaded unless you have music manage permission' });
      const updated = await prisma.musicTrack.update({
        where: { id: track.id },
        data: { title: parsed.data.title ?? undefined, artist: parsed.data.artist ?? undefined },
        include: { uploader: { select: { displayName: true, username: true } } }
      });
      deps.broadcast(track.serverId, 'music_library_updated', { server_id: track.serverId, kind: 'track_updated', track: serializeTrack(updated) });
      return res.json({ track: serializeTrack(updated) });
    } catch (error) { return next(error); }
  });

  app.delete('/api/music/tracks/:id', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const track = await prisma.musicTrack.findUnique({ where: { id: req.params.id }, select: { id: true, serverId: true, uploaderId: true, storageKey: true, artworkKey: true, title: true } });
      if (!track) return res.status(404).json({ error: 'Track not found' });
      const allowed = track.uploaderId === req.userId || await deps.musicPermission(req.userId!, track.serverId, 'manage');
      if (!allowed) return res.status(403).json({ error: 'You can only remove tracks you uploaded unless you have music manage permission' });
      await prisma.musicTrack.delete({ where: { id: track.id } });
      await deleteObject(track.storageKey);
      if (track.artworkKey) await deleteObject(track.artworkKey);
      deps.broadcast(track.serverId, 'music_library_updated', { server_id: track.serverId, kind: 'track_removed', track_id: track.id });
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  });

  // ----------------------------------------------------------- playlists

  const playlistNameSchema = z.object({ server_id: z.string().min(1).max(64), name: z.string().min(1).max(80) });

  app.get('/api/music/playlists', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = String(req.query.server_id || '');
      if (!serverId) return res.status(400).json({ error: 'server_id is required' });
      if (!await deps.isMember(req.userId!, serverId)) return res.status(403).json({ error: 'You are not a member of this server' });
      const playlists = await prisma.musicPlaylist.findMany({
        where: { serverId },
        orderBy: { updatedAt: 'desc' },
        include: {
          creator: { select: { displayName: true, username: true } },
          items: { orderBy: { position: 'asc' }, select: { trackId: true, track: { select: { artworkKey: true, id: true } } } }
        }
      });
      return res.json({
        playlists: playlists.map((playlist) => ({
          id: playlist.id,
          server_id: playlist.serverId,
          name: playlist.name,
          creator_id: playlist.creatorId,
          creator_name: playlist.creator?.displayName || playlist.creator?.username || 'Unknown',
          track_count: playlist.items.length,
          artwork_urls: playlist.items.slice(0, 4).map((item) => item.track.artworkKey ? `/api/music/tracks/${item.track.id}/artwork` : null).filter(Boolean),
          created_at: playlist.createdAt.toISOString(),
          updated_at: playlist.updatedAt.toISOString()
        }))
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/music/playlists', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = playlistNameSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'A playlist needs a name (1–80 characters) and a server.' });
      if (!await deps.isMember(req.userId!, parsed.data.server_id)) return res.status(403).json({ error: 'You are not a member of this server' });
      const count = await prisma.musicPlaylist.count({ where: { serverId: parsed.data.server_id } });
      if (count >= 50) return res.status(413).json({ error: 'This server already has 50 playlists.' });
      const playlist = await prisma.musicPlaylist.create({ data: { serverId: parsed.data.server_id, creatorId: req.userId!, name: parsed.data.name } });
      deps.broadcast(parsed.data.server_id, 'music_library_updated', { server_id: parsed.data.server_id, kind: 'playlist_changed' });
      return res.status(201).json({ playlist: { id: playlist.id, name: playlist.name, server_id: playlist.serverId, track_count: 0 } });
    } catch (error: any) {
      if (error?.code === 'P2002') return res.status(409).json({ error: 'A playlist with that name already exists on this server.' });
      return next(error);
    }
  });

  app.get('/api/music/playlists/:id', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const playlist = await prisma.musicPlaylist.findUnique({
        where: { id: req.params.id },
        include: {
          creator: { select: { displayName: true, username: true } },
          items: { orderBy: { position: 'asc' }, include: { track: { include: { uploader: { select: { displayName: true, username: true } } } } } }
        }
      });
      if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
      if (!await deps.isMember(req.userId!, playlist.serverId)) return res.status(403).json({ error: 'You are not a member of this server' });
      return res.json({
        playlist: {
          id: playlist.id,
          server_id: playlist.serverId,
          name: playlist.name,
          creator_id: playlist.creatorId,
          creator_name: playlist.creator?.displayName || playlist.creator?.username || 'Unknown',
          tracks: playlist.items.map((item, index) => ({ ...serializeTrack(item.track), position: index + 1 })),
          created_at: playlist.createdAt.toISOString(),
          updated_at: playlist.updatedAt.toISOString()
        }
      });
    } catch (error) { return next(error); }
  });

  app.patch('/api/music/playlists/:id', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = z.object({ name: z.string().min(1).max(80) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'A playlist name is required (1–80 characters).' });
      const playlist = await prisma.musicPlaylist.findUnique({ where: { id: req.params.id }, select: { id: true, serverId: true, creatorId: true } });
      if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
      if (playlist.creatorId !== req.userId && !(await deps.musicPermission(req.userId!, playlist.serverId, 'manage'))) {
        return res.status(403).json({ error: 'Only the playlist creator or a moderator can rename it' });
      }
      const updated = await prisma.musicPlaylist.update({ where: { id: playlist.id }, data: { name: parsed.data.name } });
      deps.broadcast(playlist.serverId, 'music_library_updated', { server_id: playlist.serverId, kind: 'playlist_changed' });
      return res.json({ playlist: { id: updated.id, name: updated.name } });
    } catch (error: any) {
      if (error?.code === 'P2002') return res.status(409).json({ error: 'A playlist with that name already exists on this server.' });
      return next(error);
    }
  });

  app.delete('/api/music/playlists/:id', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const playlist = await prisma.musicPlaylist.findUnique({ where: { id: req.params.id }, select: { id: true, serverId: true, creatorId: true } });
      if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
      if (playlist.creatorId !== req.userId && !(await deps.musicPermission(req.userId!, playlist.serverId, 'manage'))) {
        return res.status(403).json({ error: 'Only the playlist creator or a moderator can delete it' });
      }
      await prisma.musicPlaylist.delete({ where: { id: playlist.id } });
      deps.broadcast(playlist.serverId, 'music_library_updated', { server_id: playlist.serverId, kind: 'playlist_changed' });
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  });

  app.post('/api/music/playlists/:id/tracks', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = z.object({ track_id: z.string().min(1).max(64) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'track_id is required' });
      const playlist = await prisma.musicPlaylist.findUnique({ where: { id: req.params.id }, select: { id: true, serverId: true } });
      if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
      if (!await deps.isMember(req.userId!, playlist.serverId)) return res.status(403).json({ error: 'You are not a member of this server' });
      const track = await prisma.musicTrack.findUnique({ where: { id: parsed.data.track_id }, select: { id: true, serverId: true, title: true } });
      if (!track || track.serverId !== playlist.serverId) return res.status(400).json({ error: 'That track belongs to a different server' });
      const count = await prisma.musicPlaylistTrack.count({ where: { playlistId: playlist.id } });
      if (count >= MAX_PLAYLIST_ITEMS) return res.status(413).json({ error: `Playlists hold at most ${MAX_PLAYLIST_ITEMS} tracks.` });
      await prisma.musicPlaylistTrack.create({ data: { playlistId: playlist.id, trackId: track.id, position: count + 1 } }).catch((error: any) => {
        if (error?.code === 'P2002') throw Object.assign(new Error(`"${track.title}" is already in this playlist.`), { status: 409 });
        throw error;
      });
      await prisma.musicPlaylist.update({ where: { id: playlist.id }, data: { updatedAt: new Date() } });
      deps.broadcast(playlist.serverId, 'music_library_updated', { server_id: playlist.serverId, kind: 'playlist_changed' });
      return res.status(201).json({ ok: true });
    } catch (error: any) { return next(error); }
  });

  app.delete('/api/music/playlists/:id/tracks/:trackId', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const playlist = await prisma.musicPlaylist.findUnique({ where: { id: req.params.id }, select: { id: true, serverId: true } });
      if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
      if (!await deps.isMember(req.userId!, playlist.serverId)) return res.status(403).json({ error: 'You are not a member of this server' });
      const item = await prisma.musicPlaylistTrack.findUnique({ where: { playlistId_trackId: { playlistId: playlist.id, trackId: req.params.trackId } } });
      if (!item) return res.status(404).json({ error: 'That track is not in this playlist' });
      await prisma.musicPlaylistTrack.delete({ where: { id: item.id } });
      // Re-pack positions so ordering stays gapless.
      const items = await prisma.musicPlaylistTrack.findMany({ where: { playlistId: playlist.id }, orderBy: { position: 'asc' } });
      await prisma.$transaction(items.map((row, index) => prisma.musicPlaylistTrack.update({ where: { id: row.id }, data: { position: index + 1 } })));
      await prisma.musicPlaylist.update({ where: { id: playlist.id }, data: { updatedAt: new Date() } });
      deps.broadcast(playlist.serverId, 'music_library_updated', { server_id: playlist.serverId, kind: 'playlist_changed' });
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  });

  app.put('/api/music/playlists/:id/tracks', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = z.object({ ordered_track_ids: z.array(z.string().max(64)).min(1).max(MAX_PLAYLIST_ITEMS) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'ordered_track_ids is required' });
      const playlist = await prisma.musicPlaylist.findUnique({ where: { id: req.params.id }, select: { id: true, serverId: true } });
      if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
      if (!await deps.isMember(req.userId!, playlist.serverId)) return res.status(403).json({ error: 'You are not a member of this server' });
      const items = await prisma.musicPlaylistTrack.findMany({ where: { playlistId: playlist.id } });
      const known = new Set(items.map((item) => item.trackId));
      if (parsed.data.ordered_track_ids.length !== items.length || parsed.data.ordered_track_ids.some((id) => !known.has(id))) {
        return res.status(400).json({ error: 'The new order must contain exactly the tracks already in the playlist.' });
      }
      await prisma.$transaction(parsed.data.ordered_track_ids.map((trackId, index) => {
        const item = items.find((row) => row.trackId === trackId)!;
        return prisma.musicPlaylistTrack.update({ where: { id: item.id }, data: { position: index + 1 } });
      }));
      await prisma.musicPlaylist.update({ where: { id: playlist.id }, data: { updatedAt: new Date() } });
      deps.broadcast(playlist.serverId, 'music_library_updated', { server_id: playlist.serverId, kind: 'playlist_changed' });
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  });

  // Low-frequency cleanup of abandoned upload sessions.
  const sweeper = setInterval(() => sweepPendingUploads(), 60_000);
  sweeper.unref?.();
}
