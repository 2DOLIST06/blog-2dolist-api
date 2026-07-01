import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type RequiredEnvName = 'ADMIN_EMAIL' | 'ADMIN_PASSWORD' | 'DATABASE_URL';

function hasEnv(name: RequiredEnvName): boolean {
  return Boolean(process.env[name]?.trim());
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function maskDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    const databaseName = url.pathname.split('/').filter(Boolean).pop();
    return `${url.protocol}//${url.hostname}${databaseName ? `/${databaseName}` : ''}`;
  } catch {
    return '[defined but not a valid URL]';
  }
}

async function main() {
  const adminEmailDefined = hasEnv('ADMIN_EMAIL');
  const adminPasswordDefined = hasEnv('ADMIN_PASSWORD');
  const databaseUrlDefined = hasEnv('DATABASE_URL');

  console.log('Admin environment check:');
  console.log(`- ADMIN_EMAIL defined: ${adminEmailDefined ? 'yes' : 'no'}`);
  console.log(`- ADMIN_PASSWORD defined: ${adminPasswordDefined ? 'yes' : 'no'}`);
  console.log(`- DATABASE_URL defined: ${databaseUrlDefined ? 'yes' : 'no'}`);

  if (databaseUrlDefined) {
    console.log(`- DATABASE_URL target: ${maskDatabaseUrl(process.env.DATABASE_URL as string)}`);
  }

  if (!adminEmailDefined) {
    throw new Error('ADMIN_EMAIL is required to check the admin user.');
  }

  const normalizedEmail = normalizeEmail(process.env.ADMIN_EMAIL as string);
  console.log(`- normalized admin email: ${normalizedEmail}`);

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  console.log('Admin database check:');
  console.log(`- admin user exists: ${user ? 'yes' : 'no'}`);

  if (!user) {
    console.log('- role: n/a');
    console.log('- passwordHash present: n/a');
    console.log('- createdAt: n/a');
    console.log('- updatedAt: n/a');
    return;
  }

  console.log(`- stored email: ${user.email}`);
  console.log(`- role: ${user.role}`);
  console.log(`- passwordHash present: ${user.passwordHash ? 'yes' : 'no'}`);
  console.log(`- createdAt: ${user.createdAt.toISOString()}`);
  console.log(`- updatedAt: ${user.updatedAt.toISOString()}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Admin check failed: ${message}`);
    await prisma.$disconnect();
    process.exit(1);
  });
