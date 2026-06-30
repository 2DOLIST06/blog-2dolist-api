import 'fastify';
import { UserRole } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser: {
      userId: string;
      email: string;
      role: UserRole;
    };
  }
}
