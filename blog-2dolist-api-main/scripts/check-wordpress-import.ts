import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildSitemapXml, buildRobotsTxt } from '../src/lib/seo/sitemap.js';

const prisma = new PrismaClient();
const AERIAL_CATEGORY_SLUGS = ['avion', 'helicoptere', 'montgolfiere', 'parachutisme', 'planeur', 'ulm', 'parapente'];

async function main() {
  const [frPosts, enPosts, pathsWithFr, withoutImages, categories] = await Promise.all([
    prisma.post.count({ where: { locale: 'fr' } }),
    prisma.post.count({ where: { locale: 'en' } }),
    prisma.post.count({ where: { path: { startsWith: '/fr' } } }),
    prisma.post.count({ where: { locale: 'fr', isActive: true, OR: [{ coverImageId: null }, { heroImageUrl: null }] } }),
    prisma.category.findMany({ include: { _count: { select: { posts: true } } }, orderBy: { slug: 'asc' } })
  ]);

  const sitemap = await buildSitemapXml(prisma, 'fr');
  const robots = buildRobotsTxt();

  console.log(`Posts locale fr: ${frPosts}`);
  console.log(`Posts locale en: ${enPosts}`);
  console.log(`Posts avec path commençant par /fr: ${pathsWithFr}`);
  console.log(`Posts FR actifs sans coverImageId ou heroImageUrl: ${withoutImages}`);
  console.log(`Sitemap contient /fr/: ${sitemap.includes('/fr/') ? 'OUI' : 'NON'}`);
  console.log(`Sitemap contient /articles/ (fallback slug): ${sitemap.includes('/articles/') ? 'OUI' : 'NON'}`);
  console.log(`Robots déclare /fr/sitemap.xml: ${robots.includes('/fr/sitemap.xml') ? 'OUI' : 'NON'}`);
  console.log('\nCatégories finales:');
  for (const category of categories) {
    const status = AERIAL_CATEGORY_SLUGS.includes(category.slug) ? 'aérien' : 'hors aérien';
    console.log(`- ${category.name} (${category.slug}): ${category._count.posts} post(s), ${status}`);
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
