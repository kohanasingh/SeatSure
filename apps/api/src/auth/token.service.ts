import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string; // raw value — only ever leaves the server inside the httpOnly cookie
}

// Refresh tokens are 256-bit random values. They are stored sha256-hashed so a DB
// leak does not leak usable tokens; sha256 (not bcrypt) is fine because the input
// is high-entropy, not a human password.
const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private refreshTtlMs(): number {
    return Number(this.config.get('REFRESH_TTL_DAYS') ?? 7) * 24 * 60 * 60 * 1000;
  }

  signAccessToken(user: Pick<User, 'id' | 'email' | 'role'>): string {
    const payload: AccessTokenPayload = { sub: user.id, email: user.email, role: user.role };
    return this.jwt.sign(payload);
  }

  verifyAccessToken(token: string): AccessTokenPayload | null {
    try {
      return this.jwt.verify<AccessTokenPayload>(token);
    } catch {
      return null;
    }
  }

  /** Issues a fresh access + refresh pair, starting a new rotation family. */
  async issuePair(user: Pick<User, 'id' | 'email' | 'role'>): Promise<TokenPair> {
    const refreshToken = await this.createRefreshToken(user.id, randomUUID());
    return { accessToken: this.signAccessToken(user), refreshToken };
  }

  private async createRefreshToken(userId: string, familyId: string): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
      },
    });
    return raw;
  }

  /**
   * Rotation with theft detection (ARCHITECTURE.md §7.3):
   * - unknown token → 401
   * - revoked token presented again → the family was stolen; revoke every token in it
   * - expired token → 401
   * - valid token → revoke it, mint a new one in the same family, new access token
   */
  async rotate(rawToken: string): Promise<TokenPair & { user: User }> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { user: true },
    });
    if (!row) throw new UnauthorizedException('Invalid refresh token');

    if (row.revokedAt) {
      await this.revokeFamily(row.familyId);
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    const refreshToken = await this.createRefreshToken(row.userId, row.familyId);
    return { accessToken: this.signAccessToken(row.user), refreshToken, user: row.user };
  }

  /** Logout: kill the whole family so the cookie can never be replayed. */
  async revokeByRawToken(rawToken: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (row) await this.revokeFamily(row.familyId);
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
