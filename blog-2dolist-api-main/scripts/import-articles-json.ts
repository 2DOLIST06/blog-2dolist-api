import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient, PostStatus, SeoEntityType } from '@prisma/client';

const DEFAULT_SOURCE_FILE = 'data/import/articles-import.json';
const REPORT_FILE = path.resolve('data/import/articles-json-import-report.md');
const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

type RawArticle = Record<string, unknown>;
type Action = 'created' | 'reused';
type PostAction = 'created' | 'updated';

type Article = RawArticle & {
  path: string;
  slug: string;
  locale: string;
  status: PostStatus;
  isActive: boolean;
  isIndexable: boolean;
  title: string;
  tags?: string[];
};

type ResourceKind = 'categories' | 'authors' | 'media' | 'tags';

type Report = {
  source: string;
  read: number;
  valid: number;
  posts: Array<{ path: string; slug: string; action: PostAction }>;
  resources: Record<ResourceKind, Array<{ value: string; action: Action }>>;
  errors: string[];
  warnings: string[];
};

const report: Report = {
  source: '',
  read: 0,
  valid: 0,
  posts: [],
  resources: { categories: [], authors: [], media: [], tags: [] },
  errors: [],
  warnings: []
};

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceFile = path.resolve(argument('--file') ?? DEFAULT_SOURCE_FILE);
report.source = path.relative(process.cwd(), sourceFile) || sourceFile;

function has(row: RawArticle, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null {
  return nonEmptyString(value) ?? null;
}

function validDate(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(new Date(value).getTime());
}

function dateOrNull(value: unknown): Date | null {
  return validDate(value) ? new Date(value as string) : null;
}

function isJsonValue(value: unknown): value is Prisma.InputJsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function validate(input: unknown): Article[] {
  if (!Array.isArray(input)) {
    report.errors.push('Le document racine doit être un tableau JSON.');
    return [];
  }

  report.read = input.length;
  const articles: Article[] = [];
  const paths = new Set<string>();
  const slugs = new Set<string>();

  input.forEach((value, index) => {
    const label = `Article ${index + 1}`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      report.errors.push(`${label}: doit être un objet.`);
      return;
    }

    const row = value as RawArticle;
    const errors: string[] = [];
    const articlePath = nonEmptyString(row.path);
    const slug = nonEmptyString(row.slug);
    const title = nonEmptyString(row.title);
    const locale = has(row, 'locale') ? nonEmptyString(row.locale) : 'fr';
    const status = has(row, 'status') ? nonEmptyString(row.status) : PostStatus.PUBLISHED;
    const isActive = has(row, 'isActive') ? row.isActive : true;
    const isIndexable = has(row, 'isIndexable') ? row.isIndexable : true;
    const hasHtml = typeof row.contentHtml === 'string';
    const hasJson = has(row, 'contentJson') && row.contentJson !== null && isJsonValue(row.contentJson);

    if (!articlePath) errors.push('path est obligatoire');
    else if (!articlePath.startsWith('/')) errors.push('path doit commencer par /');
    if (!slug) errors.push('slug est obligatoire');
    if (!title) errors.push('title est obligatoire');
    if (!hasHtml && !hasJson) errors.push('contentHtml ou contentJson doit être présent');
    if (!locale) errors.push('locale doit être une chaîne non vide');
    if (!status || !Object.values(PostStatus).includes(status as PostStatus)) errors.push(`status invalide: ${String(row.status)}`);
    if (typeof isActive !== 'boolean') errors.push('isActive doit être un booléen');
    if (typeof isIndexable !== 'boolean') errors.push('isIndexable doit être un booléen');

    for (const field of [
      'h1', 'excerpt', 'chapoHtml', 'contentHtml', 'contentMarkdown', 'metaTitle',
      'metaDescription', 'canonicalUrl', 'robots', 'categoryName', 'categorySlug',
      'authorName', 'authorSlug', 'coverImageUrl', 'coverImageAlt', 'old_url'
    ]) {
      if (has(row, field) && row[field] !== null && typeof row[field] !== 'string') {
        errors.push(`${field} doit être une chaîne ou null`);
      }
    }

    for (const field of ['publishedAt', 'updatedAt']) {
      if (has(row, field) && row[field] !== null && !validDate(row[field])) errors.push(`${field} doit être une date ISO valide ou null`);
    }
    for (const field of ['contentJson', 'faqJson']) {
      if (has(row, field) && row[field] !== null && !isJsonValue(row[field])) errors.push(`${field} n'est pas une valeur JSON valide`);
    }
    if (has(row, 'tags') && !Array.isArray(row.tags)) errors.push('tags doit être un tableau de chaînes');
    if (Array.isArray(row.tags) && row.tags.some((tag) => !nonEmptyString(tag))) errors.push('chaque tag doit être une chaîne non vide');

    const pathKey = articlePath && locale ? `${locale}:${articlePath}` : undefined;
    const slugKey = slug && locale ? `${locale}:${slug}` : undefined;
    if (pathKey && paths.has(pathKey)) errors.push(`doublon locale + path dans le fichier (${pathKey})`);
    if (slugKey && slugs.has(slugKey)) errors.push(`doublon locale + slug dans le fichier (${slugKey})`);
    if (pathKey) paths.add(pathKey);
    if (slugKey) slugs.add(slugKey);

    if (errors.length) {
      report.errors.push(...errors.map((error) => `${label}: ${error}.`));
      return;
    }

    const tags = has(row, 'tags')
      ? [...new Set((row.tags as string[]).map((tag) => tag.trim()))]
      : undefined;
    articles.push({
      ...row,
      path: articlePath!,
      slug: slug!,
      title: title!,
      locale: locale!,
      status: status as PostStatus,
      isActive: isActive as boolean,
      isIndexable: isIndexable as boolean,
      tags
    });
  });

  report.valid = articles.length;
  return articles;
}

function rememberResource(kind: ResourceKind, value: string, action: Action): void {
  if (!report.resources[kind].some((item) => item.value === value)) report.resources[kind].push({ value, action });
}

async function inspect(article: Article): Promise<void> {
  const byPath = await prisma.post.findUnique({ where: { locale_path: { locale: article.locale, path: article.path } } });
  const bySlug = await prisma.post.findUnique({ where: { locale_slug: { locale: article.locale, slug: article.slug } } });
  if (byPath && bySlug && byPath.id !== bySlug.id) {
    throw new Error(`Conflit pour ${article.locale}:${article.path}: le path et le slug désignent deux articles différents.`);
  }
  report.posts.push({ path: article.path, slug: article.slug, action: byPath || bySlug ? 'updated' : 'created' });

  const authorSlug = nonEmptyString(article.authorSlug);
  if (authorSlug) rememberResource('authors', authorSlug, await prisma.author.findUnique({ where: { slug: authorSlug } }) ? 'reused' : 'created');
  const categorySlug = nonEmptyString(article.categorySlug);
  if (categorySlug) rememberResource('categories', categorySlug, await prisma.category.findUnique({ where: { slug: categorySlug } }) ? 'reused' : 'created');
  const mediaUrl = nonEmptyString(article.coverImageUrl);
  if (mediaUrl) rememberResource('media', mediaUrl, await prisma.media.findFirst({ where: { url: mediaUrl } }) ? 'reused' : 'created');
  if (article.tags?.length) {
    const found = new Set((await prisma.tag.findMany({ where: { slug: { in: article.tags } }, select: { slug: true } })).map((tag) => tag.slug));
    article.tags.forEach((tag) => rememberResource('tags', tag, found.has(tag) ? 'reused' : 'created'));
  }
}

async function save(article: Article): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const byPath = await tx.post.findUnique({ where: { locale_path: { locale: article.locale, path: article.path } } });
    const bySlug = await tx.post.findUnique({ where: { locale_slug: { locale: article.locale, slug: article.slug } } });
    if (byPath && bySlug && byPath.id !== bySlug.id) throw new Error(`le path et le slug désignent deux articles différents`);
    const existing = byPath ?? bySlug;

    let authorId = existing?.authorId;
    if (has(article, 'authorSlug')) {
      const authorSlug = nonEmptyString(article.authorSlug);
      if (!authorSlug) throw new Error('authorSlug ne peut pas être vide lorsqu’il est fourni');
      const found = await tx.author.findUnique({ where: { slug: authorSlug } });
      const author = found ?? await tx.author.create({ data: { slug: authorSlug, name: nonEmptyString(article.authorName) ?? authorSlug } });
      if (found && has(article, 'authorName') && nonEmptyString(article.authorName)) await tx.author.update({ where: { id: author.id }, data: { name: nonEmptyString(article.authorName)! } });
      rememberResource('authors', authorSlug, found ? 'reused' : 'created');
      authorId = author.id;
    }
    if (!authorId) throw new Error('authorSlug est obligatoire pour créer un article');

    let categoryId = existing?.categoryId;
    let categorySlug = existing?.categorySlug;
    if (has(article, 'categorySlug')) {
      const slug = nonEmptyString(article.categorySlug);
      if (!slug) {
        categoryId = null;
        categorySlug = null;
      } else {
        const found = await tx.category.findUnique({ where: { slug } });
        const category = found ?? await tx.category.create({ data: { slug, name: nonEmptyString(article.categoryName) ?? slug } });
        if (found && has(article, 'categoryName') && nonEmptyString(article.categoryName)) await tx.category.update({ where: { id: category.id }, data: { name: nonEmptyString(article.categoryName)! } });
        rememberResource('categories', slug, found ? 'reused' : 'created');
        categoryId = category.id;
        categorySlug = category.slug;
      }
    }

    let coverImageId = existing?.coverImageId;
    if (has(article, 'coverImageUrl')) {
      const url = nonEmptyString(article.coverImageUrl);
      if (!url) coverImageId = null;
      else {
        const found = await tx.media.findFirst({ where: { url } });
        const media = found
          ? await tx.media.update({ where: { id: found.id }, data: has(article, 'coverImageAlt') ? { altText: nullableString(article.coverImageAlt) } : {} })
          : await tx.media.create({ data: { url, altText: nullableString(article.coverImageAlt), source: 'external' } });
        rememberResource('media', url, found ? 'reused' : 'created');
        coverImageId = media.id;
      }
    }

    const data: Prisma.PostUncheckedCreateInput = {
      title: article.title,
      slug: article.slug,
      path: article.path,
      locale: article.locale,
      status: article.status,
      isActive: article.isActive,
      isIndexable: article.isIndexable,
      authorId,
      categoryId,
      categorySlug,
      coverImageId,
      contentMarkdown: typeof article.contentMarkdown === 'string' ? article.contentMarkdown : existing?.contentMarkdown ?? '',
      ...(has(article, 'h1') ? { h1: nullableString(article.h1) } : {}),
      ...(has(article, 'excerpt') ? { excerpt: nullableString(article.excerpt) } : {}),
      ...(has(article, 'chapoHtml') ? { chapoHtml: nullableString(article.chapoHtml) } : {}),
      ...(has(article, 'contentHtml') ? { contentHtml: typeof article.contentHtml === 'string' ? article.contentHtml : null } : {}),
      ...(has(article, 'contentJson') ? { contentJson: article.contentJson === null ? Prisma.JsonNull : article.contentJson as Prisma.InputJsonValue } : {}),
      ...(has(article, 'faqJson') ? { faqJson: article.faqJson === null ? Prisma.JsonNull : article.faqJson as Prisma.InputJsonValue } : {}),
      ...(has(article, 'metaTitle') ? { metaTitle: nullableString(article.metaTitle) } : {}),
      ...(has(article, 'metaDescription') ? { metaDescription: nullableString(article.metaDescription) } : {}),
      ...(has(article, 'canonicalUrl') ? { canonicalUrl: nullableString(article.canonicalUrl) } : {}),
      ...(has(article, 'robots') ? { robots: nonEmptyString(article.robots) ?? 'index,follow' } : existing ? {} : { robots: 'index,follow' }),
      ...(has(article, 'publishedAt') ? { publishedAt: article.publishedAt === null ? null : dateOrNull(article.publishedAt) } : {}),
      ...(has(article, 'updatedAt') ? { updatedAt: article.updatedAt === null ? new Date() : dateOrNull(article.updatedAt)! } : {}),
      ...(has(article, 'coverImageUrl') ? { heroImageUrl: nullableString(article.coverImageUrl) } : {}),
      ...(has(article, 'coverImageAlt') ? { heroImageAlt: nullableString(article.coverImageAlt) } : {})
    };

    const saved = existing
      ? await tx.post.update({ where: { id: existing.id }, data: data as Prisma.PostUncheckedUpdateInput })
      : await tx.post.create({ data });
    report.posts.push({ path: saved.path!, slug: saved.slug, action: existing ? 'updated' : 'created' });

    const seoData = {
      entityType: SeoEntityType.POST,
      title: has(article, 'metaTitle') ? nullableString(article.metaTitle) : saved.metaTitle,
      description: has(article, 'metaDescription') ? nullableString(article.metaDescription) : saved.metaDescription,
      canonicalUrl: has(article, 'canonicalUrl') ? nullableString(article.canonicalUrl) : saved.canonicalUrl,
      noIndex: !saved.isIndexable,
      openGraphImageId: saved.coverImageId
    };
    await tx.seoMetadata.upsert({ where: { postId: saved.id }, update: seoData, create: { ...seoData, postId: saved.id } });

    if (article.tags) {
      await tx.postTag.deleteMany({ where: { postId: saved.id } });
      for (const slug of article.tags) {
        const found = await tx.tag.findUnique({ where: { slug } });
        const tag = found ?? await tx.tag.create({ data: { slug, name: slug } });
        rememberResource('tags', slug, found ? 'reused' : 'created');
        await tx.postTag.create({ data: { postId: saved.id, tagId: tag.id } });
      }
    }
  });
}

function count(kind: ResourceKind, action: Action): number {
  return report.resources[kind].filter((item) => item.action === action).length;
}

function list(kind: ResourceKind): string {
  const items = report.resources[kind];
  return items.length ? items.map((item) => `- ${item.action === 'created' ? 'création' : 'réutilisation'} : ${item.value}`).join('\n') : '- aucune';
}

function reportMarkdown(): string {
  const errors = report.errors.length ? report.errors.map((value) => `- ${value}`).join('\n') : '- aucune';
  const warnings = report.warnings.length ? report.warnings.map((value) => `- ${value}`).join('\n') : '- aucun';
  const paths = report.posts.length ? report.posts.map((post) => `- ${post.action === 'created' ? 'création' : 'mise à jour'} : ${post.path}`).join('\n') : '- aucun';
  return `# Rapport d’import JSON des articles\n\n- Mode : ${dryRun ? 'dry-run' : 'import réel'}\n- Fichier importé : \`${report.source}\`\n- Articles lus : ${report.read}\n- Articles valides : ${report.valid}\n- Articles créés : ${report.posts.filter((post) => post.action === 'created').length}\n- Articles mis à jour : ${report.posts.filter((post) => post.action === 'updated').length}\n- Catégories créées / réutilisées : ${count('categories', 'created')} / ${count('categories', 'reused')}\n- Auteurs créés / réutilisés : ${count('authors', 'created')} / ${count('authors', 'reused')}\n- Médias créés / réutilisés : ${count('media', 'created')} / ${count('media', 'reused')}\n- Tags créés / réutilisés : ${count('tags', 'created')} / ${count('tags', 'reused')}\n\n## Catégories\n\n${list('categories')}\n\n## Auteurs\n\n${list('authors')}\n\n## Médias\n\n${list('media')}\n\n## Tags\n\n${list('tags')}\n\n## Erreurs bloquantes\n\n${errors}\n\n## Warnings non bloquants\n\n${warnings}\n\n## Paths importés\n\n${paths}\n`;
}

async function writeReport(): Promise<void> {
  await fs.mkdir(path.dirname(REPORT_FILE), { recursive: true });
  await fs.writeFile(REPORT_FILE, reportMarkdown(), 'utf8');
  console.log(`Rapport: ${path.relative(process.cwd(), REPORT_FILE)}`);
}

async function main(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  } catch (error) {
    report.errors.push(`Lecture impossible: ${error instanceof Error ? error.message : String(error)}`);
    await writeReport();
    throw new Error('Impossible de lire le fichier d’import.');
  }

  const articles = validate(input);
  if (report.errors.length) {
    await writeReport();
    throw new Error(`Import annulé: ${report.errors.length} erreur(s) bloquante(s).`);
  }

  const canInspect = Boolean(process.env.DATABASE_URL);
  if (dryRun && !canInspect) {
    report.warnings.push('DATABASE_URL absente : la base n’a pas été interrogée ; les créations/mises à jour et réutilisations ne peuvent pas être déterminées.');
    report.posts.push(...articles.map((article) => ({ path: article.path, slug: article.slug, action: 'created' as const })));
    for (const article of articles) {
      const author = nonEmptyString(article.authorSlug);
      const category = nonEmptyString(article.categorySlug);
      const media = nonEmptyString(article.coverImageUrl);
      if (author) rememberResource('authors', author, 'created');
      if (category) rememberResource('categories', category, 'created');
      if (media) rememberResource('media', media, 'created');
      article.tags?.forEach((tag) => rememberResource('tags', tag, 'created'));
    }
  } else {
    for (const article of articles) {
      try {
        if (dryRun) await inspect(article);
        else await save(article);
      } catch (error) {
        report.errors.push(`${article.locale}:${article.path}: ${error instanceof Error ? error.message : String(error)}`);
        if (!dryRun) break;
      }
    }
  }

  await writeReport();
  console.log(`${dryRun ? 'Dry-run' : 'Import'} terminé : ${report.valid} article(s) valide(s).`);
  report.posts.forEach((post) => console.log(`${post.action.toUpperCase()} ${post.path}`));
  if (report.errors.length) throw new Error(`Opération terminée avec ${report.errors.length} erreur(s).`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
