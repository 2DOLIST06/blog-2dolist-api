import 'dotenv/config';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PostStatus, Prisma, PrismaClient, SeoEntityType } from '@prisma/client';
import { fileTypeFromBuffer } from 'file-type';
import { removeWordpressCommentsBlocks } from '../src/lib/wordpress-comments-cleaner.js';
import { normalizeWordpressContent } from '../src/lib/wordpress-content-normalizer.js';

const DEFAULT_SOURCE = 'data/import/import_7_articles_manquants_wordpress.json';
const WORDPRESS_UPLOADS = 'https://blog.2dolist.fr/wp-content/uploads/';
const AUTHOR_SLUG = process.env.WORDPRESS_IMPORT_AUTHOR_SLUG ?? 'nicolas-braun';
const REGION = process.env.AWS_REGION ?? 'eu-west-3';
const BUCKET = process.env.AWS_S3_BUCKET_NAME ?? 'blog-2dolist-media-prod';
const CLOUDFRONT = (process.env.AWS_CLOUDFRONT_URL ?? 'https://d140u74ocia07i.cloudfront.net').replace(/\/+$/, '');
const MAX_BYTES = Number(process.env.AWS_S3_UPLOAD_MAX_BYTES ?? 15 * 1024 * 1024);
const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient();
const s3 = new S3Client({ region: REGION });

type SourcePost = {
  title: string;
  slug: string;
  path: string;
  locale: 'fr';
  status: 'PUBLISHED';
  publishedAt: string;
  updatedAt: string;
  excerpt?: string | null;
  contentHtml: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
  heroImageUrl?: string | null;
  heroImageAlt?: string | null;
  categoryPaths: string[];
  primaryCategoryPath: string;
};

type PreparedPost = SourcePost & {
  cleanHtml: string;
  contentJson: Prisma.InputJsonValue;
  faqJson: Prisma.InputJsonValue | undefined;
  imageUrls: string[];
  commentBlocks: number;
  faqCount: number;
};

function argument(name: string): string | undefined {
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function exactOptional(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function imageUrls(value: string): string[] {
  return [...new Set((value.match(/https?:\/\/[^\s"'<>\\)]+/g) ?? [])
    .map((url) => url.replace(/[.,;:!?]+$/, ''))
    .filter((url) => url.startsWith(WORDPRESS_UPLOADS)))];
}

function validate(value: unknown): SourcePost[] {
  if (!Array.isArray(value)) throw new Error('Le fichier source doit contenir un tableau JSON.');
  const paths = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Article ${index + 1}: objet attendu.`);
    const row = raw as Record<string, unknown>;
    for (const field of ['title', 'slug', 'path', 'contentHtml', 'publishedAt', 'updatedAt', 'primaryCategoryPath']) {
      if (typeof row[field] !== 'string' || row[field] === '') throw new Error(`Article ${index + 1}: ${field} est obligatoire.`);
    }
    if (row.locale !== 'fr') throw new Error(`Article ${index + 1}: locale doit valoir fr.`);
    if (row.status !== 'PUBLISHED') throw new Error(`Article ${index + 1}: status doit valoir PUBLISHED.`);
    if (!(row.path as string).startsWith('/') || (row.path as string).startsWith('/fr/') || (row.path as string).startsWith('/articles/')) {
      throw new Error(`Article ${index + 1}: path public interdit ou invalide (${String(row.path)}).`);
    }
    if (paths.has(row.path as string)) throw new Error(`Path dupliqué dans la source: ${String(row.path)}.`);
    paths.add(row.path as string);
    if (Number.isNaN(new Date(row.publishedAt as string).getTime()) || Number.isNaN(new Date(row.updatedAt as string).getTime())) {
      throw new Error(`Article ${index + 1}: date invalide.`);
    }
    if (!Array.isArray(row.categoryPaths) || row.categoryPaths.some((item) => typeof item !== 'string')) {
      throw new Error(`Article ${index + 1}: categoryPaths doit être un tableau de paths.`);
    }
    if (!(row.categoryPaths as string[]).includes(row.primaryCategoryPath as string)) {
      throw new Error(`Article ${index + 1}: primaryCategoryPath doit appartenir à categoryPaths.`);
    }
    return row as SourcePost;
  });
}

function prepare(post: SourcePost): PreparedPost {
  const comments = removeWordpressCommentsBlocks(post.contentHtml);
  const normalized = normalizeWordpressContent({ contentHtml: comments.value });
  const urls = new Set([...imageUrls(normalized.contentHtml), ...imageUrls(post.heroImageUrl ?? '')]);
  return {
    ...post,
    cleanHtml: normalized.contentHtml,
    contentJson: normalized.contentJson as Prisma.InputJsonValue,
    faqJson: normalized.faqJson.length ? normalized.faqJson as Prisma.InputJsonValue : undefined,
    imageUrls: [...urls],
    commentBlocks: comments.blocksRemoved,
    faqCount: normalized.faqJson.length,
  };
}

function storageKey(sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  const decoded = decodeURIComponent(parsed.pathname);
  const match = decoded.match(/\/wp-content\/uploads\/(\d{4})\/(\d{2})\/([^/?#]+)$/);
  const name = (match?.[3] ?? decoded.split('/').pop() ?? 'wordpress-image')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wordpress-image';
  const hash = match ? '' : `-${crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 8)}`;
  return `wordpress-import/${match?.[1] ?? 'unknown'}/${match?.[2] ?? 'unknown'}/${name}${hash}`;
}

async function migrateImage(sourceUrl: string): Promise<{ url: string; key: string; mimeType?: string; sizeBytes?: number }> {
  const key = storageKey(sourceUrl);
  const url = `${CLOUDFRONT}/${key}`;
  if (dryRun) return { url, key };
  let exists = false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    exists = true;
  } catch {
    // A missing object is uploaded below. Authentication/network errors surface on PutObject.
  }
  if (exists) return { url, key };
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Téléchargement impossible (${response.status}) pour ${sourceUrl}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error(`Image trop volumineuse (${body.length} octets): ${sourceUrl}`);
  const detected = await fileTypeFromBuffer(body);
  const mimeType = detected?.mime ?? response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: mimeType, CacheControl: 'public, max-age=31536000, immutable' }));
  return { url, key, mimeType, sizeBytes: body.length };
}

async function main(): Promise<void> {
  const source = path.resolve(argument('--file') ?? DEFAULT_SOURCE);
  const posts = validate(JSON.parse(await fs.readFile(source, 'utf8'))).map(prepare);
  console.log(`Source: ${path.relative(process.cwd(), source)}`);
  console.log(`Mode: ${dryRun ? 'dry-run' : 'import réel'}`);
  console.log(`Articles valides: ${posts.length}`);

  const uniqueImages = [...new Set(posts.flatMap((post) => post.imageUrls))];
  console.log(`Images WordPress détectées (${uniqueImages.length}):`);
  uniqueImages.forEach((url) => console.log(`  - ${url} -> ${CLOUDFRONT}/${storageKey(url)}`));
  console.log(`FAQ Yoast détectées (${posts.reduce((total, post) => total + post.faqCount, 0)} question(s)):`);
  posts.filter((post) => post.faqCount).forEach((post) => console.log(`  - ${post.path}: ${post.faqCount}`));
  console.log(`Blocs commentaires détectés (${posts.reduce((total, post) => total + post.commentBlocks, 0)}):`);
  posts.filter((post) => post.commentBlocks).forEach((post) => console.log(`  - ${post.path}: ${post.commentBlocks}`));

  if (!process.env.DATABASE_URL) {
    if (!dryRun) throw new Error('DATABASE_URL est obligatoire pour importer.');
    console.log('Articles à créer: non vérifiables (DATABASE_URL absente)');
    console.log('Articles déjà présents: non vérifiables (DATABASE_URL absente)');
    console.log('Catégories trouvées: non vérifiables (DATABASE_URL absente)');
    console.log(`Catégories manquantes: non vérifiables (paths demandés: ${[...new Set(posts.map((post) => post.primaryCategoryPath))].join(', ')})`);
    return;
  }

  const existing = await prisma.post.findMany({ where: { locale: 'fr', path: { in: posts.map((post) => post.path) } }, select: { path: true } });
  const existingPaths = new Set(existing.flatMap((post) => post.path ? [post.path] : []));
  const categoryPaths = [...new Set(posts.flatMap((post) => post.categoryPaths))];
  const categories = await prisma.category.findMany({ where: { path: { in: categoryPaths } }, select: { id: true, path: true, slug: true } });
  const categoryByPath = new Map(categories.flatMap((category) => category.path ? [[category.path, category] as const] : []));
  const missingCategories = categoryPaths.filter((categoryPath) => !categoryByPath.has(categoryPath));
  const toCreate = posts.filter((post) => !existingPaths.has(post.path));
  const missingCategoriesForCreation = [...new Set(toCreate.map((post) => post.primaryCategoryPath))]
    .filter((categoryPath) => !categoryByPath.has(categoryPath));
  console.log(`Articles à créer (${toCreate.length}):`); toCreate.forEach((post) => console.log(`  - ${post.path}`));
  console.log(`Articles déjà présents (${existingPaths.size}):`); existingPaths.forEach((postPath) => console.log(`  - ${postPath}`));
  console.log(`Catégories trouvées (${categories.length}):`); categories.forEach((category) => console.log(`  - ${category.path}`));
  console.log(`Catégories manquantes (${missingCategories.length}):`); missingCategories.forEach((categoryPath) => console.log(`  - ${categoryPath}`));
  if (missingCategoriesForCreation.length) throw new Error('Import annulé: toutes les catégories des articles à créer doivent exister; aucune catégorie ne sera créée.');
  if (dryRun || toCreate.length === 0) return;
  const author = await prisma.author.findUnique({ where: { slug: AUTHOR_SLUG } });
  if (!author) throw new Error(`Auteur existant introuvable: ${AUTHOR_SLUG}.`);

  const migrated = new Map<string, Awaited<ReturnType<typeof migrateImage>>>();
  for (const url of [...new Set(toCreate.flatMap((post) => post.imageUrls))]) migrated.set(url, await migrateImage(url));
  const replaceJson = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let next = value;
      for (const [sourceUrl, image] of migrated) next = next.split(sourceUrl).join(image.url);
      return next;
    }
    if (Array.isArray(value)) return value.map(replaceJson);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceJson(item)]));
    }
    return value;
  };
  let created = 0;
  for (const post of toCreate) {
    const category = categoryByPath.get(post.primaryCategoryPath)!;
    const replace = (value: string): string => {
      let next = value;
      for (const [sourceUrl, image] of migrated) next = next.split(sourceUrl).join(image.url);
      return next;
    };
    await prisma.$transaction(async (tx) => {
      // Recheck under the transaction so reruns never overwrite an existing path.
      if (await tx.post.findUnique({ where: { locale_path: { locale: 'fr', path: post.path } } })) return;
      const heroSource = exactOptional(post.heroImageUrl);
      const hero = heroSource ? migrated.get(heroSource) : undefined;
      let coverImageId: string | undefined;
      if (hero) {
        const media = await tx.media.findFirst({ where: { url: hero.url } }) ?? await tx.media.create({
          data: { url: hero.url, altText: exactOptional(post.heroImageAlt), source: 's3', storageKey: hero.key, bucket: BUCKET, mimeType: hero.mimeType, sizeBytes: hero.sizeBytes },
        });
        coverImageId = media.id;
      }
      const saved = await tx.post.create({ data: {
        title: post.title, slug: post.slug, path: post.path, locale: 'fr', status: PostStatus.PUBLISHED,
        isActive: true, isIndexable: true, robots: 'index,follow', contentMarkdown: '',
        contentHtml: replace(post.cleanHtml), contentJson: replaceJson(post.contentJson) as Prisma.InputJsonValue, faqJson: post.faqJson,
        excerpt: exactOptional(post.excerpt), metaTitle: exactOptional(post.metaTitle),
        metaDescription: exactOptional(post.metaDescription), canonicalUrl: exactOptional(post.canonicalUrl),
        heroImageUrl: hero?.url ?? heroSource, heroImageAlt: exactOptional(post.heroImageAlt), coverImageId,
        categoryId: category.id, categorySlug: category.slug, authorId: author.id,
        publishedAt: new Date(post.publishedAt), updatedAt: new Date(post.updatedAt),
      } });
      await tx.seoMetadata.create({ data: { entityType: SeoEntityType.POST, postId: saved.id, title: exactOptional(post.metaTitle), description: exactOptional(post.metaDescription), canonicalUrl: exactOptional(post.canonicalUrl), noIndex: false, openGraphImageId: coverImageId } });
      created++;
    });
  }
  const confirmed = await prisma.post.findMany({ where: { locale: 'fr', path: { in: posts.map((post) => post.path) } }, select: { path: true } });
  console.log(`Articles créés: ${created}`);
  console.log(`Articles ignorés car déjà présents: ${posts.length - created}`);
  console.log(`Paths confirmés en base: ${confirmed.length}/${posts.length}`);
  if (confirmed.length !== posts.length) throw new Error('Contrôle final échoué: certains paths sont absents.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
