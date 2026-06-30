import { FastifyReply, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';

export async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    const payload = await request.jwtVerify<{ userId: string; email: string; role: UserRole }>();
    request.adminUser = payload;
  } catch {
    return reply.code(401).send({ message: 'Unauthorized' });
  }
}

export function requireRole(roles: UserRole[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    if (!roles.includes(request.adminUser.role)) {
      return reply.code(403).send({ message: 'Forbidden' });
    }
  };
}
