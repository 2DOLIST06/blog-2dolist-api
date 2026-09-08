import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hasFaqTrace, hasGetYourGuideTrace } from '../src/lib/wordpress-content-normalizer.js';

type FaqItem = { question: string; answer: string };
type Candidate = { start: number; end: number; label: string; html: string; items: FaqItem[] };

const reportPath = 'data/import/faq-duplicates-cleanup-report.md';
const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function comparable(value: unknown): string {
  return decodeEntities(String(value ?? ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .normalize('NFC').replace(/\s+/g, ' ').trim();
}

function readFaq(value: unknown): FaqItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const question = (item as Record<string, unknown>).question;
    const answer = (item as Record<string, unknown>).answer;
    return comparable(question) && comparable(answer) ? [{ question: String(question), answer: String(answer) }] : [];
  });
}

function extractCandidates(html: string): { candidates: Candidate[]; malformed: string[] } {
  const candidates: Candidate[] = [];
  const malformed: string[] = [];
  const pattern = /<!-- wp:yoast\/faq-block\s+([\s\S]*?)-->([\s\S]*?)<!-- \/wp:yoast\/faq-block -->/gi;
  for (const match of html.matchAll(pattern)) {
    const blockStart = match.index ?? 0;
    const blockEnd = blockStart + match[0].length;
    try {
      const parsed = JSON.parse(match[1].trim()) as { questions?: unknown[] };
      if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) throw new Error('liste de questions absente');
      const items = parsed.questions.map((entry) => {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        const question = String(record.jsonQuestion ?? '');
        const answer = String(record.jsonAnswer ?? '');
        if (!comparable(question) || !comparable(answer)) throw new Error('question ou réponse vide');
        return { question, answer };
      });
      candidates.push({ start: blockStart, end: blockEnd, label: `bloc Yoast (${items.length} question(s))`, html: match[0], items });
    } catch (error) {
      malformed.push(`bloc Yoast non interprétable: ${error instanceof Error ? error.message : 'format inconnu'}`);
    }
  }
  return { candidates, malformed };
}

function sameItem(left: FaqItem, right: FaqItem): boolean {
  return comparable(left.question) === comparable(right.question) && comparable(left.answer) === comparable(right.answer);
}

function uniqueContiguousMatch(items: FaqItem[], faq: FaqItem[]): boolean {
  let matches = 0;
  for (let offset = 0; offset <= faq.length - items.length; offset += 1) {
    if (items.every((item, index) => sameItem(item, faq[offset + index]))) matches += 1;
  }
  return matches === 1;
}

function precedingFaqHeading(html: string, start: number): { start: number; html: string } | undefined {
  const prefix = html.slice(0, start);
  const pattern = /(?:<!-- wp:heading[^>]*-->\s*)?<h([2-4])[^>]*>[\s\S]*?<\/h\1>\s*(?:<!-- \/wp:heading -->\s*)?$/i;
  const match = prefix.match(pattern);
  if (!match || !/^(?:FAQ\b|FAQ\s*[-–—:]|Questions fréquentes\b|Foire aux questions\b)/i.test(comparable(match[0]))) return undefined;
  return { start: start - match[0].length, html: match[0] };
}

function preview(html: string, position: number): string {
  return comparable(html.slice(Math.max(0, position - 100), Math.min(html.length, position + 180))).slice(0, 280) || '(vide)';
}

function markdown(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

if (!process.env.DATABASE_URL) {
  const md = '# Rapport de nettoyage des FAQ dupliquées\n\nMode: dry-run non exécuté. `DATABASE_URL` est absent. Aucune écriture n’a été effectuée.\n';
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, md);
  console.warn(md);
  await prisma.$disconnect();
  process.exit(0);
}

const posts = await prisma.post.findMany({
  select: { id: true, title: true, slug: true, path: true, contentHtml: true, faqJson: true },
  orderBy: { updatedAt: 'desc' },
});

const filled: string[] = [];
const detected: string[] = [];
const removals: string[] = [];
const ambiguous: string[] = [];

for (const post of posts) {
  const faq = readFaq(post.faqJson);
  if (faq.length === 0) continue;
  const label = `${post.title} (${post.slug}) — ${post.path ?? ''}`;
  filled.push(`- ${label}: ${faq.length} entrée(s)`);
  const original = post.contentHtml ?? '';
  if (!hasFaqTrace(original)) continue;
  detected.push(`- ${label}`);
  const { candidates, malformed } = extractCandidates(original);
  const safe = candidates.filter((candidate) => uniqueContiguousMatch(candidate.items, faq) && !hasGetYourGuideTrace(candidate.html));
  const uncertain = candidates.filter((candidate) => !safe.includes(candidate));
  if (malformed.length || uncertain.length || candidates.length === 0) {
    const reasons = [...malformed, ...uncertain.map((candidate) => `${candidate.label}: correspondance non unique ou contenu GetYourGuide détecté`), ...(candidates.length === 0 ? ['trace FAQ sans bloc Yoast complet et vérifiable'] : [])];
    ambiguous.push(`- ${label}: ${reasons.join('; ')}`);
  }
  if (safe.length === 0) continue;

  let next = original;
  const ranges = safe.map((candidate) => {
    const heading = precedingFaqHeading(original, candidate.start);
    return { start: heading?.start ?? candidate.start, end: candidate.end, candidate, heading: Boolean(heading) };
  }).sort((a, b) => b.start - a.start);
  for (const range of ranges) next = next.slice(0, range.start) + next.slice(range.end);
  const removedCharacters = original.length - next.length;
  removals.push(`- **${label}**\n  - Sections: ${ranges.map((range) => `${range.candidate.label}${range.heading ? ' + titre FAQ adjacent' : ''}`).join(', ')}\n  - Caractères supprimés: ${removedCharacters}\n  - Avant: \`${markdown(preview(original, ranges[ranges.length - 1].start))}\`\n  - Après: \`${markdown(preview(next, ranges[ranges.length - 1].start))}\``);
  if (!dryRun) await prisma.post.update({ where: { id: post.id }, data: { contentHtml: next } });
}

const section = (title: string, entries: string[]) => `## ${title}\n\n${entries.length ? entries.join('\n') : '- Aucun'}\n`;
const report = `# Rapport de nettoyage des FAQ dupliquées\n\nMode: ${dryRun ? 'dry-run (aucune écriture)' : 'écriture de contentHtml'}\n\n${section('Articles avec faqJson rempli', filled)}\n${section('Articles avec FAQ encore détectée dans contentHtml', detected)}\n${section(`Sections FAQ ${dryRun ? 'qui seraient retirées' : 'retirées'}`, removals)}\n${section('Cas ambigus laissés inchangés', ambiguous)}\n## Garanties\n\n- Seul \`contentHtml\` est mis à jour; \`contentJson.blocks\` et tous les autres champs restent inchangés.\n- Un bloc n’est retiré que si toutes ses questions/réponses correspondent exactement, après normalisation typographique, à une séquence unique de \`faqJson\`.\n- Tout bloc contenant une trace GetYourGuide est refusé.\n`;
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, report);
console.log(report);
await prisma.$disconnect();
