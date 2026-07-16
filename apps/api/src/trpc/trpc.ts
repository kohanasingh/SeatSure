import { TRPCError, initTRPC } from '@trpc/server';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/types';

export interface RequestMeta {
  idempotencyKey?: string;
  ipAddress?: string;
  userAgent?: string;
  acceptLanguage?: string;
  screenHint?: string;
}

export interface TrpcContext {
  user: AuthenticatedUser | null;
  meta: RequestMeta;
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { user: ctx.user } });
});

export const roleProcedure = (...roles: Role[]) =>
  protectedProcedure.use(({ ctx, next }) => {
    if (!roles.includes(ctx.user.role)) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
