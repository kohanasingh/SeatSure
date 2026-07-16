import { Injectable } from '@nestjs/common';
import * as trpcExpress from '@trpc/server/adapters/express';
import type { Request, RequestHandler } from 'express';
import { TokenService } from '../auth/token.service';
import { EventsAdminService } from '../events/events-admin.service';
import { EventsService } from '../events/events.service';
import { AppRouter, createAppRouter } from './app.router';
import { TrpcContext } from './trpc';

@Injectable()
export class TrpcService {
  private readonly router: AppRouter;

  constructor(
    private readonly tokens: TokenService,
    events: EventsService,
    admin: EventsAdminService,
  ) {
    this.router = createAppRouter({ events, admin });
  }

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
      router: this.router,
      createContext: ({ req }) => this.createContext(req),
    });
  }
}
