export type EditableContentBlock =
  | { id: string; type: 'html'; html: string; label?: string }
  | { id: string; type: 'contentHtml'; html: string; label?: string };

export type FaqItem = { question: string; answer: string };

export type NormalizeResult = {
  contentHtml: string;
  contentJson: { version: 1; source: 'wordpress-normalizer'; blocks: EditableContentBlock[] };
  faqJson: FaqItem[];
  getYourGuideBlocks: EditableContentBlock[];
  ambiguousFaqSections: string[];
  changed: boolean;
};

const gygPattern = /(getyourguide|widget\.getyourguide\.com|data-gyg|\bgyg\b)/i;
const faqHeadingPattern = /<h([2-4])[^>]*>\s*(?:<[^>]+>\s*)*(FAQ|Questions fréquentes|Foire aux questions)\b[\s\S]*?<\/h\1>/i;

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").trim();
}

function sanitizeEditableHtml(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, '').trim();
}

function idFrom(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

export function hasGetYourGuideTrace(html: string): boolean {
  return gygPattern.test(html);
}

export function hasFaqTrace(html: string): boolean {
  return faqHeadingPattern.test(html) || /schema-faq|yoast\/faq-block|FAQPage/i.test(html);
}

function extractYoastFaq(html: string): { html: string; items: FaqItem[]; removed: string[] } {
  const items: FaqItem[] = [];
  const removed: string[] = [];
  const next = html.replace(/<!-- wp:yoast\/faq-block ([\s\S]*?)-->([\s\S]*?)<!-- \/wp:yoast\/faq-block -->/gi, (match, rawJson) => {
    const jsonText = rawJson.trim();
    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed.questions)) {
        for (const q of parsed.questions) {
          const question = decodeEntities(String(q.jsonQuestion ?? stripTags(String(q.question ?? ''))));
          const answer = String(q.jsonAnswer ?? '').trim();
          if (question && answer) items.push({ question, answer });
        }
      }
    } catch {
      // keep ambiguous content in place
      return match;
    }
    removed.push(match);
    return '';
  });
  return { html: next, items, removed };
}

function extractSchemaFaq(html: string): { html: string; items: FaqItem[]; removed: string[] } {
  const items: FaqItem[] = [];
  const removed: string[] = [];
  const next = html.replace(/<div[^>]*class="[^"]*schema-faq[^"]*"[^>]*>[\s\S]*?<\/div>\s*(?=(?:<!--|<h[1-6]|$))/gi, (match) => {
    const sections = [...match.matchAll(/<div[^>]*class="[^"]*schema-faq-section[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
    for (const section of sections) {
      const body = section[1] ?? '';
      const question = decodeEntities(stripTags(body.match(/<strong[^>]*class="[^"]*schema-faq-question[^"]*"[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? ''));
      const answer = (body.match(/<p[^>]*class="[^"]*schema-faq-answer[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').trim();
      if (question && answer) items.push({ question, answer });
    }
    if (sections.length && items.length) {
      removed.push(match);
      return '';
    }
    return match;
  });
  return { html: next, items, removed };
}

function removePrecedingFaqHeading(html: string): string {
  return html.replace(/(?:<!-- wp:heading[\s\S]*?-->\s*)?<h([2-4])[^>]*>\s*(?:<[^>]+>\s*)*(FAQ|Questions fréquentes|Foire aux questions)\b[\s\S]*?<\/h\1>\s*(?:<!-- \/wp:heading -->\s*)?$/i, '');
}

function extractGygBlocks(html: string): { html: string; blocks: EditableContentBlock[] } {
  const blocks: EditableContentBlock[] = [];
  const pattern = /(?:<!-- wp:html -->\s*)?(<(?:div|iframe)[^>]*(?:getyourguide|data-gyg|gyg)[\s\S]*?<\/(?:div|iframe)>)(?:\s*<!-- \/wp:html -->)?/gi;
  const next = html.replace(pattern, (match, widget) => {
    const block = { id: idFrom('html-gyg', blocks.length), type: 'html' as const, html: sanitizeEditableHtml(widget), label: 'Widget GetYourGuide' };
    blocks.push(block);
    return `<!-- editable-html-block:${block.id} -->`;
  });
  return { html: next, blocks };
}

export function normalizeWordpressContent(input: { contentHtml: string; contentJson?: unknown; faqJson?: unknown }): NormalizeResult {
  let html = input.contentHtml;
  const extractedFaq: FaqItem[] = [];
  const ambiguousFaqSections: string[] = [];

  const yoast = extractYoastFaq(html);
  html = yoast.html;
  extractedFaq.push(...yoast.items);
  if (yoast.removed.length) html = removePrecedingFaqHeading(html);

  const schema = extractSchemaFaq(html);
  html = schema.html;
  extractedFaq.push(...schema.items);
  if (schema.removed.length) html = removePrecedingFaqHeading(html);

  if (hasFaqTrace(html) && extractedFaq.length === 0) ambiguousFaqSections.push('FAQ détectée mais format non extrait automatiquement avec confiance.');

  const gyg = extractGygBlocks(html);
  html = gyg.html;

  const blocks: EditableContentBlock[] = [];
  const parts = html.split(/(<!-- editable-html-block:html-gyg-\d{3} -->)/g).filter(Boolean);
  for (const part of parts) {
    const id = part.match(/editable-html-block:(html-gyg-\d{3})/)?.[1];
    if (id) {
      const block = gyg.blocks.find((item) => item.id === id);
      if (block) blocks.push(block);
    } else if (part.trim()) {
      blocks.push({ id: idFrom('content', blocks.length), type: 'contentHtml', html: part.trim(), label: 'Contenu WordPress' });
    }
  }

  const contentHtml = parts.map((part) => part.replace(/<!-- editable-html-block:(html-gyg-\d{3}) -->/g, (_, id) => gyg.blocks.find((item) => item.id === id)?.html ?? '')).join('\n\n').trim();
  const existingFaq = Array.isArray(input.faqJson) ? input.faqJson as FaqItem[] : [];
  const faqJson = existingFaq.length ? existingFaq : extractedFaq;
  const contentJson = { version: 1 as const, source: 'wordpress-normalizer' as const, blocks };
  const changed = gyg.blocks.length > 0 || (!existingFaq.length && extractedFaq.length > 0) || contentHtml !== input.contentHtml;

  return { contentHtml, contentJson, faqJson, getYourGuideBlocks: gyg.blocks, ambiguousFaqSections, changed };
}
