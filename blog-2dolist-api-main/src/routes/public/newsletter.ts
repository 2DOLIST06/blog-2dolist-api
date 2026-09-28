import { randomBytes } from 'node:crypto';
import { FastifyPluginAsync } from 'fastify';
import { NewsletterFrequency, NewsletterStatus, Prisma } from '@prisma/client';
import { sendNewsletterWelcomeEmail } from '../../lib/email/newsletter.js';
import { preferencesQuerySchema, subscribeSchema, unsubscribeSchema, updatePreferencesSchema } from '../../validation/newsletter.js';

const subscriberInclude = {
  preferences: true,
  interests: { orderBy: { interest: 'asc' as const } },
  regions: { include: { region: true }, orderBy: { region: { name: 'asc' as const } } }
};

const frequencyMap = {
  immediate: NewsletterFrequency.IMMEDIATE,
  weekly: NewsletterFrequency.WEEKLY,
  monthly: NewsletterFrequency.MONTHLY
} as const;

function serializeSubscriber(subscriber: Prisma.NewsletterSubscriberGetPayload<{ include: typeof subscriberInclude }>) {
  const preferences = subscriber.preferences;
  if (!preferences) throw new Error('Newsletter preferences are missing.');
  return {
    status: subscriber.status.toLowerCase(),
    language: subscriber.language,
    preferences: {
      new_articles: preferences.newArticles,
      practical_guides: preferences.practicalGuides,
      destination_guides: preferences.destinationGuides,
      activity_guides: preferences.activityGuides,
      news_and_updates: preferences.newsAndUpdates
    },
    frequency: preferences.frequency.toLowerCase(),
    interests: subscriber.interests.map(({ interest }) => interest),
    regions: subscriber.regions.map(({ region }) => ({ id: region.id, name: region.name, slug: region.slug })),
    unsubscribed: subscriber.status === NewsletterStatus.UNSUBSCRIBED
  };
}

async function resolveRegions(transaction: Prisma.TransactionClient, identifiers: string[]) {
  if (!identifiers.length) return [];
  const regions = await transaction.region.findMany({ where: { OR: [{ id: { in: identifiers } }, { slug: { in: identifiers } }] } });
  if (regions.length !== identifiers.length) {
    const matched = new Set(regions.flatMap((region) => [region.id, region.slug]));
    if (identifiers.some((identifier) => !matched.has(identifier))) return null;
  }
  return regions;
}

export const newsletterRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/subscribe', async (request, reply) => {
    const body = subscribeSchema.parse(request.body);
    const now = new Date();
    const result = await fastify.prisma.$transaction(async (transaction) => {
      const region = body.region ? await resolveRegions(transaction, [body.region]) : [];
      if (region === null) return { invalidRegion: true as const };

      let subscriber = await transaction.newsletterSubscriber.findUnique({ where: { email: body.email } });
      const shouldWelcome = !subscriber || subscriber.status === NewsletterStatus.UNSUBSCRIBED;
      if (!subscriber) {
        subscriber = await transaction.newsletterSubscriber.create({ data: {
          email: body.email, status: NewsletterStatus.ACTIVE, language: body.language, source: body.source,
          confirmedAt: now, consentAt: now, consentTextVersion: body.consentTextVersion,
          consentSource: body.consentSource ?? body.source, preferencesToken: randomBytes(32).toString('hex'),
          preferences: { create: {} }
        } });
      } else if (subscriber.status === NewsletterStatus.UNSUBSCRIBED) {
        subscriber = await transaction.newsletterSubscriber.update({ where: { id: subscriber.id }, data: {
          status: NewsletterStatus.ACTIVE, language: body.language, source: body.source, confirmedAt: now,
          unsubscribedAt: null, consentAt: now, consentTextVersion: body.consentTextVersion,
          consentSource: body.consentSource ?? body.source
        } });
      }
      await transaction.newsletterPreference.upsert({ where: { subscriberId: subscriber.id }, update: {}, create: { subscriberId: subscriber.id } });
      if (body.interest) await transaction.newsletterSubscriberInterest.createMany({ data: [{ subscriberId: subscriber.id, interest: body.interest }], skipDuplicates: true });
      if (region?.[0]) await transaction.newsletterSubscriberRegion.createMany({ data: [{ subscriberId: subscriber.id, regionId: region[0].id }], skipDuplicates: true });
      return { invalidRegion: false as const, subscriber, shouldWelcome };
    });
    if (result.invalidRegion) return reply.code(400).send({ message: 'Région invalide.' });

    if (result.shouldWelcome) {
      try {
        await sendNewsletterWelcomeEmail({ email: result.subscriber.email, language: result.subscriber.language, preferencesToken: result.subscriber.preferencesToken });
      } catch {
        request.log.error({ event: 'newsletter_welcome_email_failed' }, 'Échec de l’envoi Brevo; inscription conservée.');
      }
    }
    return reply.code(202).send({ message: 'Si cette adresse est éligible, son inscription a été prise en compte.' });
  });

  fastify.get('/preferences', async (request, reply) => {
    const { token } = preferencesQuerySchema.parse(request.query);
    const subscriber = await fastify.prisma.newsletterSubscriber.findUnique({ where: { preferencesToken: token }, include: subscriberInclude });
    if (!subscriber) return reply.code(404).send({ message: 'Lien de préférences invalide.' });
    reply.header('Cache-Control', 'no-store');
    return { data: serializeSubscriber(subscriber) };
  });

  fastify.put('/preferences', async (request, reply) => {
    const { token } = preferencesQuerySchema.parse(request.query);
    const body = updatePreferencesSchema.parse(request.body);
    const subscriber = await fastify.prisma.$transaction(async (transaction) => {
      const existing = await transaction.newsletterSubscriber.findUnique({ where: { preferencesToken: token }, select: { id: true } });
      if (!existing) return null;
      const regions = body.regions ? await resolveRegions(transaction, body.regions) : undefined;
      if (regions === null) return 'invalid-region' as const;
      const preferenceData = {
        ...(body.new_articles !== undefined && { newArticles: body.new_articles }),
        ...(body.practical_guides !== undefined && { practicalGuides: body.practical_guides }),
        ...(body.destination_guides !== undefined && { destinationGuides: body.destination_guides }),
        ...(body.activity_guides !== undefined && { activityGuides: body.activity_guides }),
        ...(body.news_and_updates !== undefined && { newsAndUpdates: body.news_and_updates }),
        ...(body.frequency && { frequency: frequencyMap[body.frequency] })
      };
      await transaction.newsletterPreference.upsert({ where: { subscriberId: existing.id }, update: preferenceData, create: { subscriberId: existing.id, ...preferenceData } });
      if (body.interests) {
        await transaction.newsletterSubscriberInterest.deleteMany({ where: { subscriberId: existing.id, interest: { notIn: body.interests } } });
        await transaction.newsletterSubscriberInterest.createMany({ data: body.interests.map((interest) => ({ subscriberId: existing.id, interest })), skipDuplicates: true });
      }
      if (regions) {
        const regionIds = regions.map(({ id }) => id);
        await transaction.newsletterSubscriberRegion.deleteMany({ where: { subscriberId: existing.id, regionId: { notIn: regionIds } } });
        await transaction.newsletterSubscriberRegion.createMany({ data: regionIds.map((regionId) => ({ subscriberId: existing.id, regionId })), skipDuplicates: true });
      }
      return transaction.newsletterSubscriber.findUniqueOrThrow({ where: { id: existing.id }, include: subscriberInclude });
    });
    if (!subscriber) return reply.code(404).send({ message: 'Lien de préférences invalide.' });
    if (subscriber === 'invalid-region') return reply.code(400).send({ message: 'Région invalide.' });
    return { data: serializeSubscriber(subscriber) };
  });

  fastify.post('/unsubscribe', async (request, reply) => {
    const { token } = unsubscribeSchema.parse(request.body);
    const subscriber = await fastify.prisma.newsletterSubscriber.findUnique({ where: { preferencesToken: token }, select: { id: true } });
    if (!subscriber) return reply.code(404).send({ message: 'Lien de désinscription invalide.' });
    await fastify.prisma.newsletterSubscriber.update({ where: { id: subscriber.id }, data: { status: NewsletterStatus.UNSUBSCRIBED, unsubscribedAt: new Date() } });
    return { data: { status: 'unsubscribed', unsubscribed: true } };
  });

  fastify.get('/regions', async () => ({
    data: await fastify.prisma.region.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } })
  }));
};
