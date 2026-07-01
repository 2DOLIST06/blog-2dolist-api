import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const AERIAL_CATEGORY_SLUGS = new Set(['avion', 'helicoptere', 'montgolfiere', 'parachutisme', 'planeur', 'ulm', 'parapente']);

const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--disable');
const shouldDisable = process.argv.includes('--disable');

async function main() {
  const nonAerialPosts = await prisma.post.findMany({
    where: {
      OR: [
        { locale: { not: 'fr' } },
        { NOT: { categorySlug: { in: [...AERIAL_CATEGORY_SLUGS] } } }
      ],
      isActive: true
    },
    include: { category: true },
    orderBy: [{ locale: 'asc' }, { categorySlug: 'asc' }, { slug: 'asc' }]
  });

  const inactiveCategories = await prisma.category.findMany({
    where: { slug: { notIn: [...AERIAL_CATEGORY_SLUGS] } },
    include: { _count: { select: { posts: true } } },
    orderBy: { slug: 'asc' }
  });

  console.log(`Posts actifs à désactiver (locale != fr ou hors aérien): ${nonAerialPosts.length}`);
  for (const post of nonAerialPosts) {
    console.log(`- locale=${post.locale} slug=${post.slug} path=${post.path ?? ''} catégorie=${post.categorySlug ?? post.category?.slug ?? '(sans catégorie)'}`);
  }

  console.log(`\nCatégories hors aérien à ignorer côté front/import: ${inactiveCategories.length}`);
  for (const category of inactiveCategories) console.log(`- ${category.slug} (${category._count.posts} post(s))`);

  if (dryRun) {
    console.log('\nMode dry-run: aucune écriture en base. Ajoute --disable pour désactiver les posts ciblés.');
    return;
  }

  if (shouldDisable) {
    const result = await prisma.post.updateMany({
      where: { id: { in: nonAerialPosts.map((post) => post.id) } },
      data: { isActive: false, isIndexable: false }
    });
    console.log(`\nDésactivation effectuée: ${result.count} post(s). Aucune suppression définitive.`);
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
