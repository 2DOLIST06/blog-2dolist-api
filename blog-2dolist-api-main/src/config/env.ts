import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters for production safety.'),
  APP_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  AUTH_DEBUG: z.coerce.boolean().default(false),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  AWS_S3_BUCKET_NAME: z.string().min(1).optional(),
  AWS_CLOUDFRONT_URL: z.string().url().optional(),
  AWS_S3_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),
  SMTP_SERVER: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USERNAME: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_EHLO_DOMAIN: z.string().min(1).default('the-muscle-temple-api'),
  MAIL_FROM: z.string().email().optional(),
  NEWSLETTER_RECIPIENT_EMAIL: z.string().email().default('contact@2dolist.fr')
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  corsOrigins: parsed.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
};
