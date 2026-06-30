import { PostStatus, UserRole } from '@prisma/client';
import { z } from 'zod';
import { seoSchema } from './common.js';
import { SUPPORTED_POST_LOCALES } from '../lib/seo/urls.js';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2),
  password: z.string().min(10),
  role: z.nativeEnum(UserRole)
});

export const mediaSchema = z.object({
  url: z.string().url(),
  altText: z.string().optional(),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
  source: z.string().optional(),
  storageKey: z.string().optional().nullable(),
  bucket: z.string().optional().nullable(),
  sizeBytes: z.coerce.number().int().positive().optional().nullable()
});

export const authorSchema = z.object({
  name: z.string().min(2),
  slug: z.string().optional(),
  bio: z.string().optional(),
  avatarMediaId: z.string().optional().nullable(),
  seo: seoSchema.optional()
});

export const categorySchema = z.object({
  name: z.string().min(2),
  slug: z.string().optional(),
  description: z.string().optional(),
  seo: seoSchema.optional()
});

export const tagSchema = z.object({
  name: z.string().min(2),
  slug: z.string().optional()
});

export const postSchema = z.object({
  title: z.string().min(4),
  slug: z.string().optional(),
  path: z.string().trim().optional().nullable(),
  locale: z.enum(SUPPORTED_POST_LOCALES).default('en'),
  translationGroupId: z.string().trim().optional().nullable(),
  excerpt: z.string().max(280).optional(),
  contentHtml: z.string().min(10),
  contentJson: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  h1: z.string().min(2).optional().nullable(),
  chapoHtml: z.string().optional().nullable(),
  faqJson: z.array(z.unknown()).optional().nullable(),
  heroImageUrl: z.string().url().optional().nullable(),
  heroImageAlt: z.string().optional().nullable(),
  metaTitle: z.string().max(70).optional().nullable(),
  metaDescription: z.string().max(160).optional().nullable(),
  canonicalUrl: z.string().url().optional().nullable(),
  robots: z.string().optional(),
  isActive: z.boolean().optional().default(false),
  isIndexable: z.boolean().optional().default(false),
  categorySlug: z.string().optional().nullable(),
  tagsJson: z.array(z.unknown()).optional().nullable(),
  jsonLd: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.null()]).optional(),
  status: z.nativeEnum(PostStatus).default(PostStatus.DRAFT),
  publishedAt: z.string().datetime().optional().nullable(),
  readingTimeMinutes: z.coerce.number().int().positive().optional().nullable(),
  authorId: z.string().trim().min(1),
  categoryId: z.string().trim().optional().nullable(),
  coverImageId: z.string().trim().optional().nullable(),
  tagIds: z.array(z.string().trim()).default([]),
  relatedPostIds: z.array(z.string().trim()).default([]),
  seo: seoSchema.optional()
});
