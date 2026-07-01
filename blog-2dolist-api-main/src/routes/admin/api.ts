import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PostStatus, Prisma, PrismaClient, SeoEntityType, UserRole } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeSlug } from '../../lib/slug.js';
import { authorSchema, categorySchema, createUserSchema, loginSchema, mediaSchema, postSchema, tagSchema } from '../../validation/admin.js';
import { requireAdminAuth, requireRole } from '../../lib/auth.js';
import { deleteImageFromS3, ImageUploadError, S3StorageError, uploadImageToS3 } from '../../lib/storage/s3.js';
import { buildPostPublicCanonical, buildPostPublicPath, isPostLocale, normalizePublicPath } from '../../lib/seo/urls.js';

const pageSeoSchema = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(160).optional(),
  canonicalUrl: z.string().url().optional(),
  noIndex: z.boolean().optional().default(false),
  openGraphImageId: z.string().optional()
});

function uniqueIds(ids: string[]) {
  return [...new Set(ids.filter(Boolean))];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeRequiredId(id: string): string {
  return id.trim();
}

function normalizeOptionalId(id?: string | null): string | undefined {
  if (id == null) return undefined;
  const normalized = id.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalText(value?: string | null): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeTranslationGroupId(value?: string | null): string | undefined {
  return normalizeOptionalText(value);
}

function serializeAdminPost<T extends { locale: string; slug: string; translationGroupId: string }>(post: T) {
  return {
    ...post,
    path: buildPostPublicPath(post),
    canonicalUrl: buildPostPublicCanonical(post)
  };
}

function getPageSeoKey(key: string, query: unknown): { pageKey: string; locale?: string } {
  const locale = (query as { locale?: unknown }).locale;
  if (!isPostLocale(locale)) return { pageKey: key };
  return { pageKey: `${locale}:${key}`, locale };
}

async function ensurePostI18nAvailable(
  prisma: PrismaClient,
  input: { locale: string; slug: string; translationGroupId: string; excludePostId?: string }
): Promise<string | null> {
  const slugConflict = await prisma.post.findFirst({
    where: {
      locale: input.locale,
      slug: input.slug,
      ...(input.excludePostId ? { id: { not: input.excludePostId } } : {})
    },
    select: { id: true }
  });
  if (slugConflict) return `Slug déjà utilisé pour la locale ${input.locale}. Modifie le slug ou la locale.`;

  const translationConflict = await prisma.post.findFirst({
    where: {
      translationGroupId: input.translationGroupId,
      locale: input.locale,
      ...(input.excludePostId ? { id: { not: input.excludePostId } } : {})
    },
    select: { id: true }
  });
  if (translationConflict) return `Une traduction ${input.locale} existe déjà dans ce groupe de traduction.`;

  return null;
}

async function getAdminTranslations(prisma: PrismaClient, translationGroupIds: string[]) {
  const uniqueGroupIds = uniqueIds(translationGroupIds);
  if (!uniqueGroupIds.length) return new Map<string, Array<{ id: string; locale: string; slug: string; title: string; status: PostStatus; path: string; canonicalUrl: string }>>();

  const translations = await prisma.post.findMany({
    where: { translationGroupId: { in: uniqueGroupIds } },
    select: { id: true, locale: true, slug: true, path: true, canonicalUrl: true, title: true, status: true, translationGroupId: true }
  });

  const byGroup = new Map<string, Array<{ id: string; locale: string; slug: string; title: string; status: PostStatus; path: string; canonicalUrl: string }>>();
  for (const translation of translations) {
    const items = byGroup.get(translation.translationGroupId) ?? [];
    items.push({
      id: translation.id,
      locale: translation.locale,
      slug: translation.slug,
      title: translation.title,
      status: translation.status,
      path: buildPostPublicPath(translation),
      canonicalUrl: buildPostPublicCanonical(translation)
    });
    byGroup.set(translation.translationGroupId, items);
  }

  return byGroup;
}

async function getDirectMediaUsageCount(prisma: PrismaClient, mediaId: string): Promise<number> {
  const [coverCount, openGraphCount, avatarCount] = await Promise.all([
    prisma.post.count({ where: { coverImageId: mediaId } }),
    prisma.seoMetadata.count({ where: { openGraphImageId: mediaId } }),
    prisma.author.count({ where: { avatarMediaId: mediaId } })
  ]);

  return coverCount + openGraphCount + avatarCount;
}

async function ensureExistingIds(
  prisma: PrismaClient,
  model: 'tag' | 'post' | 'media',
  ids: string[]
): Promise<string[]> {
  if (!ids.length) return [];
  if (model === 'tag') {
    const found = await prisma.tag.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return found.map((item) => item.id);
  }
  if (model === 'post') {
    const found = await prisma.post.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return found.map((item) => item.id);
  }
  const found = await prisma.media.findMany({ where: { id: { in: ids } }, select: { id: true } });
  return found.map((item) => item.id);
}

export const adminApiRoutes: FastifyPluginAsync = async (fastify) => {
  const loginHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = loginSchema.parse(request.body);
    const email = normalizeEmail(body.email);

    if (env.AUTH_DEBUG) {
      request.log.info(
        {
          route: request.url,
          canonicalRoute: '/admin-api/auth/login',
          email,
          passwordLength: body.password.length
        },
        'Admin login attempt received'
      );
    }

    const user = await fastify.prisma.user.findUnique({ where: { email } });

    if (env.AUTH_DEBUG) {
      request.log.info(
        {
          email,
          userFound: Boolean(user),
          userIdPreview: user ? `${user.id.slice(0, 6)}...` : null,
          role: user?.role,
          hasPasswordHash: Boolean(user?.passwordHash),
          passwordHashLength: user?.passwordHash?.length ?? 0
        },
        'Admin login user lookup result'
      );
    }

    if (!user || user.role !== UserRole.ADMIN) {
      if (env.AUTH_DEBUG) {
        request.log.warn({ email, reason: user ? 'not_admin' : 'email_not_found', role: user?.role, statusCode: 401 }, 'Admin login rejected');
      }
      return reply.code(401).send({ message: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(body.password, user.passwordHash);

    if (env.AUTH_DEBUG) {
      request.log.info(
        {
          email,
          compareResult: isValid,
          hashAlgorithmGuess: user.passwordHash.startsWith('$2') ? 'bcrypt' : 'unknown',
          statusCode: isValid ? 200 : 401
        },
        'Admin password verification result'
      );
    }

    if (!isValid) {
      if (env.AUTH_DEBUG) {
        request.log.warn({ email, reason: 'bad_password', statusCode: 401 }, 'Admin login rejected');
      }
      return reply.code(401).send({ message: 'Invalid credentials' });
    }

    const token = await reply.jwtSign({ userId: user.id, email: user.email, role: user.role }, { expiresIn: '12h' });

    if (env.AUTH_DEBUG) {
      request.log.info(
        {
          email,
          tokenFormat: 'jwt',
          tokenPreview: `${token.slice(0, 12)}...`,
          statusCode: 200
        },
        'Admin login success response'
      );
    }

    return {
      token,
      data: { token, user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName } }
    };
  };

  fastify.post('/auth/login', loginHandler);
  fastify.post('/login', loginHandler);

  fastify.register(async (protectedScope) => {
    protectedScope.addHook('preHandler', requireAdminAuth);

    protectedScope.get('/me', async (request) => {
      const user = await fastify.prisma.user.findUnique({ where: { id: request.adminUser.userId } });
      return { data: user };
    });

    protectedScope.get('/dashboard', async () => {
      const [posts, drafts, published, categories, authors] = await Promise.all([
        fastify.prisma.post.count(),
        fastify.prisma.post.count({ where: { status: PostStatus.DRAFT } }),
        fastify.prisma.post.count({ where: { status: PostStatus.PUBLISHED } }),
        fastify.prisma.category.count(),
        fastify.prisma.author.count()
      ]);
      return { data: { posts, drafts, published, categories, authors } };
    });

    protectedScope.register(async (adminOnly) => {
      adminOnly.addHook('preHandler', requireRole([UserRole.ADMIN]));
      adminOnly.post('/users', async (request) => {
        const body = createUserSchema.parse(request.body);
        const passwordHash = await bcrypt.hash(body.password, 10);
        const email = normalizeEmail(body.email);
        const user = await fastify.prisma.user.create({
          data: { email, passwordHash, role: body.role, displayName: body.displayName }
        });
        return { data: user };
      });
    });

    protectedScope.get('/newsletter-subscribers', async () => {
      const subscribers = await fastify.prisma.newsletterSubscriber.findMany({
        orderBy: { createdAt: 'desc' }
      });
      return { data: subscribers };
    });

    protectedScope.get('/posts', async () => {
      const posts = await fastify.prisma.post.findMany({
        include: {
          author: true,
          category: true,
          coverImage: true,
          seoMetadata: true,
          postTags: { include: { tag: true } },
          relatedFrom: { include: { targetPost: { select: { id: true, title: true, slug: true, locale: true, translationGroupId: true } } } }
        },
        orderBy: { updatedAt: 'desc' }
      });
      const translationsByGroup = await getAdminTranslations(fastify.prisma, posts.map((post) => post.translationGroupId));
      return {
        data: posts.map((post) => ({
          ...serializeAdminPost(post),
          translations: (translationsByGroup.get(post.translationGroupId) ?? []).filter((translation) => translation.id !== post.id)
        }))
      };
    });

    protectedScope.get('/posts/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const post = await fastify.prisma.post.findUnique({
        where: { id },
        include: {
          author: true,
          category: true,
          coverImage: true,
          seoMetadata: true,
          postTags: { include: { tag: true } },
          relatedFrom: { include: { targetPost: { select: { id: true, title: true, slug: true, locale: true, translationGroupId: true } } } }
        }
      });

      if (!post) return reply.code(404).send({ message: 'Post not found' });

      const translationsByGroup = await getAdminTranslations(fastify.prisma, [post.translationGroupId]);
      return {
        data: {
          ...serializeAdminPost(post),
          translations: (translationsByGroup.get(post.translationGroupId) ?? []).filter((translation) => translation.id !== post.id)
        }
      };
    });

    protectedScope.post('/posts', async (request, reply) => {
      const body = postSchema.parse(request.body);
      const slug = body.slug ? makeSlug(body.slug) : makeSlug(body.title);
      const locale = body.locale;
      const providedTranslationGroupId = normalizeTranslationGroupId(body.translationGroupId);
      const translationGroupId = providedTranslationGroupId ?? randomUUID();
      const authorId = normalizeRequiredId(body.authorId);
      const categoryId = normalizeOptionalId(body.categoryId);
      const coverImageId = normalizeOptionalId(body.coverImageId);
      const tagIds = uniqueIds(body.tagIds.map((id) => id.trim()));
      const relatedPostIds = uniqueIds(body.relatedPostIds.map((id) => id.trim()));

      const [author, category] = await Promise.all([
        fastify.prisma.author.findUnique({ where: { id: authorId }, select: { id: true } }),
        categoryId ? fastify.prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } }) : Promise.resolve(null)
      ]);

      if (!author) return reply.code(400).send({ message: 'Auteur introuvable côté API. Recharge la page et réessaie.' });
      if (categoryId && !category) return reply.code(400).send({ message: 'Catégorie introuvable côté API. Recharge la page et réessaie.' });

      if (coverImageId) {
        const cover = await fastify.prisma.media.findUnique({ where: { id: coverImageId }, select: { id: true } });
        if (!cover) return reply.code(400).send({ message: 'Image de couverture introuvable côté API. Recharge la page et réessaie.' });
      }

      const existingTagIds = await ensureExistingIds(fastify.prisma, 'tag', tagIds);
      if (existingTagIds.length !== tagIds.length) {
        return reply.code(400).send({ message: 'Un ou plusieurs tags sont introuvables côté API. Recharge la page et réessaie.' });
      }

      const existingRelatedIds = await ensureExistingIds(fastify.prisma, 'post', relatedPostIds);
      if (existingRelatedIds.length !== relatedPostIds.length) {
        return reply.code(400).send({ message: 'Un ou plusieurs articles liés sont introuvables côté API. Recharge la page et réessaie.' });
      }

      if (providedTranslationGroupId) {
        const groupExists = await fastify.prisma.post.findFirst({ where: { translationGroupId }, select: { id: true } });
        if (!groupExists) return reply.code(400).send({ message: 'Groupe de traduction introuvable.' });
      }

      const i18nConflict = await ensurePostI18nAvailable(fastify.prisma, { locale, slug, translationGroupId });
      if (i18nConflict) return reply.code(409).send({ message: i18nConflict });

      const post = await fastify.prisma.post.create({
        data: {
          title: body.title,
          slug,
          path: normalizePublicPath(body.path),
          locale,
          translationGroupId,
          excerpt: body.excerpt,
          contentMarkdown: body.contentHtml,
          h1: normalizeOptionalText(body.h1),
          chapoHtml: normalizeOptionalText(body.chapoHtml),
          contentJson: body.contentJson as Prisma.InputJsonValue | undefined,
          contentHtml: normalizeOptionalText(body.contentHtml),
          faqJson: body.faqJson as Prisma.InputJsonValue | undefined,
          heroImageUrl: normalizeOptionalText(body.heroImageUrl),
          heroImageAlt: normalizeOptionalText(body.heroImageAlt),
          metaTitle: normalizeOptionalText(body.metaTitle),
          metaDescription: normalizeOptionalText(body.metaDescription),
          canonicalUrl: normalizeOptionalText(body.canonicalUrl),
          robots: normalizeOptionalText(body.robots) ?? 'noindex,follow',
          isActive: body.isActive ?? false,
          isIndexable: body.isIndexable ?? false,
          categorySlug: body.categorySlug ? makeSlug(body.categorySlug) : undefined,
          tagsJson: body.tagsJson as Prisma.InputJsonValue | undefined,
          jsonLd: (body.jsonLd ?? undefined) as Prisma.InputJsonValue | undefined,
          status: body.status,
          publishedAt: body.publishedAt ? new Date(body.publishedAt) : body.status === PostStatus.PUBLISHED ? new Date() : null,
          readingTimeMinutes: body.readingTimeMinutes ?? undefined,
          authorId,
          categoryId,
          coverImageId
        }
      });

      if (tagIds.length) {
        await fastify.prisma.postTag.createMany({
          data: tagIds.map((tagId) => ({ postId: post.id, tagId })),
          skipDuplicates: true
        });
      }

      const filteredRelatedPostIds = relatedPostIds.filter((relatedId) => relatedId !== post.id);
      if (filteredRelatedPostIds.length) {
        await fastify.prisma.postRelation.createMany({
          data: filteredRelatedPostIds.map((targetPostId) => ({ sourcePostId: post.id, targetPostId })),
          skipDuplicates: true
        });
      }

      if (body.seo) {
        await fastify.prisma.seoMetadata.create({
          data: {
            entityType: SeoEntityType.POST,
            postId: post.id,
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          }
        });
      }

      return { data: serializeAdminPost(post) };
    });

    protectedScope.put('/posts/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const rawBody = request.body as { locale?: unknown } | null;
      const body = postSchema.parse(request.body);
      const existing = await fastify.prisma.post.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ message: 'Post not found' });

      const requestedLocale = rawBody && Object.prototype.hasOwnProperty.call(rawBody, 'locale') ? body.locale : existing.locale;
      const isTranslationSave = requestedLocale !== existing.locale;
      const targetTranslation = isTranslationSave
        ? await fastify.prisma.post.findFirst({
            where: { translationGroupId: existing.translationGroupId, locale: requestedLocale }
          })
        : null;
      const shouldCreateTranslation = isTranslationSave && !targetTranslation;
      const targetPostId = targetTranslation?.id ?? id;
      const targetPublishedAt = targetTranslation?.publishedAt ?? existing.publishedAt;

      const slug = body.slug ? makeSlug(body.slug) : makeSlug(body.title);
      const locale = requestedLocale;
      const providedTranslationGroupId = normalizeTranslationGroupId(body.translationGroupId);
      const translationGroupId = isTranslationSave ? existing.translationGroupId : providedTranslationGroupId ?? existing.translationGroupId;
      const authorId = normalizeRequiredId(body.authorId);
      const categoryId = normalizeOptionalId(body.categoryId);
      const coverImageId = normalizeOptionalId(body.coverImageId);
      const tagIds = uniqueIds(body.tagIds.map((tagId) => tagId.trim()));
      const relatedPostIds = uniqueIds(body.relatedPostIds.map((relatedId) => relatedId.trim())).filter((relatedId) => relatedId !== id && relatedId !== targetPostId);

      const [author, category] = await Promise.all([
        fastify.prisma.author.findUnique({ where: { id: authorId }, select: { id: true } }),
        categoryId ? fastify.prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } }) : Promise.resolve(null)
      ]);

      if (!author) return reply.code(400).send({ message: 'Auteur introuvable côté API. Recharge la page et réessaie.' });
      if (categoryId && !category) return reply.code(400).send({ message: 'Catégorie introuvable côté API. Recharge la page et réessaie.' });

      if (coverImageId) {
        const cover = await fastify.prisma.media.findUnique({ where: { id: coverImageId }, select: { id: true } });
        if (!cover) return reply.code(400).send({ message: 'Image de couverture introuvable côté API. Recharge la page et réessaie.' });
      }

      const existingTagIds = await ensureExistingIds(fastify.prisma, 'tag', tagIds);
      if (existingTagIds.length !== tagIds.length) {
        return reply.code(400).send({ message: 'Un ou plusieurs tags sont introuvables côté API. Recharge la page et réessaie.' });
      }

      const existingRelatedIds = await ensureExistingIds(fastify.prisma, 'post', relatedPostIds);
      if (existingRelatedIds.length !== relatedPostIds.length) {
        return reply.code(400).send({ message: 'Un ou plusieurs articles liés sont introuvables côté API. Recharge la page et réessaie.' });
      }

      if (!isTranslationSave && providedTranslationGroupId && providedTranslationGroupId !== existing.translationGroupId) {
        const groupExists = await fastify.prisma.post.findFirst({ where: { translationGroupId }, select: { id: true } });
        if (!groupExists) return reply.code(400).send({ message: 'Groupe de traduction introuvable.' });
      }

      const i18nConflict = await ensurePostI18nAvailable(fastify.prisma, {
        locale,
        slug,
        translationGroupId,
        excludePostId: shouldCreateTranslation ? undefined : targetPostId
      });
      if (i18nConflict) return reply.code(409).send({ message: i18nConflict });

      const postData = {
        title: body.title,
        slug,
        path: normalizePublicPath(body.path),
        locale,
        translationGroupId,
        excerpt: body.excerpt,
        contentMarkdown: body.contentHtml,
        h1: normalizeOptionalText(body.h1),
        chapoHtml: normalizeOptionalText(body.chapoHtml),
        contentJson: body.contentJson as Prisma.InputJsonValue | undefined,
        contentHtml: normalizeOptionalText(body.contentHtml),
        faqJson: body.faqJson as Prisma.InputJsonValue | undefined,
        heroImageUrl: normalizeOptionalText(body.heroImageUrl),
        heroImageAlt: normalizeOptionalText(body.heroImageAlt),
        metaTitle: normalizeOptionalText(body.metaTitle),
        metaDescription: normalizeOptionalText(body.metaDescription),
        canonicalUrl: normalizeOptionalText(body.canonicalUrl),
        robots: normalizeOptionalText(body.robots) ?? 'noindex,follow',
        isActive: body.isActive ?? false,
        isIndexable: body.isIndexable ?? false,
        categorySlug: body.categorySlug ? makeSlug(body.categorySlug) : undefined,
        tagsJson: body.tagsJson as Prisma.InputJsonValue | undefined,
        jsonLd: (body.jsonLd ?? undefined) as Prisma.InputJsonValue | undefined,
        status: body.status,
        publishedAt: body.publishedAt ? new Date(body.publishedAt) : body.status === PostStatus.PUBLISHED ? targetPublishedAt ?? new Date() : null,
        readingTimeMinutes: body.readingTimeMinutes ?? undefined,
        authorId,
        categoryId,
        coverImageId
      };

      const saved = shouldCreateTranslation
        ? await fastify.prisma.post.create({ data: postData })
        : await fastify.prisma.post.update({
            where: { id: targetPostId },
            data: postData
          });

      await fastify.prisma.postTag.deleteMany({ where: { postId: saved.id } });
      if (tagIds.length) {
        await fastify.prisma.postTag.createMany({
          data: tagIds.map((tagId) => ({ postId: saved.id, tagId })),
          skipDuplicates: true
        });
      }

      await fastify.prisma.postRelation.deleteMany({ where: { sourcePostId: saved.id } });
      if (relatedPostIds.length) {
        await fastify.prisma.postRelation.createMany({
          data: relatedPostIds.map((targetPostId) => ({ sourcePostId: saved.id, targetPostId })),
          skipDuplicates: true
        });
      }

      if (body.seo) {
        await fastify.prisma.seoMetadata.upsert({
          where: { postId: saved.id },
          update: {
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          },
          create: {
            entityType: SeoEntityType.POST,
            postId: saved.id,
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          }
        });
      }

      return { data: serializeAdminPost(saved) };
    });

    protectedScope.delete('/posts/:id', async (request) => {
      const { id } = request.params as { id: string };
      await fastify.prisma.post.delete({ where: { id } });
      return { success: true };
    });

    protectedScope.get('/categories', async () => ({ data: await fastify.prisma.category.findMany({ include: { seoMetadata: true } }) }));
    protectedScope.post('/categories', async (request) => {
      const body = categorySchema.parse(request.body);
      const category = await fastify.prisma.category.create({
        data: { name: body.name, slug: body.slug ? makeSlug(body.slug) : makeSlug(body.name), description: body.description }
      });
      if (body.seo) {
        await fastify.prisma.seoMetadata.create({
          data: {
            entityType: SeoEntityType.CATEGORY,
            categoryId: category.id,
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          }
        });
      }
      return { data: category };
    });

    protectedScope.put('/categories/:id', async (request) => {
      const { id } = request.params as { id: string };
      const body = categorySchema.parse(request.body);
      const category = await fastify.prisma.category.update({
        where: { id },
        data: { name: body.name, slug: body.slug ? makeSlug(body.slug) : makeSlug(body.name), description: body.description }
      });
      if (body.seo) {
        await fastify.prisma.seoMetadata.upsert({
          where: { categoryId: id },
          update: {
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          },
          create: {
            entityType: SeoEntityType.CATEGORY,
            categoryId: id,
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          }
        });
      }
      return { data: category };
    });
    protectedScope.delete('/categories/:id', async (request, reply) => {
      try {
        return {
          data: await fastify.prisma.category.delete({ where: { id: (request.params as { id: string }).id } })
        };
      } catch {
        return reply.code(409).send({ message: 'Impossible de supprimer cette catégorie (posts liés).' });
      }
    });

    protectedScope.get('/authors', async () => ({
      data: await fastify.prisma.author.findMany({ include: { seoMetadata: true, avatarMedia: true } })
    }));
    protectedScope.post('/authors', async (request) => {
      const body = authorSchema.parse(request.body);
      const author = await fastify.prisma.author.create({
        data: {
          name: body.name,
          slug: body.slug ? makeSlug(body.slug) : makeSlug(body.name),
          bio: body.bio,
          avatarMediaId: body.avatarMediaId || undefined
        }
      });
      if (body.seo) {
        await fastify.prisma.seoMetadata.create({
          data: {
            entityType: SeoEntityType.AUTHOR,
            authorId: author.id,
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          }
        });
      }
      return { data: author };
    });
    protectedScope.put('/authors/:id', async (request) => {
      const { id } = request.params as { id: string };
      const body = authorSchema.parse(request.body);
      const author = await fastify.prisma.author.update({
        where: { id },
        data: {
          name: body.name,
          slug: body.slug ? makeSlug(body.slug) : makeSlug(body.name),
          bio: body.bio,
          avatarMediaId: body.avatarMediaId || undefined
        }
      });
      if (body.seo) {
        await fastify.prisma.seoMetadata.upsert({
          where: { authorId: id },
          update: {
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          },
          create: {
            entityType: SeoEntityType.AUTHOR,
            authorId: id,
            title: body.seo.title || undefined,
            description: body.seo.description || undefined,
            canonicalUrl: body.seo.canonicalUrl || undefined,
            noIndex: body.seo.noIndex,
            openGraphImageId: body.seo.openGraphImageId || undefined
          }
        });
      }
      return { data: author };
    });
    protectedScope.delete('/authors/:id', async (request, reply) => {
      try {
        return { data: await fastify.prisma.author.delete({ where: { id: (request.params as { id: string }).id } }) };
      } catch {
        return reply.code(409).send({ message: 'Impossible de supprimer cet auteur (posts liés).' });
      }
    });

    protectedScope.get('/tags', async () => ({ data: await fastify.prisma.tag.findMany({ orderBy: { name: 'asc' } }) }));
    protectedScope.post('/tags', async (request) => {
      const body = tagSchema.parse(request.body);
      return {
        data: await fastify.prisma.tag.create({
          data: { name: body.name, slug: body.slug ? makeSlug(body.slug) : makeSlug(body.name) }
        })
      };
    });
    protectedScope.put('/tags/:id', async (request) => {
      const { id } = request.params as { id: string };
      const body = tagSchema.parse(request.body);
      return {
        data: await fastify.prisma.tag.update({
          where: { id },
          data: { name: body.name, slug: body.slug ? makeSlug(body.slug) : makeSlug(body.name) }
        })
      };
    });
    protectedScope.delete('/tags/:id', async (request, reply) => {
      try {
        return { data: await fastify.prisma.tag.delete({ where: { id: (request.params as { id: string }).id } }) };
      } catch {
        return reply.code(409).send({ message: 'Impossible de supprimer ce tag (posts liés).' });
      }
    });

    protectedScope.get('/media', async () => ({ data: await fastify.prisma.media.findMany({ orderBy: { createdAt: 'desc' } }) }));
    protectedScope.post('/media/upload', async (request, reply) => {
      if (!request.isMultipart()) {
        return reply.code(400).send({ message: 'La requête doit être envoyée en multipart/form-data.' });
      }

      let fileBuffer: Buffer | null = null;
      let filename: string | undefined;
      let declaredMimeType: string | undefined;
      let context: string | undefined;

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (fileBuffer) {
              return reply.code(400).send({ message: 'Un seul fichier image est autorisé par requête.' });
            }

            filename = part.filename;
            declaredMimeType = part.mimetype;
            fileBuffer = await part.toBuffer();
            continue;
          }

          if (part.fieldname === 'context') {
            context = String(part.value ?? '');
          }
        }

        if (!fileBuffer) {
          return reply.code(400).send({ message: 'Fichier image absent. Ajoute un champ fichier multipart.' });
        }

        const uploadedImage = await uploadImageToS3({
          buffer: fileBuffer,
          filename,
          declaredMimeType,
          context
        });

        try {
          const media = await fastify.prisma.media.create({
            data: {
              url: uploadedImage.url,
              altText: null,
              caption: null,
              mimeType: uploadedImage.mimeType,
              source: 's3',
              storageKey: uploadedImage.storageKey,
              bucket: uploadedImage.bucket,
              sizeBytes: uploadedImage.sizeBytes
            }
          });

          return { data: media };
        } catch (error) {
          await deleteImageFromS3(uploadedImage.storageKey, uploadedImage.bucket).catch((deleteError) => {
            request.log.error(deleteError, 'Failed to rollback S3 image after database error');
          });
          request.log.error(error, 'Failed to create media database row after S3 upload');
          return reply.code(500).send({ message: 'Image uploadée sur S3, mais erreur lors de la création du média en base de données.' });
        }
      } catch (error) {
        if (error instanceof ImageUploadError || error instanceof S3StorageError) {
          return reply.code(error.statusCode).send({ message: error.message });
        }

        if (error && typeof error === 'object' && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ message: `Fichier trop lourd. Taille maximale: ${env.AWS_S3_UPLOAD_MAX_BYTES} octets.` });
        }

        request.log.error(error, 'Unexpected media upload error');
        return reply.code(500).send({ message: 'Erreur inattendue pendant l’upload du média.' });
      }
    });
    protectedScope.post('/media', async (request) => {
      const body = mediaSchema.parse(request.body);
      return { data: await fastify.prisma.media.create({ data: body }) };
    });
    protectedScope.put('/media/:id', async (request) => {
      const { id } = request.params as { id: string };
      const body = mediaSchema.parse(request.body);
      return { data: await fastify.prisma.media.update({ where: { id }, data: body }) };
    });
    protectedScope.delete('/media/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const media = await fastify.prisma.media.findUnique({ where: { id } });

      if (!media) {
        return reply.code(404).send({ message: 'Media not found' });
      }

      if (media.source === 's3') {
        const usageCount = await getDirectMediaUsageCount(fastify.prisma, id);
        if (usageCount > 0) {
          return reply.code(409).send({ message: 'Impossible de supprimer ce media S3 (déjà utilisé comme couverture, image Open Graph ou avatar).' });
        }

        if (media.storageKey) {
          try {
            await deleteImageFromS3(media.storageKey, media.bucket);
          } catch (error) {
            if (error instanceof S3StorageError) {
              return reply.code(error.statusCode).send({ message: error.message });
            }
            request.log.error(error, 'Unexpected S3 delete error');
            return reply.code(502).send({ message: 'Erreur suppression AWS S3.' });
          }
        }
      }

      try {
        return { data: await fastify.prisma.media.delete({ where: { id } }) };
      } catch {
        return reply.code(409).send({ message: 'Impossible de supprimer ce media (déjà utilisé).' });
      }
    });

    protectedScope.get('/seo/page/:key', async (request) => {
      const key = (request.params as { key: string }).key;
      const { pageKey, locale } = getPageSeoKey(key, request.query);
      const data = await fastify.prisma.seoMetadata.findUnique({ where: { pageKey }, include: { openGraphImage: true } });
      return { data: data ? { ...data, pageKey: key, localizedPageKey: pageKey, locale } : null };
    });

    protectedScope.put('/seo/page/:key', async (request) => {
      const key = (request.params as { key: string }).key;
      const { pageKey, locale } = getPageSeoKey(key, request.query);
      const body = pageSeoSchema.parse(request.body);
      const data = await fastify.prisma.seoMetadata.upsert({
        where: { pageKey },
        update: { ...body, entityType: SeoEntityType.PAGE },
        create: { ...body, pageKey, entityType: SeoEntityType.PAGE }
      });
      return { data: { ...data, pageKey: key, localizedPageKey: pageKey, locale } };
    });
    protectedScope.delete('/seo/page/:key', async (request, reply) => {
      try {
        const key = (request.params as { key: string }).key;
        const { pageKey } = getPageSeoKey(key, request.query);
        return { data: await fastify.prisma.seoMetadata.delete({ where: { pageKey } }) };
      } catch {
        return reply.code(404).send({ message: 'SEO metadata not found' });
      }
    });
  });
};
