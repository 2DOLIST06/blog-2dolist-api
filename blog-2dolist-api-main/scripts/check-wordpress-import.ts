import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SOURCE_FILE = path.resolve('data/import/wordpress-posts-import.json');
const AERIAL_CATEGORY_SLUGS = ['avion', 'helicoptere', 'montgolfiere', 'parachutisme', 'planeur', 'ulm', 'parapente'];

type ImportRow = { slug?: unknown; path?: unknown };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function main() {
  const rows = JSON.parse(await fs.readFile(SOURCE_FILE, 'utf8')) as ImportRow[];
  const slugs = rows.map((row) => asString(row.slug)).filter((slug): slug is string => Boolean(slug));
  const paths = rows.map((row) => asString(row.path)).filter((postPath): postPath is string => Boolean(postPath));
  const wordpressWhere = { locale: 'fr', OR: [{ slug: { in: slugs } }, { path: { in: paths } }] };

  const [total, aerialActiveIndexable, nonAerialActiveIndexable, withoutCoverImageId, withoutHeroImageUrl, categories, examples] = await Promise.all([
    prisma.post.count({ where: wordpressWhere }),
    prisma.post.count({ where: { ...wordpressWhere, isActive: true, isIndexable: true, categorySlug: { in: AERIAL_CATEGORY_SLUGS } } }),
    prisma.post.count({ where: { ...wordpressWhere, isActive: true, isIndexable: true, NOT: { categorySlug: { in: AERIAL_CATEGORY_SLUGS } } } }),
    prisma.post.count({ where: { ...wordpressWhere, coverImageId: null } }),
    prisma.post.count({ where: { ...wordpressWhere, heroImageUrl: null } }),
    prisma.category.findMany({ where: { posts: { some: wordpressWhere } }, include: { _count: { select: { posts: true } } }, orderBy: { slug: 'asc' } }),
    prisma.post.findMany({ where: wordpressWhere, include: { category: true, coverImage: true }, orderBy: { publishedAt: 'desc' }, take: 5 })
  ]);

  console.log(`Total posts WordPress importés: ${total}`);
  console.log(`Posts aériens actifs/indexables: ${aerialActiveIndexable}`);
  console.log(`Posts hors aérien actifs/indexables: ${nonAerialActiveIndexable}`);
  console.log(`Posts sans coverImageId: ${withoutCoverImageId}`);
  console.log(`Posts sans heroImageUrl: ${withoutHeroImageUrl}`);
  console.log('\nCatégories finales:');
  for (const category of categories) console.log(`- ${category.name} (${category.slug}): ${category._count.posts}`);
  console.log('\nExemples:');
  for (const post of examples) {
    console.log(`- slug=${post.slug} path=${post.path ?? ''} categorySlug=${post.categorySlug ?? post.category?.slug ?? ''} coverImage.url=${post.coverImage?.url ?? ''} heroImageUrl=${post.heroImageUrl ?? ''}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
