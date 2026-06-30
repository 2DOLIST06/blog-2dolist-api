import { z } from 'zod';

export const seoSchema = z.object({
  title: z.string().max(70).optional().or(z.literal('')),
  description: z.string().max(160).optional().or(z.literal('')),
  canonicalUrl: z.string().url().optional().or(z.literal('')),
  noIndex: z.boolean().default(false),
  openGraphImageId: z.string().optional().or(z.literal(''))
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10)
});
