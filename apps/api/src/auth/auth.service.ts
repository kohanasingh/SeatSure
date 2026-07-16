import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import { LoginInput, RegisterInput } from '@seatsure/shared';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { TokenPair, TokenService } from './token.service';

export type PublicUser = Pick<User, 'id' | 'email' | 'role'>;

export interface AuthResult extends TokenPair {
  user: PublicUser;
}

const toPublic = (user: User): PublicUser => ({ id: user.id, email: user.email, role: user.role });

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async register(input: RegisterInput): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({ data: { email: input.email, passwordHash } });
    const pair = await this.tokens.issuePair(user);
    return { ...pair, user: toPublic(user) };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    // Generic message either way — no user enumeration via login.
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const pair = await this.tokens.issuePair(user);
    return { ...pair, user: toPublic(user) };
  }

  async refresh(rawRefreshToken: string): Promise<AuthResult> {
    const { accessToken, refreshToken, user } = await this.tokens.rotate(rawRefreshToken);
    return { accessToken, refreshToken, user: toPublic(user) };
  }

  async logout(rawRefreshToken: string): Promise<void> {
    await this.tokens.revokeByRawToken(rawRefreshToken);
  }
}
