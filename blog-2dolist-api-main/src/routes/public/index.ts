import { FastifyPluginAsync, FastifyReply } from 'fastify';
import { PostStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { paginationQuerySchema } from '../../validation/common.js';
import {
  buildAuthorCanonical,
  buildAuthorHreflang,
  buildAuthorPath,
  buildCategoryCanonical,
  buildCategoryHreflang,
  buildCategoryPath,
  buildPageCanonical,
  buildPageHreflang,
  buildPagePath,
  buildPostHreflang,
  buildPostPublicCanonical,
  buildPostPublicPath,
  buildPostTranslations,
  buildPostsIndexCanonical,
  buildPostsIndexHreflang,
  buildPostsIndexPath,
  isPostLocale,
  normalizePublicPath
} from '../../lib/seo/urls.js';
import { sendNewsletterSubscriptionEmail } from '../../lib/email/newsletter.js';
import { buildRobotsTxt, buildSitemapXml } from '../../lib/seo/sitemap.js';

const newsletterSubscriptionSchema = z.object({
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.'),
  source: z.string().trim().max(120).optional().or(z.literal(''))
});

const getPublicPostWhere = (locale?: string) => ({
  status: PostStatus.PUBLISHED,
  isActive: true,
  publishedAt: { lte: new Date() },
  ...(locale ? { locale } : {})
});

const getIndexablePublicPostWhere = () => ({
  status: PostStatus.PUBLISHED,
  isActive: true,
  isIndexable: true,
  publishedAt: { lte: new Date() }
});

const postInclude = {
  author: true,
  category: true,
  coverImage: true,
  seoMetadata: true,
  postTags: { include: { tag: true } }
} as const;

const postDetailInclude = {
  author: true,
  category: true,
  coverImage: true,
  seoMetadata: { include: { openGraphImage: true } },
  postTags: { include: { tag: true } }
} as const;

type PublicPost = Prisma.PostGetPayload<{ include: typeof postInclude }>;
type PublicPostDetail = Prisma.PostGetPayload<{ include: typeof postDetailInclude }>;
type PublicPostTranslation = Pick<PublicPost, 'id' | 'locale' | 'slug' | 'path' | 'canonicalUrl' | 'status' | 'isActive' | 'isIndexable' | 'publishedAt'>;

function parseLocaleQuery(query: unknown) {
  const locale = (query as { locale?: unknown }).locale;
  if (locale == null || locale === '') return { locale: 'en' as const };
  if (isPostLocale(locale)) return { locale };
  return { error: 'Locale invalide. Utilise "en" ou "fr".' };
}

function parsePathQuery(query: unknown) {
  const path = (query as { path?: unknown }).path;
  if (typeof path !== 'string') return { error: 'Le paramètre path est obligatoire.' };
  const normalizedPath = normalizePublicPath(path);
  if (!normalizedPath || normalizedPath.length > 2048) return { error: 'Le paramètre path est invalide.' };
  return { path: normalizedPath };
}

function getPathLookupCandidates(path: string) {
  const candidates = new Set([path]);
  if (path !== '/') {
    if (path.endsWith('/')) candidates.add(path.replace(/\/+$/g, ''));
    else candidates.add(`${path}/`);
  }
  return [...candidates];
}

function getLocalizedPageSeo(pageKey: string, locale: string) {
  return {
    path: buildPagePath(locale, pageKey),
    canonicalUrl: buildPageCanonical(locale, pageKey),
    hreflang: buildPageHreflang(pageKey)
  };
}

function serializePublicCategory<T extends { slug: string }>(category: T, locale: string) {
  return {
    ...category,
    path: buildCategoryPath(locale, category.slug),
    canonicalUrl: buildCategoryCanonical(locale, category.slug),
    hreflang: buildCategoryHreflang(category.slug)
  };
}

function serializePublicAuthor<T extends { slug: string }>(author: T, locale: string) {
  return {
    ...author,
    path: buildAuthorPath(locale, author.slug),
    canonicalUrl: buildAuthorCanonical(locale, author.slug),
    hreflang: buildAuthorHreflang(author.slug)
  };
}

const serializePublicPost = (post: PublicPost, translations: PublicPostTranslation[] = []) => {
  const tags = post.postTags.map(({ tag }) => tag);
  const translationLinks = buildPostTranslations(post, translations);

  return {
    ...post,
    category: post.category,
    categorySlug: post.categorySlug ?? post.category?.slug ?? null,
    author: post.author,
    authorSlug: post.author.slug,
    tags,
    tagsJson: post.tagsJson,
    seo: post.seoMetadata,
    seoMetadata: post.seoMetadata,
    path: buildPostPublicPath(post),
    canonicalUrl: buildPostPublicCanonical(post, post.seoMetadata?.canonicalUrl),
    translations: translationLinks,
    hreflang: buildPostHreflang(post, translations)
  };
};

const serializePublicPostDetail = (post: PublicPostDetail, translations: PublicPostTranslation[], relatedPosts: Array<Record<string, unknown>>) => {
  const tags = post.postTags.map(({ tag }) => tag);

  return {
    ...post,
    category: post.category,
    categorySlug: post.categorySlug ?? post.category?.slug ?? null,
    author: post.author,
    authorSlug: post.author.slug,
    tags,
    tagsJson: post.tagsJson,
    seo: post.seoMetadata,
    seoMetadata: post.seoMetadata,
    relatedPosts,
    path: buildPostPublicPath(post),
    canonicalUrl: buildPostPublicCanonical(post, post.seoMetadata?.canonicalUrl),
    translations: buildPostTranslations(post, translations),
    hreflang: buildPostHreflang(post, translations)
  };
};

async function getTranslationsByGroup(fastify: Parameters<FastifyPluginAsync>[0], translationGroupIds: string[]) {
  const uniqueGroupIds = [...new Set(translationGroupIds.filter(Boolean))];
  if (!uniqueGroupIds.length) return new Map<string, PublicPostTranslation[]>();

  const translations = await fastify.prisma.post.findMany({
    where: { translationGroupId: { in: uniqueGroupIds }, ...getIndexablePublicPostWhere() },
    select: {
      id: true,
      locale: true,
      slug: true,
      status: true,
      isActive: true,
      isIndexable: true,
      publishedAt: true,
      path: true,
      canonicalUrl: true,
      translationGroupId: true
    }
  });

  const byGroup = new Map<string, PublicPostTranslation[]>();
  for (const translation of translations) {
    const items = byGroup.get(translation.translationGroupId) ?? [];
    items.push(translation);
    byGroup.set(translation.translationGroupId, items);
  }

  return byGroup;
}

export const publicRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => ({ ok: true }));

  const sendEnglishSitemap = async (_request: unknown, reply: FastifyReply) => {
    const sitemap = await buildSitemapXml(fastify.prisma, 'en');

    return reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Cache-Control', 'public, max-age=0, s-maxage=3600')
      .send(sitemap);
  };

  const sendFrenchSitemap = async (_request: unknown, reply: FastifyReply) => {
    const sitemap = await buildSitemapXml(fastify.prisma, 'fr');

    return reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Cache-Control', 'public, max-age=0, s-maxage=3600')
      .send(sitemap);
  };

  fastify.get('/sitemap.xml', sendEnglishSitemap);
  fastify.get('/sitemap', sendEnglishSitemap);
  fastify.get('/fr/sitemap.xml', sendFrenchSitemap);
  fastify.get('/fr/sitemap', sendFrenchSitemap);

  fastify.get('/robots.txt', async (_request, reply) =>
    reply.header('Content-Type', 'text/plain; charset=utf-8').send(buildRobotsTxt())
  );

  fastify.get('/fr/robots.txt', async (_request, reply) =>
    reply.header('Content-Type', 'text/plain; charset=utf-8').send(buildRobotsTxt())
  );

  fastify.post('/newsletter', async (request, reply) => {
    const subscription = newsletterSubscriptionSchema.parse(request.body);
    const source = subscription.source || undefined;
    const userAgent = request.headers['user-agent'];
    const normalizedUserAgent = Array.isArray(userAgent) ? userAgent.join(' ') : userAgent;

    const existingSubscriber = await fastify.prisma.newsletterSubscriber.findUnique({ where: { email: subscription.email } });
    const subscriber = existingSubscriber
      ? await fastify.prisma.newsletterSubscriber.update({
          where: { email: subscription.email },
          data: { source, userAgent: normalizedUserAgent }
        })
      : await fastify.prisma.newsletterSubscriber.create({
          data: { email: subscription.email, source, userAgent: normalizedUserAgent }
        });

    if (!subscriber.notificationSentAt) {
      await sendNewsletterSubscriptionEmail({
        email: subscriber.email,
        source: subscriber.source ?? undefined
      });
      await fastify.prisma.newsletterSubscriber.update({
        where: { id: subscriber.id },
        data: { notificationSentAt: new Date() }
      });
    }

    return reply.code(existingSubscriber ? 200 : 202).send({
      message: existingSubscriber ? 'Adresse déjà inscrite à la newsletter.' : 'Inscription newsletter reçue.',
      data: { id: subscriber.id, email: subscriber.email, alreadySubscribed: Boolean(existingSubscriber) }
    });
  });

  fastify.get('/posts', async (request, reply) => {
    const parsedLocale = parseLocaleQuery(request.query);
    if ('error' in parsedLocale) return reply.code(400).send({ message: parsedLocale.error });

    const { page, limit } = paginationQuerySchema.parse(request.query);
    const skip = (page - 1) * limit;
    const publicPostWhere = getPublicPostWhere(parsedLocale.locale);

    reply.header('Cache-Control', 'no-store');

    const [total, posts] = await Promise.all([
      fastify.prisma.post.count({ where: publicPostWhere }),
      fastify.prisma.post.findMany({
        where: publicPostWhere,
        skip,
        take: limit,
        orderBy: [{ publishedAt: 'desc' }],
        include: postInclude
      })
    ]);
    const translationsByGroup = await getTranslationsByGroup(fastify, posts.map((post) => post.translationGroupId));

    return {
      data: posts.map((post) => serializePublicPost(post, translationsByGroup.get(post.translationGroupId) ?? [])),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        path: buildPostsIndexPath(parsedLocale.locale),
        canonicalUrl: buildPostsIndexCanonical(parsedLocale.locale),
        hreflang: buildPostsIndexHreflang()
      }
    };
  });

  fastify.get('/posts/by-path', async (request, reply) => {
    const parsedLocale = parseLocaleQuery(request.query);
    if ('error' in parsedLocale) return reply.code(400).send({ message: parsedLocale.error });

    const parsedPath = parsePathQuery(request.query);
    if ('error' in parsedPath) return reply.code(400).send({ message: parsedPath.error });

    const post = await fastify.prisma.post.findFirst({
      where: {
        path: { in: getPathLookupCandidates(parsedPath.path) },
        locale: parsedLocale.locale,
        ...getPublicPostWhere()
      },
      include: postDetailInclude
    });

    if (!post) return reply.code(404).send({ message: 'Post not found' });

    const translationsByGroup = await getTranslationsByGroup(fastify, [post.translationGroupId]);
    const translations = translationsByGroup.get(post.translationGroupId) ?? [];

    const relatedIds = await fastify.prisma.postRelation.findMany({
      where: { sourcePostId: post.id },
      select: { targetPostId: true }
    });

    const relatedPosts = relatedIds.length
      ? await fastify.prisma.post.findMany({
          where: {
            id: { in: relatedIds.map((r) => r.targetPostId) },
            locale: post.locale,
            ...getPublicPostWhere()
          },
          include: { author: true, coverImage: true }
        })
      : [];

    return { data: serializePublicPostDetail(post, translations, relatedPosts) };
  });

  fastify.get('/posts/:slug', async (request, reply) => {
    const parsedLocale = parseLocaleQuery(request.query);
    if ('error' in parsedLocale) return reply.code(400).send({ message: parsedLocale.error });

    const slug = (request.params as { slug: string }).slug;
    const post = await fastify.prisma.post.findFirst({
      where: { slug, locale: parsedLocale.locale, ...getPublicPostWhere() },
      include: postDetailInclude
    });

    if (!post) return reply.code(404).send({ message: 'Post not found' });

    const translationsByGroup = await getTranslationsByGroup(fastify, [post.translationGroupId]);
    const translations = translationsByGroup.get(post.translationGroupId) ?? [];

    const relatedIds = await fastify.prisma.postRelation.findMany({
      where: { sourcePostId: post.id },
      select: { targetPostId: true }
    });

    const relatedPosts = relatedIds.length
      ? await fastify.prisma.post.findMany({
          where: {
            id: { in: relatedIds.map((r) => r.targetPostId) },
            locale: post.locale,
            ...getPublicPostWhere()
          },
          include: { author: true, coverImage: true }
        })
      : [];

    return { data: serializePublicPostDetail(post, translations, relatedPosts) };
  });

  fastify.get('/categories', async (request, reply) => {
    const parsedLocale = parseLocaleQuery(request.query);
    if ('error' in parsedLocale) return reply.code(400).send({ message: parsedLocale.error });

    const categories = await fastify.prisma.category.findMany({
      include: { seoMetadata: true, _count: { select: { posts: true } } },
      orderBy: { name: 'asc' }
    });
    return {
      data: categories.map((category) => serializePublicCategory(category, parsedLocale.locale)),
      meta: getLocalizedPageSeo('categories', parsedLocale.locale)
    };
  });

  fastify.get('/categories/:slug/posts', async (request, reply) => {
    const parsedLocale = parseLocaleQuery(request.query);
    if ('error' in parsedLocale) return reply.code(400).send({ message: parsedLocale.error });

    const slug = (request.params as { slug: string }).slug;
    const category = await fastify.prisma.category.findUnique({ where: { slug } });
    if (!category) return reply.code(404).send({ message: 'Category not found' });

    const posts = await fastify.prisma.post.findMany({
      where: { categoryId: category.id, ...getPublicPostWhere(parsedLocale.locale) },
      include: { author: true, coverImage: true, seoMetadata: true, postTags: { include: { tag: true } }, category: true },
      orderBy: { publishedAt: 'desc' }
    });

    const translationsByGroup = await getTranslationsByGroup(fastify, posts.map((post) => post.translationGroupId));

    return {
      data: {
        category: serializePublicCategory(category, parsedLocale.locale),
        posts: posts.map((post) => serializePublicPost(post, translationsByGroup.get(post.translationGroupId) ?? []))
      }
    };
  });

  fastify.get('/authors', async (request, reply) => {
    const parsedLocale = parseLocaleQuery(request.query);
    if ('error' in parsedLocale) return reply.code(400).send({ message: parsedLocale.error });

    const authors = await fastify.prisma.author.findMany({
      include: { avatarMedia: true, seoMetadata: true, _count: { select: { posts: true } } }
    });
    return {
      data: authors.map((author) => serializePublicAuthor(author, parsedLocale.locale)),
      meta: getLocalizedPageSeo('authors', parsedLocale.locale)
    };
  });

  fastify.get('/authors/:slug/posts', async (request, reply) => {
    const parsedLocale = parseLocaleQuery(request.query);
    if ('error' in parsedLocale) return reply.code(400).send({ message: parsedLocale.error });

    const slug = (request.params as { slug: string }).slug;
    const author = await fastify.prisma.author.findUnique({ where: { slug }, include: { seoMetadata: true, avatarMedia: true } });
    if (!author) return reply.code(404).send({ message: 'Author not found' });

    const posts = await fastify.prisma.post.findMany({
      where: { authorId: author.id, ...getPublicPostWhere(parsedLocale.locale) },
      include: { category: true, coverImage: true, seoMetadata: true, author: true, postTags: { include: { tag: true } } },
      orderBy: { publishedAt: 'desc' }
    });

    const translationsByGroup = await getTranslationsByGroup(fastify, posts.map((post) => post.translationGroupId));

    return {
      data: {
        author: serializePublicAuthor(author, parsedLocale.locale),
        posts: posts.map((post) => serializePublicPost(post, translationsByGroup.get(post.translationGroupId) ?? []))
      }
    };
  });

  fastify.get('/seo/pages/:key', async (request, reply) => {
    const parsedLocale = parseLocaleQuery(request.query);
    if ('error' in parsedLocale) return reply.code(400).send({ message: parsedLocale.error });

    const key = (request.params as { key: string }).key;
    const localizedPageKey = `${parsedLocale.locale}:${key}`;
    const meta =
      (await fastify.prisma.seoMetadata.findUnique({ where: { pageKey: localizedPageKey } })) ??
      (await fastify.prisma.seoMetadata.findUnique({ where: { pageKey: key } }));
    if (!meta) return reply.code(404).send({ message: 'SEO metadata not found' });

    return {
      data: {
        ...meta,
        locale: parsedLocale.locale,
        pageKey: key,
        localizedPageKey,
        path: buildPagePath(parsedLocale.locale, key),
        canonicalUrl: meta.pageKey === localizedPageKey ? meta.canonicalUrl ?? buildPageCanonical(parsedLocale.locale, key) : buildPageCanonical(parsedLocale.locale, key),
        hreflang: buildPageHreflang(key)
      }
    };
  });
};
