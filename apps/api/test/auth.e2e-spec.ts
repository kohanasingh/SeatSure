import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { REFRESH_COOKIE } from '../src/auth/auth.controller';
import { PrismaService } from '../src/prisma/prisma.service';

// Real Postgres + Redis (docker compose) — this is an end-to-end suite.

const EMAIL_DOMAIN = `e2e-${randomUUID().slice(0, 8)}.test`;
const email = (name: string): string => `${name}@${EMAIL_DOMAIN}`;
const PASSWORD = 'password123';

/** Extracts the raw refresh token value from a response's Set-Cookie header. */
function refreshCookie(res: request.Response): string {
  const cookies = res.get('Set-Cookie') ?? [];
  const cookie = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  expect(cookie, 'expected a refresh cookie to be set').toBeDefined();
  return cookie!.split(';')[0]; // "refresh_token=<value>"
}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    server = app.getHttpServer();
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
    const ids = users.map((u) => u.id);
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('registers a new user and returns a token pair', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ email: email('register'), password: PASSWORD })
      .expect(201);

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user).toMatchObject({ email: email('register'), role: 'USER' });
    expect(res.body.user.passwordHash).toBeUndefined();

    const cookie = refreshCookie(res);
    expect(cookie.split('=')[1]).toBeTruthy();
    const raw = res.get('Set-Cookie')!.find((c) => c.startsWith(REFRESH_COOKIE))!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
  });

  it('logs in with correct credentials', async () => {
    await request(server)
      .post('/auth/register')
      .send({ email: email('login'), password: PASSWORD })
      .expect(201);

    const res = await request(server)
      .post('/auth/login')
      .send({ email: email('login'), password: PASSWORD })
      .expect(200);

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(email('login'));
  });

  it('rejects a wrong password with a generic 401', async () => {
    await request(server)
      .post('/auth/register')
      .send({ email: email('wrongpw'), password: PASSWORD })
      .expect(201);

    const res = await request(server)
      .post('/auth/login')
      .send({ email: email('wrongpw'), password: 'not-the-password' })
      .expect(401);

    expect(res.body.message).toBe('Invalid credentials');
  });

  it('rotates the refresh token on /auth/refresh', async () => {
    const login = await request(server)
      .post('/auth/register')
      .send({ email: email('rotate'), password: PASSWORD })
      .expect(201);
    const cookie1 = refreshCookie(login);

    const refresh1 = await request(server).post('/auth/refresh').set('Cookie', cookie1).expect(200);
    const cookie2 = refreshCookie(refresh1);

    expect(refresh1.body.accessToken).toBeTruthy();
    expect(cookie2).not.toBe(cookie1);

    // the rotated token keeps working
    await request(server).post('/auth/refresh').set('Cookie', cookie2).expect(200);
  });

  it('revokes the whole family when a rotated token is reused', async () => {
    const login = await request(server)
      .post('/auth/register')
      .send({ email: email('theft'), password: PASSWORD })
      .expect(201);
    const cookie1 = refreshCookie(login);

    const refresh1 = await request(server).post('/auth/refresh').set('Cookie', cookie1).expect(200);
    const cookie2 = refreshCookie(refresh1);

    // replaying the already-rotated token = theft signal
    await request(server).post('/auth/refresh').set('Cookie', cookie1).expect(401);

    // the descendant token must now be dead too — the family was revoked
    await request(server).post('/auth/refresh').set('Cookie', cookie2).expect(401);
  });

  it('blocks a USER from an ORGANIZER route (and admits an ORGANIZER)', async () => {
    const user = await request(server)
      .post('/auth/register')
      .send({ email: email('plain-user'), password: PASSWORD })
      .expect(201);

    await request(server)
      .get('/trpc/admin.ping')
      .set('Authorization', `Bearer ${user.body.accessToken}`)
      .expect(403);

    // unauthenticated → 401, not 403
    await request(server).get('/trpc/admin.ping').expect(401);

    await prisma.user.create({
      data: {
        email: email('organizer'),
        passwordHash: await bcrypt.hash(PASSWORD, 12),
        role: 'ORGANIZER',
      },
    });
    const organizer = await request(server)
      .post('/auth/login')
      .send({ email: email('organizer'), password: PASSWORD })
      .expect(200);

    const ping = await request(server)
      .get('/trpc/admin.ping')
      .set('Authorization', `Bearer ${organizer.body.accessToken}`)
      .expect(200);
    expect(ping.body.result.data).toEqual({ pong: true });
  });

  it('exposes the same identity to REST guard (/auth/me) and tRPC (auth.me)', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ email: email('me'), password: PASSWORD })
      .expect(201);
    const token = res.body.accessToken as string;

    const me = await request(server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const trpcMe = await request(server)
      .get('/trpc/auth.me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(me.body.email).toBe(email('me'));
    expect(trpcMe.body.result.data).toEqual(me.body);

    await request(server).get('/auth/me').expect(401);
  });
});
