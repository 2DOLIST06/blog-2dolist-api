import { PostStatus, SeoEntityType } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  SITE_BASE_URL,
  buildCategoryCanonical,
  buildPageCanonical,
  buildPostCanonical,
  isPostLocale,
  type PostLocale
} from './urls.js';

type SitemapEntry = {
  loc: string;
  lastmod?: Date | string | null;
  changefreq?: 'daily' | 'weekly' | 'monthly';
  priority?: number;
};

const STATIC_PAGE_KEYS = ['home', 'articles', 'categories', 'about', 'contact'] as const;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatLastmod(value: Date | string): string {
  return new Date(value).toISOString();
}

function renderSitemapEntry(entry: SitemapEntry): string {
  const tags = [`    <loc>${escapeXml(entry.loc)}</loc>`];

  if (entry.lastmod) tags.push(`    <lastmod>${formatLastmod(entry.lastmod)}</lastmod>`);
  if (entry.changefreq) tags.push(`    <changefreq>${entry.changefreq}</changefreq>`);
  if (entry.priority != null) tags.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);

  return `  <url>\n${tags.join('\n')}\n  </url>`;
}

function renderSitemap(entries: SitemapEntry[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map(renderSitemapEntry).join('\n')}\n</urlset>\n`;
}

function normalizePageKey(pageKey: string, locale: PostLocale): string | null {
  const [maybeLocale, ...parts] = pageKey.split(':');
  if (parts.length > 0) {
    if (maybeLocale !== locale || !isPostLocale(maybeLocale)) return null;
    return parts.join(':');
  }

  return pageKey;
}

function dedupeEntries(entries: SitemapEntry[]): SitemapEntry[] {
  const byLocation = new Map<string, SitemapEntry>();

  for (const entry of entries) {
    if (!entry.loc.startsWith(SITE_BASE_URL)) continue;
    const existing = byLocation.get(entry.loc);
    if (!existing) {
      byLocation.set(entry.loc, entry);
      continue;
    }

    const existingLastmod = existing.lastmod ? new Date(existing.lastmod).getTime() : 0;
    const nextLastmod = entry.lastmod ? new Date(entry.lastmod).getTime() : 0;
    if (nextLastmod > existingLastmod) byLocation.set(entry.loc, { ...existing, lastmod: entry.lastmod });
  }

  return [...byLocation.values()];
}

export async function buildSitemapXml(prisma: PrismaClient, locale: PostLocale): Promise<string> {
  const now = new Date();
  const indexablePostWhere = {
    locale,
    status: PostStatus.PUBLISHED,
    isActive: true,
    isIndexable: true,
    publishedAt: { lte: now }
  };

  const [posts, categories, seoPages] = await Promise.all([
    prisma.post.findMany({
      where: indexablePostWhere,
      select: { slug: true, updatedAt: true, publishedAt: true },
      orderBy: [{ publishedAt: 'desc' }]
    }),
    prisma.category.findMany({
      where: { posts: { some: indexablePostWhere } },
      select: { slug: true, updatedAt: true },
      orderBy: { slug: 'asc' }
    }),
    prisma.seoMetadata.findMany({
      where: { entityType: SeoEntityType.PAGE, noIndex: false, pageKey: { not: null } },
      select: { pageKey: true, updatedAt: true },
      orderBy: { pageKey: 'asc' }
    })
  ]);

  const staticEntries: SitemapEntry[] = STATIC_PAGE_KEYS.map((pageKey) => ({
    loc: buildPageCanonical(locale, pageKey),
    changefreq: pageKey === 'home' || pageKey === 'articles' ? 'daily' : 'weekly',
    priority: pageKey === 'home' ? 1 : 0.8
  }));

  const seoPageEntries: SitemapEntry[] = seoPages.flatMap((page) => {
    if (!page.pageKey) return [];
    const pageKey = normalizePageKey(page.pageKey, locale);
    if (!pageKey || pageKey === 'authors') return [];

    return [{ loc: buildPageCanonical(locale, pageKey), lastmod: page.updatedAt, changefreq: 'weekly', priority: pageKey === 'home' ? 1 : 0.8 }];
  });

  const postEntries: SitemapEntry[] = posts.map((post) => ({
    loc: buildPostCanonical(locale, post.slug),
    lastmod: post.updatedAt ?? post.publishedAt,
    changefreq: 'monthly',
    priority: 0.7
  }));

  const categoryEntries: SitemapEntry[] = categories.map((category) => ({
    loc: buildCategoryCanonical(locale, category.slug),
    lastmod: category.updatedAt,
    changefreq: 'weekly',
    priority: 0.6
  }));

  return renderSitemap(dedupeEntries([...staticEntries, ...seoPageEntries, ...postEntries, ...categoryEntries]));
}

export function buildRobotsTxt(): string {
  return ['User-agent: *', 'Allow: /', `Sitemap: ${SITE_BASE_URL}/sitemap.xml`, `Sitemap: ${SITE_BASE_URL}/fr/sitemap.xml`, ''].join('\n');
}
