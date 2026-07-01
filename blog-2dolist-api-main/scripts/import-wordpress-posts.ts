import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient, PostStatus, SeoEntityType } from '@prisma/client';

const prisma = new PrismaClient();
const DEFAULT_SOURCE_FILE = 'data/import/wordpress-posts-import.json';
const REPORT_FILE = path.resolve('data/import/wordpress-import-result.md');
const dryRun = process.argv.includes('--dry-run');

function getArgValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceFile = path.resolve(getArgValue('--file') ?? DEFAULT_SOURCE_FILE);

type WordpressPostImport = {
  path?: unknown;
  slug?: unknown;
  locale?: unknown;
  title?: unknown;
  h1?: unknown;
  contentHtml?: unknown;
  excerpt?: unknown;
  chapoHtml?: unknown;
  metaTitle?: unknown;
  metaDescription?: unknown;
  canonicalUrl?: unknown;
  robots?: unknown;
  publishedAt?: unknown;
  updatedAt?: unknown;
  categoryName?: unknown;
  categorySlug?: unknown;
  authorName?: unknown;
  authorSlug?: unknown;
  coverImageUrl?: unknown;
  coverImageAlt?: unknown;
  tags?: unknown;
  faqJson?: unknown;
  status?: unknown;
  isActive?: unknown;
  isIndexable?: unknown;
};

type ValidPost = Required<Pick<WordpressPostImport, 'path' | 'slug' | 'locale' | 'title' | 'contentHtml' | 'status'>> & WordpressPostImport & {
  path: string;
  slug: string;
  locale: 'fr';
  title: string;
  contentHtml: string;
  status: 'PUBLISHED';
  tags: string[];
};

type Counters = Record<'postsCreated' | 'postsUpdated' | 'categoriesCreated' | 'categoriesReused' | 'authorsCreated' | 'authorsReused' | 'mediaCreated' | 'mediaReused' | 'tagsCreated', number>;

const counters: Counters = {
  postsCreated: 0,
  postsUpdated: 0,
  categoriesCreated: 0,
  categoriesReused: 0,
  authorsCreated: 0,
  authorsReused: 0,
  mediaCreated: 0,
  mediaReused: 0,
  tagsCreated: 0
};
const importedPosts: Array<{ slug: string; path: string; action: 'created' | 'updated' }> = [];
const errors: string[] = [];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalString(value: unknown): string | null {
  const stringValue = asString(value)?.trim();
  return stringValue ? stringValue : null;
}

function parseDate(value: unknown): Date | null {
  const stringValue = optionalString(value);
  if (!stringValue) return null;
  const date = new Date(stringValue);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))];
}

function validate(rows: unknown): ValidPost[] {
  if (!Array.isArray(rows)) throw new Error('Le fichier JSON doit contenir un tableau d’articles.');

  const seenPaths = new Set<string>();
  const seenSlugs = new Set<string>();
  const validationErrors: string[] = [];
  const validPosts: ValidPost[] = [];

  rows.forEach((rawRow, index) => {
    const row = rawRow as WordpressPostImport;
    const rowNumber = index + 1;
    const itemErrors: string[] = [];
    const postPath = asString(row.path);
    const slug = asString(row.slug);
    const locale = asString(row.locale);
    const title = asString(row.title);
    const contentHtml = asString(row.contentHtml);
    const status = asString(row.status);

    if (!postPath) itemErrors.push('path manquant');
    if (!slug) itemErrors.push('slug manquant');
    if (!title) itemErrors.push('title manquant');
    if (!contentHtml) itemErrors.push('contentHtml manquant');
    if (locale !== 'fr') itemErrors.push(`locale invalide (${locale ?? 'absente'})`);
    if (status !== 'PUBLISHED') itemErrors.push(`status invalide (${status ?? 'absent'})`);
    if (postPath && !postPath.startsWith('/')) itemErrors.push(`path invalide sans slash initial (${postPath})`);

    if (postPath && locale) {
      const pathKey = `${locale}:${postPath}`;
      if (seenPaths.has(pathKey)) itemErrors.push(`doublon path par locale (${pathKey})`);
      seenPaths.add(pathKey);
    }

    if (slug && locale) {
      const slugKey = `${locale}:${slug}`;
      if (seenSlugs.has(slugKey)) itemErrors.push(`doublon slug par locale (${slugKey})`);
      seenSlugs.add(slugKey);
    }

    if (itemErrors.length > 0) {
      validationErrors.push(`Ligne ${rowNumber}: ${itemErrors.join(', ')}`);
      return;
    }

    validPosts.push({ ...row, path: postPath!, slug: slug!, locale: 'fr', title: title!, contentHtml: contentHtml!, status: 'PUBLISHED', tags: normalizeTags(row.tags) });
  });

  if (validationErrors.length > 0) throw new Error(`Import annulé: erreurs bloquantes détectées.\n${validationErrors.join('\n')}`);
  return validPosts;
}

async function main() {
  const raw = await fs.readFile(sourceFile, 'utf8');
  const posts = validate(JSON.parse(raw));

  console.log(`Fichier source: ${path.relative(process.cwd(), sourceFile)}`);
  console.log(`Validation OK: ${posts.length} article(s) publiés prêts à importer.`);
  console.log(dryRun ? 'Mode dry-run: aucune écriture en base ni rapport ne sera effectuée.' : 'Mode import réel: écriture en base activée.');

  const canInspectDatabase = !dryRun || Boolean(process.env.DATABASE_URL);
  if (dryRun && !canInspectDatabase) {
    console.log('DATABASE_URL absente: le dry-run valide le JSON et liste les opérations potentielles sans interroger la base.');
  }

  for (const post of posts) {
    if (dryRun && !canInspectDatabase) {
      console.log(`UPSERT potentiel post ${post.slug} -> ${post.path}`);
      continue;
    }

    const existingByPath = await prisma.post.findUnique({ where: { locale_path: { locale: post.locale, path: post.path } } });
    const existingBySlug = existingByPath ? null : await prisma.post.findUnique({ where: { locale_slug: { locale: post.locale, slug: post.slug } } });
    const existingPost = existingByPath ?? existingBySlug;
    const author = await prisma.author.findUnique({ where: { slug: asString(post.authorSlug) ?? '' } });
    const category = optionalString(post.categorySlug) ? await prisma.category.findUnique({ where: { slug: optionalString(post.categorySlug)! } }) : null;
    const media = optionalString(post.coverImageUrl) ? await prisma.media.findFirst({ where: { url: optionalString(post.coverImageUrl)! } }) : null;
    const existingTags = post.tags.length > 0 ? await prisma.tag.findMany({ where: { slug: { in: post.tags } }, select: { slug: true } }) : [];

    if (dryRun) {
      console.log(`${existingPost ? 'UPDATE' : 'CREATE'} post ${post.slug} -> ${post.path}`);
      if (!author) console.log(`  CREATE author ${asString(post.authorSlug)}`);
      if (optionalString(post.categorySlug) && !category) console.log(`  CREATE category ${optionalString(post.categorySlug)}`);
      if (optionalString(post.coverImageUrl) && !media) console.log(`  CREATE media ${optionalString(post.coverImageUrl)}`);
      const existingTagSlugs = new Set(existingTags.map((tag) => tag.slug));
      post.tags.filter((tag) => !existingTagSlugs.has(tag)).forEach((tag) => console.log(`  CREATE tag ${tag}`));
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const authorSlug = optionalString(post.authorSlug) ?? 'wordpress-author';
      const foundAuthor = await tx.author.findUnique({ where: { slug: authorSlug } });
      const savedAuthor = foundAuthor ?? await tx.author.create({ data: { name: optionalString(post.authorName) ?? authorSlug, slug: authorSlug } });
      counters[foundAuthor ? 'authorsReused' : 'authorsCreated']++;

      const categorySlug = optionalString(post.categorySlug);
      const savedCategory = categorySlug ? await (async () => {
        const foundCategory = await tx.category.findUnique({ where: { slug: categorySlug } });
        if (foundCategory) {
          counters.categoriesReused++;
          return foundCategory;
        }
        counters.categoriesCreated++;
        return tx.category.create({ data: { name: optionalString(post.categoryName) ?? categorySlug, slug: categorySlug } });
      })() : null;

      const coverUrl = optionalString(post.coverImageUrl);
      const savedMedia = coverUrl ? await (async () => {
        const foundMedia = await tx.media.findFirst({ where: { url: coverUrl } });
        if (foundMedia) {
          counters.mediaReused++;
          return foundMedia;
        }
        counters.mediaCreated++;
        return tx.media.create({ data: { url: coverUrl, altText: optionalString(post.coverImageAlt), source: 'WORDPRESS' } });
      })() : null;

      const postData: Prisma.PostUncheckedCreateInput = {
        slug: post.slug,
        path: post.path,
        locale: post.locale,
        title: post.title,
        h1: optionalString(post.h1),
        excerpt: optionalString(post.excerpt),
        chapoHtml: optionalString(post.chapoHtml),
        contentHtml: post.contentHtml,
        contentMarkdown: '',
        faqJson: post.faqJson === undefined ? undefined : post.faqJson as Prisma.InputJsonValue,
        status: PostStatus.PUBLISHED,
        isActive: true,
        isIndexable: true,
        publishedAt: parseDate(post.publishedAt),
        metaTitle: optionalString(post.metaTitle) ?? post.title,
        metaDescription: optionalString(post.metaDescription),
        canonicalUrl: optionalString(post.canonicalUrl),
        robots: optionalString(post.robots) ?? 'index,follow',
        categorySlug: savedCategory?.slug,
        authorId: savedAuthor.id,
        categoryId: savedCategory?.id,
        coverImageId: savedMedia?.id,
        heroImageUrl: coverUrl,
        heroImageAlt: optionalString(post.coverImageAlt)
      };

      const currentPost = await tx.post.findUnique({ where: { locale_path: { locale: post.locale, path: post.path } } })
        ?? await tx.post.findUnique({ where: { locale_slug: { locale: post.locale, slug: post.slug } } });
      const savedPost = currentPost
        ? await tx.post.update({ where: { id: currentPost.id }, data: postData as Prisma.PostUncheckedUpdateInput })
        : await tx.post.create({ data: postData });
      counters[currentPost ? 'postsUpdated' : 'postsCreated']++;
      importedPosts.push({ slug: savedPost.slug, path: savedPost.path ?? '', action: currentPost ? 'updated' : 'created' });

      await tx.seoMetadata.upsert({
        where: { postId: savedPost.id },
        update: { entityType: SeoEntityType.POST, title: optionalString(post.metaTitle) ?? post.title, description: optionalString(post.metaDescription), canonicalUrl: optionalString(post.canonicalUrl), noIndex: false, openGraphImageId: savedMedia?.id },
        create: { entityType: SeoEntityType.POST, postId: savedPost.id, title: optionalString(post.metaTitle) ?? post.title, description: optionalString(post.metaDescription), canonicalUrl: optionalString(post.canonicalUrl), noIndex: false, openGraphImageId: savedMedia?.id }
      });

      await tx.postTag.deleteMany({ where: { postId: savedPost.id } });
      for (const tagSlug of post.tags) {
        const foundTag = await tx.tag.findUnique({ where: { slug: tagSlug } });
        const tag = foundTag ?? await tx.tag.create({ data: { name: tagSlug, slug: tagSlug } });
        if (!foundTag) counters.tagsCreated++;
        await tx.postTag.upsert({ where: { postId_tagId: { postId: savedPost.id, tagId: tag.id } }, update: {}, create: { postId: savedPost.id, tagId: tag.id } });
      }
    });
  }

  if (!dryRun) {
    await fs.writeFile(REPORT_FILE, buildReport(), 'utf8');
    console.log(`Rapport écrit: ${path.relative(process.cwd(), REPORT_FILE)}`);
  }
}

function buildReport(): string {
  return `# Rapport d’import WordPress\n\n- Articles créés: ${counters.postsCreated}\n- Articles mis à jour: ${counters.postsUpdated}\n- Catégories créées: ${counters.categoriesCreated}\n- Catégories réutilisées: ${counters.categoriesReused}\n- Auteurs créés: ${counters.authorsCreated}\n- Auteurs réutilisés: ${counters.authorsReused}\n- Médias créés: ${counters.mediaCreated}\n- Médias réutilisés: ${counters.mediaReused}\n- Tags créés: ${counters.tagsCreated}\n- Erreurs éventuelles: ${errors.length > 0 ? errors.join('; ') : 'aucune'}\n\n## Articles importés\n\n${importedPosts.map((post) => `- ${post.action}: ${post.slug} — ${post.path}`).join('\n')}\n`;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
