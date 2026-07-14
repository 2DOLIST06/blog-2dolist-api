import 'dotenv/config';
import crypto from 'node:crypto';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Prisma, PrismaClient } from '@prisma/client';
import { fileTypeFromBuffer } from 'file-type';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const WORDPRESS_PREFIX = 'https://blog.2dolist.fr/wp-content/uploads/';
const AWS_REGION = process.env.AWS_REGION ?? 'eu-west-3';
const BUCKET = process.env.AWS_S3_BUCKET_NAME ?? 'blog-2dolist-media-prod';
const CLOUDFRONT_URL = (process.env.AWS_CLOUDFRONT_URL ?? 'https://d140u74ocia07i.cloudfront.net').replace(/\/+$/, '');
const MAX_BYTES = Number(process.env.AWS_S3_UPLOAD_MAX_BYTES ?? 15 * 1024 * 1024);
const s3 = new S3Client({ region: AWS_REGION });

type ImageUse = { url: string; mediaIds: string[]; postIds: string[] };
type Migrated = { sourceUrl: string; cloudFrontUrl: string; key: string; mimeType?: string; sizeBytes?: number };

function maskPresent(name: string): string {
  return process.env[name] ? 'présente' : 'absente';
}

function extractUrls(value: string): string[] {
  return [...new Set((value.match(/https?:\/\/[^\s"'<>\\)]+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, '')).filter((url) => url.startsWith(WORDPRESS_PREFIX)))];
}

function collectUrlsFromJson(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const url of extractUrls(node)) urls.add(url);
    } else if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else if (node && typeof node === 'object') {
      for (const item of Object.values(node as Record<string, unknown>)) visit(item);
    }
  };
  visit(value);
  return [...urls];
}

function replaceInJson(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let next = value;
    for (const [from, to] of replacements) next = next.split(from).join(to);
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => replaceInJson(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceInJson(item, replacements)]));
  }
  return value;
}

function keyFromWordpressUrl(sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  const decoded = decodeURIComponent(parsed.pathname);
  const match = decoded.match(/\/wp-content\/uploads\/(\d{4})\/(\d{2})\/([^/?#]+)$/);
  const now = new Date();
  const year = match?.[1] ?? String(now.getUTCFullYear());
  const month = match?.[2] ?? String(now.getUTCMonth() + 1).padStart(2, '0');
  const rawFilename = match?.[3] ?? decoded.split('/').pop() ?? 'wordpress-image';
  const safeFilename = rawFilename.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wordpress-image';
  return `wordpress-import/${year}/${month}/${safeFilename}`;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uniqueKey(baseKey: string, sourceUrl: string): Promise<string> {
  if (dryRun || !(await objectExists(baseKey))) return baseKey;
  const hash = crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 8);
  const dot = baseKey.lastIndexOf('.');
  const candidate = dot > -1 ? `${baseKey.slice(0, dot)}-${hash}${baseKey.slice(dot)}` : `${baseKey}-${hash}`;
  return (await objectExists(candidate)) ? candidate : candidate;
}

async function download(sourceUrl: string): Promise<{ body: Buffer; mimeType: string; sizeBytes: number }> {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error(`Image trop volumineuse (${body.length} > ${MAX_BYTES})`);
  const detected = await fileTypeFromBuffer(body);
  return { body, mimeType: detected?.mime ?? response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream', sizeBytes: body.length };
}

async function main(): Promise<void> {
  console.log(`Mode: ${dryRun ? 'dry-run' : 'migration réelle'}`);
  console.log(`Variables: AWS_ACCESS_KEY_ID=${maskPresent('AWS_ACCESS_KEY_ID')}, AWS_SECRET_ACCESS_KEY=${maskPresent('AWS_SECRET_ACCESS_KEY')}, AWS_REGION=${AWS_REGION ? 'présente' : 'absente'}, AWS_S3_BUCKET_NAME=${BUCKET ? 'présente' : 'absente'}, AWS_CLOUDFRONT_URL=${CLOUDFRONT_URL ? 'présente' : 'absente'}, AWS_S3_UPLOAD_MAX_BYTES=${MAX_BYTES ? 'présente' : 'absente'}`);

  const [mediaRows, postRows] = await Promise.all([
    prisma.media.findMany({ select: { id: true, url: true, storageKey: true, bucket: true } }),
    prisma.post.findMany({ select: { id: true, title: true, heroImageUrl: true, contentHtml: true, contentJson: true } })
  ]);

  const uses = new Map<string, ImageUse>();
  const add = (url: string, mediaId?: string, postId?: string) => {
    if (!url.startsWith(WORDPRESS_PREFIX)) return;
    const use = uses.get(url) ?? { url, mediaIds: [], postIds: [] };
    if (mediaId && !use.mediaIds.includes(mediaId)) use.mediaIds.push(mediaId);
    if (postId && !use.postIds.includes(postId)) use.postIds.push(postId);
    uses.set(url, use);
  };
  for (const media of mediaRows) add(media.url, media.id);
  for (const post of postRows) {
    if (post.heroImageUrl) add(post.heroImageUrl, undefined, post.id);
    for (const url of extractUrls(post.contentHtml ?? '')) add(url, undefined, post.id);
    for (const url of collectUrlsFromJson(post.contentJson)) add(url, undefined, post.id);
  }

  const migrated = new Map<string, Migrated>();
  const failures: Array<{ url: string; error: string }> = [];
  const alreadyCloudFront = mediaRows.filter((media) => media.url.startsWith(`${CLOUDFRONT_URL}/`)).length + postRows.filter((post) => post.heroImageUrl?.startsWith(`${CLOUDFRONT_URL}/`)).length;
  console.log(`Images WordPress uniques à traiter: ${uses.size}`);
  console.log(`Références déjà CloudFront détectées (Media.url + Post.heroImageUrl): ${alreadyCloudFront}`);

  for (const sourceUrl of uses.keys()) {
    const existing = mediaRows.find((media) => media.url === sourceUrl && media.storageKey && media.bucket === BUCKET);
    const key = existing?.storageKey ?? await uniqueKey(keyFromWordpressUrl(sourceUrl), sourceUrl);
    const cloudFrontUrl = `${CLOUDFRONT_URL}/${key}`;
    console.log(`- ${sourceUrl}`);
    console.log(`  clé S3 prévue: ${key}`);
    console.log(`  remplacement prévu: ${cloudFrontUrl}`);
    if (dryRun) {
      migrated.set(sourceUrl, { sourceUrl, cloudFrontUrl, key });
      continue;
    }
    try {
      const file = await download(sourceUrl);
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: file.body, ContentType: file.mimeType, CacheControl: 'public, max-age=31536000, immutable' }));
      migrated.set(sourceUrl, { sourceUrl, cloudFrontUrl, key, mimeType: file.mimeType, sizeBytes: file.sizeBytes });
    } catch (error) {
      failures.push({ url: sourceUrl, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!dryRun && migrated.size) {
    const replacements = new Map([...migrated].map(([from, item]) => [from, item.cloudFrontUrl]));
    for (const media of mediaRows) {
      const item = migrated.get(media.url);
      if (!item) continue;
      await prisma.media.update({ where: { id: media.id }, data: { url: item.cloudFrontUrl, storageKey: item.key, bucket: BUCKET, source: 's3', mimeType: item.mimeType, sizeBytes: item.sizeBytes } });
    }
    for (const post of postRows) {
      const data: Prisma.PostUpdateInput = {};
      if (post.heroImageUrl && replacements.has(post.heroImageUrl)) data.heroImageUrl = replacements.get(post.heroImageUrl);
      if (post.contentHtml) {
        let next = post.contentHtml;
        for (const [from, to] of replacements) next = next.split(from).join(to);
        if (next !== post.contentHtml) data.contentHtml = next;
      }
      const nextJson = replaceInJson(post.contentJson, replacements);
      if (JSON.stringify(nextJson) !== JSON.stringify(post.contentJson)) data.contentJson = nextJson as Prisma.InputJsonValue;
      if (Object.keys(data).length) await prisma.post.update({ where: { id: post.id }, data });
    }
  }

  console.log(`Succès: ${migrated.size}; échecs: ${failures.length}; dry-run: ${dryRun}`);
  for (const failure of failures) console.error(`Échec: ${failure.url} — ${failure.error}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('DATABASE_URL') || message.includes('connect') || message.includes("Can't reach database")) {
    console.warn('DATABASE_URL indisponible ou base inaccessible: le dry-run/la migration doit être lancé(e) sur Render ou dans un environnement connecté à la base.');
    return;
  }
  throw error;
}).finally(async () => prisma.$disconnect());
