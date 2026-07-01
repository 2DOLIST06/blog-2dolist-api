import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SOURCE_FILE = path.resolve('data/import/wordpress-posts-import.json');
const AERIAL_CATEGORY_SLUGS = new Set(['avion', 'helicoptere', 'montgolfiere', 'parachutisme', 'planeur', 'ulm', 'parapente']);

const dryRun = process.argv.includes('--dry-run') || (!process.argv.includes('--disable') && !process.argv.includes('--delete'));
const shouldDisable = process.argv.includes('--disable');
const shouldDelete = process.argv.includes('--delete');

type ImportRow = { slug?: unknown; path?: unknown };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function main() {
  if (shouldDisable && shouldDelete) throw new Error('Utilise soit --disable, soit --delete, pas les deux.');

  const rows = JSON.parse(await fs.readFile(SOURCE_FILE, 'utf8')) as ImportRow[];
  const slugs = rows.map((row) => asString(row.slug)).filter((slug): slug is string => Boolean(slug));
  const paths = rows.map((row) => asString(row.path)).filter((postPath): postPath is string => Boolean(postPath));

  const posts = await prisma.post.findMany({
    where: {
      locale: 'fr',
      OR: [{ slug: { in: slugs } }, { path: { in: paths } }]
    },
    include: { category: true },
    orderBy: [{ categorySlug: 'asc' }, { slug: 'asc' }]
  });

  const nonAerialPosts = posts.filter((post) => !AERIAL_CATEGORY_SLUGS.has(post.categorySlug ?? post.category?.slug ?? ''));

  console.log(`Posts WordPress trouvés: ${posts.length}`);
  console.log(`Posts hors aérien ciblés: ${nonAerialPosts.length}`);
  for (const post of nonAerialPosts) {
    console.log(`- ${post.slug} — ${post.path ?? '(sans path)'} — catégorie: ${post.categorySlug ?? post.category?.slug ?? '(sans catégorie)'}`);
  }

  if (dryRun) {
    console.log('Mode dry-run: aucune écriture en base. Ajoute --disable pour désactiver ou --delete pour supprimer définitivement.');
    return;
  }

  if (shouldDelete) {
    const ids = nonAerialPosts.map((post) => post.id);
    await prisma.$transaction([
      prisma.postTag.deleteMany({ where: { postId: { in: ids } } }),
      prisma.seoMetadata.deleteMany({ where: { postId: { in: ids } } }),
      prisma.postRelation.deleteMany({ where: { OR: [{ sourcePostId: { in: ids } }, { targetPostId: { in: ids } }] } }),
      prisma.post.deleteMany({ where: { id: { in: ids } } })
    ]);
    console.log(`Suppression définitive effectuée: ${ids.length} post(s).`);
    return;
  }

  if (shouldDisable) {
    const result = await prisma.post.updateMany({
      where: { id: { in: nonAerialPosts.map((post) => post.id) } },
      data: { isActive: false, isIndexable: false }
    });
    console.log(`Désactivation effectuée: ${result.count} post(s).`);
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
