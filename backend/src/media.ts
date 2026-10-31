import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTx } from './db';
import { DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, cleanFileName, documentLooksRight } from './documents';
import { HttpError } from './errors';
import { ImageRejected, type ImagePurpose, type ProcessedImage } from './imaging';
import { can } from './permissions';
import { RouteContext, paramId } from './shared';
import type { Storage } from './storage';

/**
 * What may be uploaded. These are ceilings for the file as sent; photos are then re-encoded smaller (see imaging.ts).
 * The app checks the same numbers before it starts uploading, so a too-big file fails at once instead of after the upload.
 */
export const MEDIA_LIMITS = {
  image: { maxBytes: 8 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'] },
  video: { maxBytes: 50 * 1024 * 1024, types: ['video/mp4', 'video/quicktime', 'video/webm'] },
  /** Voice messages: up to five minutes of speech, which is well under this. */
  audio: { maxBytes: 5 * 1024 * 1024, types: ['audio/mp4', 'audio/aac', 'audio/webm', 'audio/ogg'] },
  /** Files shared in a chat: see documents.ts for exactly which kinds. */
  document: { maxBytes: DOCUMENT_MAX_BYTES, types: Object.keys(DOCUMENT_TYPES) },
  maxAudioMs: 5 * 60 * 1000,
  /** A video Story may be at most this long. The app reports the length; the server cannot measure video, so it also caps the size. */
  maxStoryVideoMs: 30 * 1000,
  /** Photos above this many pixels (width x height) are refused, however small the file is. */
  maxPixels: 30_000_000,
  /** One sticker (staff upload only): PNG or WebP, animated WebP allowed. Small on purpose: stickers are sent a lot. */
  stickerMaxBytes: 512 * 1024,
  /** Everything one student has stored (photos, videos, profile pictures), counted after processing. */
  perUserBytes: 300 * 1024 * 1024,
} as const;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'weba', 'audio/ogg': 'ogg',
  ...DOCUMENT_TYPES,
};

/** Does the start of the file look like what it claims to be? A wrong label is not enough to get a file accepted. */
export function looksLike(contentType: string, b: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...Array.from(b.slice(from, to)));
  switch (contentType) {
    case 'image/jpeg': return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG';
    case 'image/webp': return b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'video/mp4':
    case 'video/quicktime': return b.length >= 12 && ascii(4, 8) === 'ftyp';
    case 'audio/mp4': return b.length >= 12 && ascii(4, 8) === 'ftyp';
    case 'audio/aac': return b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0; // ADTS frame header
    case 'audio/ogg': return b.length >= 4 && ascii(0, 4) === 'OggS';
    case 'audio/webm':
    case 'video/webm': return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    default: return documentLooksRight(contentType, b); // false for anything that is not a document type
  }
}

const uploadSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'document']),
  purpose: z.enum(['post', 'avatar', 'cover', 'message', 'event', 'group', 'community', 'story', 'sticker']),
  contentType: z.string().max(100),
  size: z.number().int().positive(),
  // Pixel size, when the app knows it. Both or neither; used only to lay out the feed.
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
  /** Length of a voice message, in milliseconds. Required for audio, not allowed for anything else. */
  durationMs: z.number().int().positive().max(5 * 60 * 1000).optional(),
  /** Voice messages only: up to 64 bar heights from 0 to 100, drawn as the message's waveform. */
  waveform: z.array(z.number().int().min(0).max(100)).min(1).max(64).optional(),
  /** Documents only: the name the person sees. It is cleaned by the server, so it is only ever a label. */
  fileName: z.string().min(1).max(255).optional(),
}).refine((v) => (v.width === undefined) === (v.height === undefined), { message: 'Send both width and height, or neither.' });
const photosSchema = z.object({
  avatarMediaId: z.string().uuid().nullable().optional(),
  coverMediaId: z.string().uuid().nullable().optional(),
});

export const UPLOAD_LINK_SECONDS = 600;
export const READ_LINK_SECONDS = 3600;

function needStorage(ctx: RouteContext): Storage {
  if (!ctx.storage) throw new HttpError(503, 'storage_unavailable', 'Photo and video uploads are not available right now.');
  return ctx.storage;
}

/** Removes uploads that were started but never completed (an app closed mid-upload, a failed post). */
export async function cleanupPendingMedia(pool: Pool, storage: Storage): Promise<number> {
  const { rows } = await pool.query<{ object_key: string }>(
    "delete from media where status = 'pending' and created_at < now() - interval '1 day' returning object_key",
  );
  if (rows.length > 0) await storage.remove(rows.map((r) => r.object_key)).catch(() => undefined);
  return rows.length;
}

/**
 * Removes files that were queued for deletion (see storage_garbage): link-card pictures whose card is gone, however it went.
 * A file is only forgotten once storage has accepted the removal, so a failed run is simply tried again next time.
 */
export async function cleanupStorageGarbage(pool: Pool, storage: Storage, batch = 200): Promise<number> {
  const { rows } = await pool.query<{ object_key: string }>('select object_key from storage_garbage order by queued_at limit $1', [batch]);
  if (rows.length === 0) return 0;
  const keys = rows.map((r) => r.object_key);
  await storage.remove(keys);
  await pool.query('delete from storage_garbage where object_key = any($1::text[])', [keys]);
  return keys.length;
}

export function registerMediaRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { pool } = ctx;

  /** Step 1: the app says what it wants to upload and gets a short-lived link to send the file to. */
  app.post('/media/uploads', async (req, reply) => {
    const user = await ctx.requireUser(req);
    const storage = needStorage(ctx);
    const b = uploadSchema.parse(req.body ?? {});
    ctx.tooMany(`media:${user.id}`, 60, 3600);
    const limit = MEDIA_LIMITS[b.kind];
    if (!(limit.types as readonly string[]).includes(b.contentType)) {
      throw new HttpError(400, 'validation', 'That file type is not supported.');
    }
    if (b.size > limit.maxBytes) {
      throw new HttpError(400, 'validation', `That file is too large (the limit is ${limit.maxBytes / (1024 * 1024)} MB).`);
    }
    if (b.kind === 'video' && b.purpose !== 'post' && b.purpose !== 'story') {
      throw new HttpError(400, 'validation', 'Profile and cover photos must be images.');
    }
    if (b.kind === 'video' && b.purpose === 'story') {
      if (!b.durationMs) throw new HttpError(400, 'validation', 'A video Story needs its length.');
      if (b.durationMs > MEDIA_LIMITS.maxStoryVideoMs) {
        throw new HttpError(400, 'validation', `A video Story can be at most ${MEDIA_LIMITS.maxStoryVideoMs / 1000} seconds.`);
      }
    }
    if (b.kind === 'audio' && (b.purpose !== 'message' || !b.durationMs)) {
      throw new HttpError(400, 'validation', 'Audio can only be a voice message, and needs its length.');
    }
    if (b.kind === 'document' && (b.purpose !== 'message' || !b.fileName)) throw new HttpError(400, 'validation', 'A document can only be sent in a chat, and needs its name.');
    if (b.kind !== 'document' && b.fileName !== undefined) throw new HttpError(400, 'validation', 'Only documents have a file name.');
    if (b.kind === 'document' && (b.width !== undefined || b.durationMs !== undefined || b.waveform)) throw new HttpError(400, 'validation', 'A document has no size in pixels or length.');
    if (b.waveform && b.kind !== 'audio') throw new HttpError(400, 'validation', 'Only voice messages have a waveform.');
    if (b.kind !== 'audio' && !(b.kind === 'video' && b.purpose === 'story') && b.durationMs !== undefined) throw new HttpError(400, 'validation', 'Only voice messages and video Stories have a length.');
    if (b.purpose === 'sticker') {
      // Stickers become shared catalogue content, so only staff may upload them. Everyone else gets the usual "not found" feel.
      if (!can(user.role, 'personalization.manage')) throw new HttpError(403, 'forbidden', 'Only staff can upload stickers.');
      if (b.kind !== 'image' || b.contentType === 'image/jpeg') throw new HttpError(400, 'validation', 'A sticker must be a PNG or WebP image with a transparent background.');
      if (b.size > MEDIA_LIMITS.stickerMaxBytes) throw new HttpError(400, 'validation', `A sticker can be at most ${MEDIA_LIMITS.stickerMaxBytes / 1024} KB.`);
    }
    if ((b.purpose === 'group' || b.purpose === 'community') && b.kind !== 'image') throw new HttpError(400, 'validation', 'A group photo must be an image.');
    const used = await pool.query<{ total: string }>('select coalesce(sum(size_bytes), 0)::text as total from media where owner_id = $1', [user.id]);
    if (Number(used.rows[0].total) + b.size > MEDIA_LIMITS.perUserBytes) {
      throw new HttpError(
        400, 'storage_full',
        `You have reached your storage limit of ${MEDIA_LIMITS.perUserBytes / (1024 * 1024)} MB. Delete some older posts with photos or videos to make room.`,
      );
    }
    const key = `${user.id}/${randomUUID()}.${EXTENSIONS[b.contentType]}`;
    const created = await pool.query<{ id: string }>(
      'insert into media (owner_id, kind, purpose, content_type, size_bytes, object_key, width, height, duration_ms, waveform, file_name) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id',
      [user.id, b.kind, b.purpose, b.contentType, b.size, key, b.width ?? null, b.height ?? null, b.durationMs ?? null, b.waveform ?? null, b.kind === 'document' ? cleanFileName(b.fileName ?? '', b.contentType) : null],
    );
    const uploadUrl = await storage.presignUpload(key, b.contentType, UPLOAD_LINK_SECONDS);
    return reply.status(201).send({
      mediaId: created.rows[0].id,
      uploadUrl,
      headers: { 'Content-Type': b.contentType },
      expiresIn: UPLOAD_LINK_SECONDS,
    });
  });

  // Browser uploads (the staff admin page) send the photo to this server instead of straight to storage, so they do not
  // depend on the bucket allowing cross-site requests. The app keeps using the signed link above.
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  /** Step 1b (alternative to the signed link): the photo itself, from a browser. Photos only; step 2 then checks it as usual. */
  app.put('/media/:id/content', { bodyLimit: MEDIA_LIMITS.image.maxBytes }, async (req, reply) => {
    const user = await ctx.requireUser(req);
    const storage = needStorage(ctx);
    ctx.tooMany(`media-put:${user.id}`, 60, 3600);
    const id = paramId(req);
    const { rows } = await pool.query<{ kind: string; content_type: string; object_key: string; status: string }>(
      'select kind, content_type, object_key, status from media where id = $1 and owner_id = $2', [id, user.id]);
    const m = rows[0];
    if (!m || m.kind !== 'image') throw new HttpError(404, 'not_found', 'That upload was not found.');
    if (m.status !== 'pending') throw new HttpError(409, 'conflict', 'That upload was already finished.');
    const bytes = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, 'validation', 'The file did not arrive. Please try again.');
    if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== m.content_type) throw new HttpError(400, 'validation', 'The file type does not match.');
    await storage.write(m.object_key, new Uint8Array(bytes), m.content_type);
    return reply.status(204).send();
  });

  /** Step 2: after the upload, the server checks what actually arrived before the file can be used anywhere. */
  app.post('/media/:id/complete', async (req) => {
    const user = await ctx.requireUser(req);
    const storage = needStorage(ctx);
    const id = paramId(req);
    const { rows } = await pool.query<{ kind: 'image' | 'video' | 'audio' | 'document'; purpose: ImagePurpose; content_type: string; object_key: string; status: string }>(
      'select kind, purpose, content_type, object_key, status from media where id = $1 and owner_id = $2',
      [id, user.id],
    );
    const m = rows[0];
    if (!m) throw new HttpError(404, 'not_found', 'That upload was not found.');
    if (m.status === 'ready') return { id, kind: m.kind };

    const reject = async (message: string): Promise<never> => {
      await pool.query('delete from media where id = $1', [id]);
      await storage.remove([m.object_key]).catch(() => undefined);
      throw new HttpError(400, 'invalid_media', message);
    };

    const head = await storage.head(m.object_key);
    if (!head) throw new HttpError(400, 'upload_missing', 'The file did not arrive. Please try again.');
    if (head.size <= 0 || head.size > MEDIA_LIMITS[m.kind].maxBytes) return reject('That file is too large.');
    if ((head.contentType ?? '').split(';')[0].trim() !== m.content_type) return reject('The file type does not match.');
    if (!looksLike(m.content_type, await storage.peek(m.object_key, 16))) return reject(m.kind === 'document' ? 'That file does not look like what it says it is.' : 'That is not a valid photo or video.');

    if (m.kind === 'image' && ctx.images) {
      // Re-encode what arrived: upright, no metadata (location!), bounded size, plus a feed thumbnail for post photos.
      const original = await storage.read(m.object_key);
      let done: ProcessedImage;
      try {
        done = await ctx.images.process(original, m.content_type, m.purpose);
      } catch (e) {
        if (e instanceof ImageRejected) return reject(e.message);
        throw e;
      }
      const base = m.object_key.replace(/\.[^./]+$/, '');
      const fullKey = `${base}.webp`;
      const thumbKey = done.thumb ? `${base}-t.webp` : null;
      await storage.write(fullKey, done.full.bytes, done.full.contentType);
      if (done.thumb && thumbKey) await storage.write(thumbKey, done.thumb.bytes, done.thumb.contentType);
      try {
        await pool.query(
          "update media set status = 'ready', content_type = $2, object_key = $3, thumb_key = $4, size_bytes = $5, width = $6, height = $7 where id = $1",
          [id, done.full.contentType, fullKey, thumbKey, done.full.bytes.length + (done.thumb?.bytes.length ?? 0), done.full.width, done.full.height],
        );
      } catch (e) {
        await storage.remove([fullKey, ...(thumbKey ? [thumbKey] : [])].filter((k) => k !== m.object_key)).catch(() => undefined);
        throw e;
      }
      if (fullKey !== m.object_key) await storage.remove([m.object_key]).catch(() => undefined);
      return { id, kind: m.kind };
    }

    await pool.query("update media set status = 'ready', size_bytes = $2 where id = $1", [id, head.size]);
    return { id, kind: m.kind };
  });

  /** Sets or removes the signed-in student's profile and cover photos. A key left out stays as it is; null removes. */
  app.put('/me/photos', async (req) => {
    const user = await ctx.requireUser(req);
    const b = photosSchema.parse(req.body ?? {});
    const fields = [
      { column: 'avatar_media_id', purpose: 'avatar', value: b.avatarMediaId },
      { column: 'cover_media_id', purpose: 'cover', value: b.coverMediaId },
    ] as const;
    const replacedKeys: string[] = [];
    await withTx(pool, async (client) => {
      for (const f of fields) {
        if (f.value === undefined) continue;
        const current = await client.query<{ id: string | null; key: string | null }>(
          `select u.${f.column} as id, m.object_key as key from users u left join media m on m.id = u.${f.column} where u.id = $1`,
          [user.id],
        );
        if (f.value !== null) {
          const usable = await client.query(
            "select 1 from media where id = $1 and owner_id = $2 and status = 'ready' and kind = 'image' and purpose = $3 and post_id is null",
            [f.value, user.id, f.purpose],
          );
          if (!usable.rowCount) throw new HttpError(400, 'validation', 'That photo is not available.');
        }
        await client.query(`update users set ${f.column} = $2 where id = $1`, [user.id, f.value]);
        const old = current.rows[0];
        if (old?.id && old.id !== f.value) {
          await client.query('delete from media where id = $1', [old.id]);
          if (old.key) replacedKeys.push(old.key);
        }
      }
    });
    if (replacedKeys.length > 0 && ctx.storage) await ctx.storage.remove(replacedKeys).catch(() => undefined);
    return ctx.userView(user.id);
  });
}
