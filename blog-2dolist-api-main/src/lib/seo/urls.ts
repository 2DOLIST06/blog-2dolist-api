import { PostStatus } from '@prisma/client';

export const SITE_BASE_URL = 'https://bodytrainingguide.com';
export const SUPPORTED_POST_LOCALES = ['en', 'fr'] as const;
export const DEFAULT_POST_LOCALE = 'en';

export type PostLocale = (typeof SUPPORTED_POST_LOCALES)[number];
export type SiteLocale = PostLocale;

export type PostUrlSource = {
  locale: string;
  slug: string;
  status?: PostStatus;
  isActive?: boolean;
  isIndexable?: boolean;
  publishedAt?: Date | string | null;
};

export type LocalizedUrlLink = {
  locale: SiteLocale;
  path: string;
  canonicalUrl: string;
};

export type PostTranslationLink = LocalizedUrlLink & {
  slug: string;
};

export type HreflangLink = {
  hreflang: SiteLocale | 'x-default';
  href: string;
};

export type PostHreflangLink = HreflangLink;

const PAGE_BASE_PATHS = {
  home: '/',
  posts: '/articles',
  articles: '/articles',
  categories: '/categories',
  authors: '/authors'
} as const;

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function normalizeBasePath(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath || trimmedPath === '/') return '/';
  return `/${trimSlashes(trimmedPath)}`;
}

export function isPostLocale(locale: unknown): locale is PostLocale {
  return typeof locale === 'string' && SUPPORTED_POST_LOCALES.includes(locale as PostLocale);
}

export function resolvePostLocale(locale: unknown): PostLocale {
  return isPostLocale(locale) ? locale : DEFAULT_POST_LOCALE;
}

export function buildLocalizedPath(locale: string, path: string): string {
  const resolvedLocale = resolvePostLocale(locale);
  const normalizedPath = normalizeBasePath(path);

  if (resolvedLocale === DEFAULT_POST_LOCALE) return normalizedPath;
  if (normalizedPath === '/') return `/${resolvedLocale}`;
  return `/${resolvedLocale}${normalizedPath}`;
}

export function buildCanonicalUrl(locale: string, path: string): string {
  return `${SITE_BASE_URL}${buildLocalizedPath(locale, path)}`;
}

export function buildLocalizedLinks(pathByLocale: Partial<Record<SiteLocale, string>>): LocalizedUrlLink[] {
  return SUPPORTED_POST_LOCALES.flatMap((locale) => {
    const path = pathByLocale[locale];
    if (!path) return [];
    return [{ locale, path: buildLocalizedPath(locale, path), canonicalUrl: buildCanonicalUrl(locale, path) }];
  });
}

export function buildHreflang(pathByLocale: Partial<Record<SiteLocale, string>>): HreflangLink[] {
  const links: HreflangLink[] = buildLocalizedLinks(pathByLocale).map((link) => ({ hreflang: link.locale, href: link.canonicalUrl }));
  const defaultPath = pathByLocale[DEFAULT_POST_LOCALE];
  if (defaultPath) links.push({ hreflang: 'x-default', href: buildCanonicalUrl(DEFAULT_POST_LOCALE, defaultPath) });
  return links;
}

export function buildPagePath(locale: string, pageKey: string): string {
  const basePath = PAGE_BASE_PATHS[pageKey as keyof typeof PAGE_BASE_PATHS] ?? `/${trimSlashes(pageKey)}`;
  return buildLocalizedPath(locale, basePath);
}

export function buildPageCanonical(locale: string, pageKey: string): string {
  const basePath = PAGE_BASE_PATHS[pageKey as keyof typeof PAGE_BASE_PATHS] ?? `/${trimSlashes(pageKey)}`;
  return buildCanonicalUrl(locale, basePath);
}

export function buildPageHreflang(pageKey: string): HreflangLink[] {
  const basePath = PAGE_BASE_PATHS[pageKey as keyof typeof PAGE_BASE_PATHS] ?? `/${trimSlashes(pageKey)}`;
  return buildHreflang({ en: basePath, fr: basePath });
}

export function buildPostPath(locale: string, slug: string): string {
  return buildLocalizedPath(locale, `/articles/${slug}`);
}

export function buildPostCanonical(locale: string, slug: string): string {
  return buildCanonicalUrl(locale, `/articles/${slug}`);
}

export function buildPostsIndexPath(locale: string): string {
  return buildLocalizedPath(locale, '/articles');
}

export function buildPostsIndexCanonical(locale: string): string {
  return buildCanonicalUrl(locale, '/articles');
}

export function buildPostsIndexHreflang(): HreflangLink[] {
  return buildHreflang({ en: '/articles', fr: '/articles' });
}

export function buildCategoryPath(locale: string, slug: string): string {
  return buildLocalizedPath(locale, `/categories/${slug}`);
}

export function buildCategoryCanonical(locale: string, slug: string): string {
  return buildCanonicalUrl(locale, `/categories/${slug}`);
}

export function buildCategoryHreflang(slug: string): HreflangLink[] {
  return buildHreflang({ en: `/categories/${slug}`, fr: `/categories/${slug}` });
}

export function buildAuthorPath(locale: string, slug: string): string {
  return buildLocalizedPath(locale, `/authors/${slug}`);
}

export function buildAuthorCanonical(locale: string, slug: string): string {
  return buildCanonicalUrl(locale, `/authors/${slug}`);
}

export function buildAuthorHreflang(slug: string): HreflangLink[] {
  return buildHreflang({ en: `/authors/${slug}`, fr: `/authors/${slug}` });
}

function isPublishedActiveIndexable(post: PostUrlSource, now = new Date()): boolean {
  if (post.status !== PostStatus.PUBLISHED || !post.isActive || !post.isIndexable) return false;
  if (!post.publishedAt) return false;
  return new Date(post.publishedAt) <= now;
}

export function buildPostTranslationLink(post: PostUrlSource): PostTranslationLink {
  const locale = resolvePostLocale(post.locale);
  return {
    locale,
    slug: post.slug,
    path: buildPostPath(locale, post.slug),
    canonicalUrl: buildPostCanonical(locale, post.slug)
  };
}

export function buildPostTranslations(currentPost: PostUrlSource, translations: PostUrlSource[]): PostTranslationLink[] {
  return translations
    .filter((translation) => translation.locale !== currentPost.locale)
    .filter((translation) => isPostLocale(translation.locale))
    .filter((translation) => isPublishedActiveIndexable(translation))
    .map(buildPostTranslationLink);
}

export function buildPostHreflang(currentPost: PostUrlSource, translations: PostUrlSource[]): PostHreflangLink[] {
  const eligiblePosts = [currentPost, ...translations]
    .filter((post) => isPostLocale(post.locale))
    .filter((post) => isPublishedActiveIndexable(post));
  const byLocale = new Map<PostLocale, PostUrlSource>();

  for (const post of eligiblePosts) {
    const locale = resolvePostLocale(post.locale);
    if (!byLocale.has(locale)) byLocale.set(locale, post);
  }

  const pathByLocale: Partial<Record<SiteLocale, string>> = {};
  for (const locale of SUPPORTED_POST_LOCALES) {
    const post = byLocale.get(locale);
    if (post) pathByLocale[locale] = `/articles/${post.slug}`;
  }

  return buildHreflang(pathByLocale);
}
