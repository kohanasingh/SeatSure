import { Injectable } from '@nestjs/common';
import * as trpcExpress from '@trpc/server/adapters/express';
import type { Request, RequestHandler } from 'express';
import { TokenService } from '../auth/token.service';
import { appRouter } from './app.router';
import { TrpcContext } from './trpc';

@Injectable()
export class TrpcService {
  constructor(private readonly tokens: TokenService) {}

  /** Same access JWT as the REST guards — read from the Authorization header. */
  createContext(req: Request): TrpcContext {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return { user: null };
    const payload = this.tokens.verifyAccessToken(header.slice('Bearer '.length));
    if (!payload) return { user: null };
    return { user: { id: payload.sub, email: payload.email, role: payload.role } };
  }

  middleware(): RequestHandler {
    return trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext: ({ req }) => this.createContext(req),
    });
  }
}
