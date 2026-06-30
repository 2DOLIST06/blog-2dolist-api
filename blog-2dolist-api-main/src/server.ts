import 'dotenv/config';
import Fastify, { FastifyPluginCallback, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { prisma } from './db/client.js';
import { publicRoutes } from './routes/public/index.js';
import { adminApiRoutes } from './routes/admin/api.js';
import { adminPanelRoutes } from './routes/admin/panel.js';
import { buildRobotsTxt, buildSitemapXml } from './lib/seo/sitemap.js';

const MULTIPART_PACKAGE = '@fastify/multipart';
const { default: multipart } = (await import(MULTIPART_PACKAGE)) as {
  default: FastifyPluginCallback<{ limits?: { files?: number; fileSize?: number } }>;
};

const app = Fastify({ logger: true });

app.decorate('prisma', prisma);

app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (env.corsOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Origin not allowed by CORS'), false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true
});
app.register(cookie);
app.register(jwt, { secret: env.JWT_SECRET });
app.register(multipart, {
  limits: {
    files: 1,
    fileSize: env.AWS_S3_UPLOAD_MAX_BYTES
  }
});

const sendEnglishSitemap = async (_request: unknown, reply: FastifyReply) => {
  const sitemap = await buildSitemapXml(prisma, 'en');

  return reply
    .header('Content-Type', 'application/xml; charset=utf-8')
    .header('Cache-Control', 'public, max-age=0, s-maxage=3600')
    .send(sitemap);
};

const sendFrenchSitemap = async (_request: unknown, reply: FastifyReply) => {
  const sitemap = await buildSitemapXml(prisma, 'fr');

  return reply
    .header('Content-Type', 'application/xml; charset=utf-8')
    .header('Cache-Control', 'public, max-age=0, s-maxage=3600')
    .send(sitemap);
};

app.get('/sitemap.xml', sendEnglishSitemap);
app.get('/sitemap', sendEnglishSitemap);
app.get('/fr/sitemap.xml', sendFrenchSitemap);
app.get('/fr/sitemap', sendFrenchSitemap);

app.get('/robots.txt', async (_request, reply) => reply.header('Content-Type', 'text/plain; charset=utf-8').send(buildRobotsTxt()));

app.get('/fr/robots.txt', async (_request, reply) => reply.header('Content-Type', 'text/plain; charset=utf-8').send(buildRobotsTxt()));

app.register(publicRoutes, { prefix: '/api' });
app.register(adminApiRoutes, { prefix: '/admin-api' });
app.register(adminPanelRoutes);

app.setNotFoundHandler((_, reply) => {
  reply.code(404).send({ message: 'Not found' });
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    const issuePath = firstIssue?.path?.length ? `${firstIssue.path.join('.')}: ` : '';
    reply.code(400).send({ message: `${issuePath}${firstIssue?.message ?? 'Validation error'}` });
    return;
  }

  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    reply.code(error.statusCode).send({ message: error.message || 'Request error' });
    return;
  }

  request.log.error(error);
  reply.code(500).send({ message: 'Internal server error' });
});

app.addHook('onClose', async () => {
  await prisma.$disconnect();
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

start();
