import { env } from './env.js';

function normalizeSiteUrl(url: string): string {
  return url.replace(/\/+$/g, '');
}

function parseLocales(value: string | undefined): readonly [string, ...string[]] {
  const locales = value?.split(',').map((locale) => locale.trim()).filter(Boolean);
  return locales?.length ? [locales[0], ...locales.slice(1)] : ['fr'];
}

export const SITE_NAME = process.env.SITE_NAME?.trim() || 'Blog';
export const SITE_URL = normalizeSiteUrl(process.env.APP_URL?.trim() || process.env.PUBLIC_SITE_URL?.trim() || env.APP_URL || 'http://localhost:3000');
export const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE?.trim() || 'fr';
export const SUPPORTED_LOCALES = parseLocales(process.env.SUPPORTED_LOCALES);
export const DEFAULT_META_TITLE = process.env.DEFAULT_META_TITLE?.trim() || SITE_NAME;
export const DEFAULT_META_DESCRIPTION = process.env.DEFAULT_META_DESCRIPTION?.trim() || '';
