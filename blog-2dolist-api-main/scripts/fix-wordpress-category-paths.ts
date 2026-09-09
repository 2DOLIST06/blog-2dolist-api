import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

const wordpressCategories = [
  { name: 'Avion', slug: 'avion', path: '/category/aerien/avion/' },
  { name: 'Hélicoptère', slug: 'helicoptere', path: '/category/aerien/helicoptere/' },
  { name: 'Montgolfière', slug: 'montgolfiere', path: '/category/aerien/montgolfiere/' },
  { name: 'Parachutisme', slug: 'parachutisme', path: '/category/aerien/parachutisme/' },
  { name: 'Planeur', slug: 'planeur', path: '/category/aerien/planeur/' },
  { name: 'ULM', slug: 'ulm', path: '/category/aerien/ulm/' },
  { name: 'Parapente', slug: 'parapente', path: '/category/aerien/parapente/' }
] as const;

async function main() {
  const aliases = wordpressCategories.flatMap(({ slug }) => [slug, `aerien-${slug}`]);
  const categories = await prisma.category.findMany({
    where: { slug: { in: aliases } },
    include: { _count: { select: { posts: true } } },
    orderBy: { slug: 'asc' }
  });

  console.log(`Mode: ${dryRun ? 'dry-run (aucune écriture)' : 'correction réelle'}`);
  for (const target of wordpressCategories) {
    const matches = categories.filter(({ slug }) => slug === target.slug || slug === `aerien-${target.slug}`);
    if (!matches.length) {
      console.log(`- ${target.name}: absente | slug actuel=(aucun) | path actuel=(aucun) | path WordPress proposé=${target.path} | articles=0 | changements=aucun`);
      continue;
    }
    if (matches.length > 1) throw new Error(`Plusieurs catégories correspondent à ${target.name}; résolution manuelle requise.`);
    const category = matches[0];
    const changes = [category.slug !== target.slug ? `slug -> ${target.slug}` : null, category.path !== target.path ? `path -> ${target.path}` : null].filter(Boolean);
    console.log(`- ${target.name}: id=${category.id} | slug actuel=${category.slug} | path actuel=${category.path ?? '(aucun)'} | path WordPress proposé=${target.path} | articles=${category._count.posts} | changements=${changes.join(', ') || 'aucun'}`);
  }

  if (dryRun) return;

  await prisma.$transaction(async (tx) => {
    for (const target of wordpressCategories) {
      const category = categories.find(({ slug }) => slug === target.slug || slug === `aerien-${target.slug}`);
      if (!category) continue;
      await tx.category.update({ where: { id: category.id }, data: { slug: target.slug, path: target.path } });
    }
  });
  console.log('Correction terminée. Aucun article, Post.path, catégorie ou redirection n’a été modifié/supprimé.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
