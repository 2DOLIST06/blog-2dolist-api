import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeWordpressContent } from '../src/lib/wordpress-content-normalizer.js';
const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient();
const reportPath = 'data/import/wordpress-content-normalization-result.md';
if (!process.env.DATABASE_URL) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const md = '# Résultat normalisation WordPress\n\nMode: dry-run local non exécuté. DATABASE_URL est absent dans l’environnement local. Aucune écriture n’a été effectuée.\n';
  writeFileSync(reportPath, md);
  console.warn(md);
  process.exit(0);
}
const posts = await prisma.post.findMany({ select: { id: true, title: true, slug: true, path: true, contentHtml: true, contentJson: true, faqJson: true }, orderBy: { updatedAt: 'desc' } });
const changed: string[] = [], skipped: string[] = [], ambiguous: string[] = [];
for (const post of posts) {
  const result = normalizeWordpressContent({ contentHtml: post.contentHtml ?? '', contentJson: post.contentJson, faqJson: post.faqJson });
  const label = `${post.title} (${post.slug}) — ${post.path ?? ''}`;
  if (result.ambiguousFaqSections.length) ambiguous.push(`- ${label}: ${result.ambiguousFaqSections.join('; ')}`);
  if (!result.changed) { skipped.push(`- ${label}`); continue; }
  changed.push(`- ${label}: ${result.getYourGuideBlocks.length} bloc(s) HTML, ${result.faqJson.length} FAQ`);
  if (!dryRun) {
    await prisma.post.update({ where: { id: post.id }, data: { contentHtml: result.contentHtml, contentMarkdown: result.contentHtml, contentJson: result.contentJson as Prisma.InputJsonValue, faqJson: result.faqJson as Prisma.InputJsonValue } });
  }
}
const md = `# Résultat normalisation WordPress\n\nMode: ${dryRun ? 'dry-run (aucune écriture)' : 'écriture base'}\n\n## Articles modifiés${dryRun ? ' (simulation)' : ''}\n\n${changed.length ? changed.join('\n') : '- Aucun'}\n\n## Articles ignorés\n\n${skipped.length ? skipped.join('\n') : '- Aucun'}\n\n## Cas ambigus laissés inchangés\n\n${ambiguous.length ? ambiguous.join('\n') : '- Aucun'}\n`;
mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, md); console.log(md); await prisma.$disconnect();
