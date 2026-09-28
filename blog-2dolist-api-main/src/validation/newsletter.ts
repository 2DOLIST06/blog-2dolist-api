import { z } from 'zod';
import { SUPPORTED_LOCALES } from '../config/site.js';

export const NEWSLETTER_INTERESTS = ['airplane', 'ulm', 'parachuting', 'paragliding', 'paramotor', 'helicopter', 'hot_air_balloon', 'gliding'] as const;
const interestSchema = z.enum(NEWSLETTER_INTERESTS);
const regionIdentifierSchema = z.string().trim().min(1).max(120);

export const subscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.'),
  language: z.enum(SUPPORTED_LOCALES).default(SUPPORTED_LOCALES[0]),
  source: z.string().trim().min(1).max(120),
  consent: z.literal(true, { errorMap: () => ({ message: 'Le consentement explicite est obligatoire.' }) }),
  consentTextVersion: z.string().trim().min(1).max(60),
  consentSource: z.string().trim().min(1).max(120).optional(),
  interest: interestSchema.optional(),
  region: regionIdentifierSchema.optional()
}).strict();

export const preferencesTokenSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'Token invalide.');
export const preferencesQuerySchema = z.object({ token: preferencesTokenSchema });
export const unsubscribeSchema = z.object({ token: preferencesTokenSchema }).strict();
export const updatePreferencesSchema = z.object({
  new_articles: z.boolean().optional(), practical_guides: z.boolean().optional(),
  destination_guides: z.boolean().optional(), activity_guides: z.boolean().optional(),
  news_and_updates: z.boolean().optional(), frequency: z.enum(['immediate', 'weekly', 'monthly']).optional(),
  interests: z.array(interestSchema).max(NEWSLETTER_INTERESTS.length).refine((v) => new Set(v).size === v.length, 'Les intérêts doivent être uniques.').optional(),
  regions: z.array(regionIdentifierSchema).max(18).refine((v) => new Set(v).size === v.length, 'Les régions doivent être uniques.').optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'Au moins une préférence est requise.');
