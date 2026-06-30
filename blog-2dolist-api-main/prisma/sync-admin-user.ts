import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

function getRequiredEnv(name: 'ADMIN_EMAIL' | 'ADMIN_PASSWORD'): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function main() {
  const rawAdminEmail = getRequiredEnv('ADMIN_EMAIL');
  const rawAdminPassword = getRequiredEnv('ADMIN_PASSWORD');

  const adminEmail = normalizeEmail(rawAdminEmail);
  const adminPassword = rawAdminPassword;

  if (adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters long.');
  }

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (existingUser) {
    const updatedUser = await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        passwordHash,
        role: UserRole.ADMIN
      }
    });

    console.log('✅ Admin user updated.');
    console.log(`- email: ${updatedUser.email}`);
    console.log(`- role: ${updatedUser.role}`);
    return;
  }

  const createdUser = await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash,
      role: UserRole.ADMIN,
      displayName: 'Admin'
    }
  });

  console.log('✅ Admin user created.');
  console.log(`- email: ${createdUser.email}`);
  console.log(`- role: ${createdUser.role}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Failed to sync admin user: ${message}`);
    await prisma.$disconnect();
    process.exit(1);
  });
