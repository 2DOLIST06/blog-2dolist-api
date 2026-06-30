import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, PostStatus, UserRole, SeoEntityType } from '@prisma/client';

const prisma = new PrismaClient();

async function getOrCreateMediaByUrl(url: string, altText: string) {
  const existing = await prisma.media.findFirst({ where: { url } });
  if (existing) return existing;
  return prisma.media.create({ data: { url, altText } });
}

async function seedDemoContent() {
  const media = await getOrCreateMediaByUrl('https://placehold.co/1200x630/png', 'Demo article image');

  const author = await prisma.author.upsert({
    where: { slug: 'demo-author' },
    update: { avatarMediaId: media.id },
    create: { name: 'Demo Author', slug: 'demo-author', bio: 'Optional demo author.', avatarMediaId: media.id }
  });

  const category = await prisma.category.upsert({
    where: { slug: 'demo-category' },
    update: {},
    create: { name: 'Demo category', slug: 'demo-category', description: 'Optional demo category.' }
  });

  const tag = await prisma.tag.upsert({
    where: { slug: 'demo-tag' },
    update: {},
    create: { name: 'Demo tag', slug: 'demo-tag' }
  });

  const post = await prisma.post.upsert({
    where: { slug: 'demo-article' },
    update: {
      title: 'Demo article',
      excerpt: 'Optional demo article used to verify the blog API.',
      contentMarkdown: '# Demo article\n\nOptional neutral content for local development.',
      status: PostStatus.PUBLISHED,
      isActive: true,
      isIndexable: true,
      robots: 'index,follow',
      categorySlug: category.slug,
      publishedAt: new Date(),
      readingTimeMinutes: 3,
      authorId: author.id,
      categoryId: category.id,
      coverImageId: media.id
    },
    create: {
      title: 'Demo article',
      slug: 'demo-article',
      excerpt: 'Optional demo article used to verify the blog API.',
      contentMarkdown: '# Demo article\n\nOptional neutral content for local development.',
      status: PostStatus.PUBLISHED,
      isActive: true,
      isIndexable: true,
      robots: 'index,follow',
      categorySlug: category.slug,
      publishedAt: new Date(),
      readingTimeMinutes: 3,
      authorId: author.id,
      categoryId: category.id,
      coverImageId: media.id
    }
  });

  await prisma.postTag.upsert({
    where: { postId_tagId: { postId: post.id, tagId: tag.id } },
    update: {},
    create: { postId: post.id, tagId: tag.id }
  });

  await prisma.seoMetadata.upsert({
    where: { postId: post.id },
    update: {
      entityType: SeoEntityType.POST,
      title: 'Demo article',
      description: 'Optional demo article used to verify the blog API.',
      noIndex: false,
      openGraphImageId: media.id
    },
    create: {
      entityType: SeoEntityType.POST,
      postId: post.id,
      title: 'Demo article',
      description: 'Optional demo article used to verify the blog API.',
      noIndex: false,
      openGraphImageId: media.id
    }
  });

  await prisma.seoMetadata.upsert({
    where: { categoryId: category.id },
    update: {
      entityType: SeoEntityType.CATEGORY,
      title: 'Demo category',
      description: 'Optional demo category.'
    },
    create: {
      entityType: SeoEntityType.CATEGORY,
      categoryId: category.id,
      title: 'Demo category',
      description: 'Optional demo category.'
    }
  });
}

async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@example.com').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'ChangeMeStrongPassword123!';
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { passwordHash, role: UserRole.ADMIN, displayName: 'Admin' },
    create: { email: adminEmail, passwordHash, role: UserRole.ADMIN, displayName: 'Admin' }
  });

  if (process.env.SEED_DEMO_CONTENT === 'true') {
    await seedDemoContent();
    console.log('✅ Seed terminé: admin + contenu de démo générique prêts.');
    return;
  }

  console.log('✅ Seed terminé: admin prêt. Définis SEED_DEMO_CONTENT=true pour ajouter un contenu de démo générique.');
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
