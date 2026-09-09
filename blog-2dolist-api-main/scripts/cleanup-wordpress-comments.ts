import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  removeWordpressCommentsBlocks,
  removeWordpressCommentsFromContentJson,
} from '../src/lib/wordpress-comments-cleaner.js';

const reportPath = 'data/import/wordpress-comments-cleanup-report.md';
const dryRun = process.argv.includes('--dry-run');
const write = process.argv.includes('--write');
const prisma = new PrismaClient();

if (dryRun === write) {
  throw new Error('Choisissez exactement un mode: --dry-run ou --write.');
}

function plainExcerpt(value: string, offset = 0): string {
  const start = Math.max(0, offset - 100);
  return value
    .slice(start, Math.min(value.length, offset + 300))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400) || '(vide)';
}

function markdown(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\|/g, '\\|');
}

function saveReport(report: string): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);
}

if (!process.env.DATABASE_URL) {
  const report = `# Rapport de nettoyage des blocs WordPress comments\n\nMode: ${dryRun ? 'dry-run' : 'écriture'} non exécuté. \`DATABASE_URL\` est absent. Aucune écriture n’a été effectuée.\n`;
  saveReport(report);
  console.warn(report);
  await prisma.$disconnect();
  process.exit(0);
}

const posts = await prisma.post.findMany({
  select: { id: true, title: true, slug: true, path: true, contentHtml: true, contentJson: true },
  orderBy: { updatedAt: 'desc' },
});

const affected: string[] = [];
let totalBlocks = 0;
let totalCharacters = 0;

for (const post of posts) {
  const html = removeWordpressCommentsBlocks(post.contentHtml ?? '');
  const json = removeWordpressCommentsFromContentJson(post.contentJson);
  const blocksRemoved = html.blocksRemoved + json.blocksRemoved;
  const charactersRemoved = html.charactersRemoved + json.charactersRemoved;
  if (blocksRemoved === 0) continue;

  totalBlocks += blocksRemoved;
  totalCharacters += charactersRemoved;
  const locations: string[] = [];
  if (html.blocksRemoved > 0) {
    locations.push(
      `  - \`contentHtml\`: ${html.blocksRemoved} bloc(s)`,
      `    - Avant: \`${markdown(plainExcerpt(post.contentHtml ?? '', html.firstRemovalOffset))}\``,
      `    - Après: \`${markdown(plainExcerpt(html.value, html.firstRemovalOffset))}\``,
    );
  }
  for (const preview of json.previews) {
    locations.push(
      `  - \`contentJson.blocks[${preview.blockIndex}].${preview.field}\``,
      `    - Avant: \`${markdown(plainExcerpt(preview.before, preview.before.search(/<!--\s+wp:comments/i)))}\``,
      `    - Après: \`${markdown(plainExcerpt(preview.after, preview.before.search(/<!--\s+wp:comments/i)))}\``,
    );
  }
  affected.push([
    `- **${markdown(post.title)}** (\`${markdown(post.slug)}\`) — \`${markdown(post.path ?? '')}\``,
    `  - Blocs comments détectés: ${blocksRemoved}`,
    `  - Caractères supprimés: ${charactersRemoved}`,
    ...locations,
  ].join('\n'));

  if (write) {
    const data: Prisma.PostUpdateInput = {};
    if (html.blocksRemoved > 0) data.contentHtml = html.value;
    if (json.blocksRemoved > 0) data.contentJson = json.value as Prisma.InputJsonValue;
    await prisma.post.update({ where: { id: post.id }, data });
  }
}

const report = `# Rapport de nettoyage des blocs WordPress comments\n\nMode: ${dryRun ? 'dry-run (aucune écriture)' : 'écriture'}\n\n## Résumé\n\n- Articles analysés: ${posts.length}\n- Articles concernés: ${affected.length}\n- Blocs comments détectés: ${totalBlocks}\n- Caractères supprimés: ${totalCharacters}\n\n## Articles concernés\n\n${affected.length ? affected.join('\n\n') : '- Aucun'}\n\n## Garanties\n\n- Seuls les blocs complets \`<!-- wp:comments --> … <!-- /wp:comments -->\` sont retirés.\n- Seuls \`contentHtml\` et les champs HTML des éléments \`contentJson.blocks\` de type \`html\` ou \`contentHtml\` peuvent être mis à jour.\n- Les autres contenus et champs de l’article, notamment les widgets GetYourGuide, FAQ, images, titre, slug, path, URL canonique, SEO et catégories, restent inchangés.\n`;
saveReport(report);
console.log(report);
await prisma.$disconnect();
