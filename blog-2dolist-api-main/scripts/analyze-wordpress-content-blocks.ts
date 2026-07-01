import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hasFaqTrace, hasGetYourGuideTrace, normalizeWordpressContent } from '../src/lib/wordpress-content-normalizer.js';
const prisma = new PrismaClient();
const reportPath = 'data/import/wordpress-content-blocks-report.md';
if (!process.env.DATABASE_URL) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const md = '# Rapport diagnostic blocs WordPress\n\nAnalyse non exécutée: DATABASE_URL est absent dans l’environnement local. Lancez cette commande sur Render ou avec DATABASE_URL configuré.\n';
  writeFileSync(reportPath, md);
  console.warn(md);
  process.exit(0);
}
const rows = await prisma.post.findMany({ select: { id: true, title: true, slug: true, path: true, contentHtml: true, contentJson: true, faqJson: true }, orderBy: { updatedAt: 'desc' } });
const gyg = [], faq = [], faqFilled = [], faqInHtml = [], needs = [], ambiguous = [];
for (const post of rows) {
  const html = post.contentHtml ?? '';
  const normalized = normalizeWordpressContent({ contentHtml: html, contentJson: post.contentJson, faqJson: post.faqJson });
  const label = `- ${post.title} (${post.slug}) — ${post.path ?? ''}`;
  if (hasGetYourGuideTrace(html)) gyg.push(`${label}: ${normalized.getYourGuideBlocks.length} bloc(s)`);
  if (hasFaqTrace(html)) faq.push(`${label}: ${normalized.faqJson.length} FAQ extraite(s)`);
  if (Array.isArray(post.faqJson) && post.faqJson.length) faqFilled.push(`${label}: ${post.faqJson.length} entrée(s)`);
  if (hasFaqTrace(html)) faqInHtml.push(label);
  if (normalized.changed || (!post.contentJson && (hasGetYourGuideTrace(html) || hasFaqTrace(html)))) needs.push(label);
  if (normalized.ambiguousFaqSections.length) ambiguous.push(`${label}: ${normalized.ambiguousFaqSections.join('; ')}`);
}
const section = (title: string, items: string[]) => `## ${title}\n\n${items.length ? items.join('\n') : '- Aucun'}\n`;
const md = `# Rapport diagnostic blocs WordPress\n\nArticles analysés: ${rows.length}\n\n${section('Widgets GetYourGuide détectés', gyg)}\n${section('FAQ détectées', faq)}\n${section('FAQ déjà dans faqJson', faqFilled)}\n${section('FAQ encore dans contentHtml', faqInHtml)}\n${section('Articles nécessitant conversion', needs)}\n${section('Limites ou cas ambigus', ambiguous)}\n`;
mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, md); console.log(md); await prisma.$disconnect();
