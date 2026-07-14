import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const WORDPRESS_PREFIX = 'https://blog.2dolist.fr/wp-content/uploads/';
const CLOUDFRONT_PREFIX = normalizePrefix(process.env.AWS_CLOUDFRONT_URL ?? 'https://d140u74ocia07i.cloudfront.net');
const REPORT_FILE = path.resolve('data/import/wordpress-images-report.md');

type ImageRef = {
  url: string;
  location: 'Media.url' | 'Post.heroImageUrl' | 'Post.contentHtml' | 'Post.contentJson.blocks';
  postId?: string;
  postTitle?: string;
  postSlug?: string;
  postPath?: string | null;
  mediaId?: string;
};

type InvalidRef = Omit<ImageRef, 'url'> & { value: string | null | undefined; reason: string };

function normalizePrefix(value: string): string {
  return value.replace(/\/+$/, '');
}

function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s"'<>\\)]+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, '')))];
}

function collectUrlsFromJson(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const url of extractUrls(node)) urls.add(url);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const item of Object.values(node as Record<string, unknown>)) visit(item);
    }
  };
  visit(value);
  return [...urls];
}

function isRelevantImage(url: string): boolean {
  return url.startsWith(WORDPRESS_PREFIX) || url.startsWith(`${CLOUDFRONT_PREFIX}/`);
}

function isInvalidUrl(value: unknown): value is string | null | undefined {
  if (value == null) return true;
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    return !['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return true;
  }
}

function addUrl(refs: ImageRef[], url: string, base: Omit<ImageRef, 'url'>): void {
  if (isRelevantImage(url)) refs.push({ ...base, url });
}

function summarize(refs: ImageRef[]) {
  const wordpress = refs.filter((ref) => ref.url.startsWith(WORDPRESS_PREFIX));
  const cloudfront = refs.filter((ref) => ref.url.startsWith(`${CLOUDFRONT_PREFIX}/`));
  return {
    wordpressRefs: wordpress.length,
    wordpressUnique: new Set(wordpress.map((ref) => ref.url)).size,
    cloudfrontRefs: cloudfront.length,
    cloudfrontUnique: new Set(cloudfront.map((ref) => ref.url)).size
  };
}

async function writeUnavailableReport(reason: string): Promise<void> {
  const report = [
    '# Rapport images WordPress → S3 / CloudFront',
    '',
    `Généré le ${new Date().toISOString()}.`,
    '',
    '## Réponse rapide',
    '',
    '- Images encore servies depuis WordPress : non vérifiable localement.',
    '- Images déjà servies depuis CloudFront : non vérifiable localement.',
    '- Images uniques restant à migrer : non vérifiable localement.',
    '',
    '## Diagnostic',
    '',
    `Le diagnostic réel doit être lancé dans un environnement qui dispose de DATABASE_URL (par exemple Render). Raison locale: ${reason}.`,
    ''
  ].join('\n');
  await fs.mkdir(path.dirname(REPORT_FILE), { recursive: true });
  await fs.writeFile(REPORT_FILE, report, 'utf8');
  console.warn(`DATABASE_URL indisponible ou base inaccessible: ${reason}`);
  console.warn(`Rapport partiel écrit dans ${REPORT_FILE}`);
}

async function main(): Promise<void> {
  const refs: ImageRef[] = [];
  const invalids: InvalidRef[] = [];

  const [mediaRows, postRows] = await Promise.all([
    prisma.media.findMany({ select: { id: true, url: true } }),
    prisma.post.findMany({
      select: { id: true, title: true, slug: true, path: true, heroImageUrl: true, contentHtml: true, contentJson: true },
      orderBy: { updatedAt: 'desc' }
    })
  ]);

  for (const media of mediaRows) {
    if (isInvalidUrl(media.url)) invalids.push({ location: 'Media.url', mediaId: media.id, value: media.url, reason: 'URL vide ou invalide' });
    else addUrl(refs, media.url, { location: 'Media.url', mediaId: media.id });
  }

  for (const post of postRows) {
    const postInfo = { postId: post.id, postTitle: post.title, postSlug: post.slug, postPath: post.path };
    if (post.heroImageUrl != null) {
      if (isInvalidUrl(post.heroImageUrl)) invalids.push({ ...postInfo, location: 'Post.heroImageUrl', value: post.heroImageUrl, reason: 'URL vide ou invalide' });
      else addUrl(refs, post.heroImageUrl, { ...postInfo, location: 'Post.heroImageUrl' });
    }
    for (const url of extractUrls(post.contentHtml ?? '')) addUrl(refs, url, { ...postInfo, location: 'Post.contentHtml' });
    const blocks = (post.contentJson && typeof post.contentJson === 'object' && !Array.isArray(post.contentJson) && 'blocks' in post.contentJson)
      ? (post.contentJson as { blocks?: unknown }).blocks
      : post.contentJson;
    for (const url of collectUrlsFromJson(blocks)) addUrl(refs, url, { ...postInfo, location: 'Post.contentJson.blocks' });
  }

  const byLocation = refs.reduce<Record<string, { wordpress: number; cloudfront: number }>>((acc, ref) => {
    acc[ref.location] ??= { wordpress: 0, cloudfront: 0 };
    if (ref.url.startsWith(WORDPRESS_PREFIX)) acc[ref.location].wordpress += 1;
    if (ref.url.startsWith(`${CLOUDFRONT_PREFIX}/`)) acc[ref.location].cloudfront += 1;
    return acc;
  }, {});
  const affectedPosts = [...new Map(refs.filter((ref) => ref.postId).map((ref) => [ref.postId, ref])).values()];
  const summary = summarize(refs);

  const report = [
    '# Rapport images WordPress → S3 / CloudFront',
    '',
    `Généré le ${new Date().toISOString()}.`,
    '',
    '## Réponse rapide',
    '',
    `- Images encore servies depuis WordPress : ${summary.wordpressRefs > 0 ? 'oui' : 'non'} (${summary.wordpressRefs} référence(s), ${summary.wordpressUnique} URL(s) unique(s)).`,
    `- Images déjà servies depuis CloudFront : ${summary.cloudfrontRefs > 0 ? 'oui' : 'non'} (${summary.cloudfrontRefs} référence(s), ${summary.cloudfrontUnique} URL(s) unique(s)).`,
    `- Images uniques restant à migrer : ${summary.wordpressUnique}.`,
    '',
    '## Détail par emplacement',
    '',
    '| Emplacement | WordPress | CloudFront |',
    '| --- | ---: | ---: |',
    ...['Media.url', 'Post.heroImageUrl', 'Post.contentHtml', 'Post.contentJson.blocks'].map((location) => `| ${location} | ${byLocation[location]?.wordpress ?? 0} | ${byLocation[location]?.cloudfront ?? 0} |`),
    '',
    '## Articles concernés',
    '',
    affectedPosts.length ? affectedPosts.map((ref) => `- ${ref.postTitle ?? ref.postSlug} (${ref.postPath ?? ref.postSlug})`).join('\n') : 'Aucun article concerné détecté.',
    '',
    '## Images invalides ou vides',
    '',
    invalids.length ? invalids.map((ref) => `- ${ref.location}${ref.postTitle ? ` — ${ref.postTitle}` : ''}${ref.mediaId ? ` — media ${ref.mediaId}` : ''}: ${ref.reason}`).join('\n') : 'Aucune image invalide ou vide détectée.',
    '',
    '## URLs WordPress uniques',
    '',
    summary.wordpressUnique ? [...new Set(refs.filter((ref) => ref.url.startsWith(WORDPRESS_PREFIX)).map((ref) => ref.url))].map((url) => `- ${url}`).join('\n') : 'Aucune.',
    '',
    '## URLs CloudFront uniques',
    '',
    summary.cloudfrontUnique ? [...new Set(refs.filter((ref) => ref.url.startsWith(`${CLOUDFRONT_PREFIX}/`)).map((ref) => ref.url))].map((url) => `- ${url}`).join('\n') : 'Aucune.',
    ''
  ].join('\n');

  await fs.mkdir(path.dirname(REPORT_FILE), { recursive: true });
  await fs.writeFile(REPORT_FILE, report, 'utf8');
  console.log(`Rapport écrit dans ${REPORT_FILE}`);
  console.log(`WordPress: ${summary.wordpressRefs} référence(s), ${summary.wordpressUnique} URL(s) unique(s).`);
  console.log(`CloudFront: ${summary.cloudfrontRefs} référence(s), ${summary.cloudfrontUnique} URL(s) unique(s).`);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('DATABASE_URL') || message.includes('connect') || message.includes("Can\'t reach database")) {
    await writeUnavailableReport(message.split('\n')[0] ?? message);
    return;
  }
  throw error;
}).finally(async () => prisma.$disconnect());
