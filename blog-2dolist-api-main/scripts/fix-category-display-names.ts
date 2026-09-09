import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const reportFile = path.resolve('data/import/category-display-names-cleanup-report.md');

const displayNameMapping = new Map<string, string>([
  ['Aérien>Avion', 'Avion'],
  ['Aérien>Hélicoptére', 'Hélicoptère'],
  ['Aérien>Hélicoptère', 'Hélicoptère'],
  ['Aérien>Montgolfière', 'Montgolfière'],
  ['Aérien>Parachutisme', 'Parachutisme'],
  ['Aérien>Planeur', 'Planeur'],
  ['Aérien>ULM', 'ULM'],
  ['Aérien>parapente', 'Parapente'],
  ['Aérien>Parapente', 'Parapente']
]);

function markdown(value: string | null): string {
  return (value ?? '(aucun)').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function main(): Promise<void> {
  const categories = await prisma.category.findMany({
    where: { name: { in: [...displayNameMapping.keys()] } },
    select: { id: true, name: true, slug: true, path: true, _count: { select: { posts: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }]
  });

  const rows = categories.map((category) => {
    const proposedName = displayNameMapping.get(category.name);
    if (!proposedName) throw new Error(`Aucun mapping défini pour la catégorie ${category.id}.`);
    return {
      ...category,
      proposedName,
      change: category.name === proposedName ? 'aucun' : `name: « ${category.name} » → « ${proposedName} »`
    };
  });

  console.log(`Mode: ${dryRun ? 'dry-run (aucune écriture)' : 'correction réelle'}`);
  if (!rows.length) console.log('Aucune catégorie correspondant au mapping.');
  for (const row of rows) {
    console.log(
      `- id=${row.id} | name actuel=${row.name} | slug actuel=${row.slug} | path actuel=${row.path ?? '(aucun)'} | ` +
      `name proposé=${row.proposedName} | articles liés=${row._count.posts} | changement prévu=${row.change}`
    );
  }

  if (!dryRun) {
    const updates = rows
      .filter((row) => row.name !== row.proposedName)
      .map((row) => prisma.category.update({ where: { id: row.id }, data: { name: row.proposedName } }));
    if (updates.length) await prisma.$transaction(updates);
  }

  const report = [
    '# Rapport de nettoyage des noms visibles des catégories',
    '',
    `Généré le ${new Date().toISOString()}.`,
    '',
    `Mode : ${dryRun ? 'dry-run (aucune écriture)' : 'correction réelle'}.`,
    '',
    '| ID catégorie | Name actuel | Slug actuel | Path actuel | Name proposé | Articles liés | Changement prévu |',
    '| --- | --- | --- | --- | --- | ---: | --- |',
    ...rows.map((row) =>
      `| ${markdown(row.id)} | ${markdown(row.name)} | ${markdown(row.slug)} | ${markdown(row.path)} | ${markdown(row.proposedName)} | ${row._count.posts} | ${markdown(row.change)} |`
    ),
    ...(rows.length ? [] : ['| — | — | — | — | — | 0 | Aucune catégorie correspondante |']),
    '',
    `Résultat : ${dryRun ? 'aucune écriture effectuée' : `${rows.filter((row) => row.name !== row.proposedName).length} nom(s) mis à jour`}.`,
    '',
    'Seul le champ `Category.name` est ciblé. Les slugs, chemins de catégories, articles, URLs et redirections ne sont pas modifiés.',
    ''
  ].join('\n');

  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, report, 'utf8');
  console.log(`\nRapport écrit dans ${path.relative(process.cwd(), reportFile)}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
