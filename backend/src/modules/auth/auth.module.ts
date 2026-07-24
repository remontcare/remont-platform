import {
  Module, Injectable, Controller, Post, Get, Body, Req, UseGuards, BadRequestException, UnauthorizedException, Logger,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, IsPhoneNumber, IsOptional, IsEnum, IsEmail, Length } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { createHash, randomUUID } from 'crypto';
import { Request } from 'express';
import { UserRole, Language, Platform, AuthAction } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload, generateOtp } from '../../common';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';

// Roles a caller may request for a brand-new account through the public OTP
// endpoint. ADMIN/SUPER_ADMIN/DELIVERY_PARTNER/CORPORATE_USER/CRM_AGENT can
// only be granted by a SUPER_ADMIN via PATCH admin/users/:id/role — closes
// the self-provisioning hole this endpoint previously had.
const SELF_SIGNUP_ROLES: UserRole[] = [UserRole.CUSTOMER, UserRole.SERVICE_VENDOR, UserRole.PRODUCT_VENDOR];
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

// ─── DTOs ───
export class SendOtpDto {
  @IsString() @IsPhoneNumber('IN') phone: string;
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @IsOptional() @IsEnum(Platform) platform?: Platform;
}
export class VerifyOtpDto {
  @IsString() @IsPhoneNumber('IN') phone: string;
  @IsString() @Length(4, 6) otp: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsEnum(Language) language?: Language;
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @IsOptional() @IsEnum(Platform) platform?: Platform;
}
export class RefreshTokenDto {
  @IsString() refreshToken: string;
}
export class LogoutDto {
  @IsString() refreshToken: string;
}

// ─── JWT Strategy ───
@Injectable()
class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET!,
    });
  }
  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, phone: true, role: true, isVerified: true, name: true, isBlocked: true },
    });
    if (!user || !user.isVerified) throw new UnauthorizedException();
    if (user.isBlocked) throw new UnauthorizedException('Account suspended');
    return { sub: user.id, phone: user.phone, role: user.role, name: user.name };
  }
}

function clientIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip;
}

// ─── Service ───
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private whatsapp: WhatsappService,
  ) {}

  async sendOtp(dto: SendOtpDto, req: Request) {
    const existing = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (existing?.otpLastSentAt) {
      const elapsedSeconds = (Date.now() - existing.otpLastSentAt.getTime()) / 1000;
      if (elapsedSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
        throw new BadRequestException(
          `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsedSeconds)}s before requesting another OTP`,
        );
      }
    }

    const otp = generateOtp();
    const now = new Date();
    const otpExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    const requestedRole = dto.role && SELF_SIGNUP_ROLES.includes(dto.role) ? dto.role : undefined;

    const user = await this.prisma.user.upsert({
      where: { phone: dto.phone },
      update: { otpCode: otp, otpExpiresAt, otpAttempts: 0, otpLastSentAt: now },
      create: {
        phone: dto.phone,
        name: 'New User',
        role: requestedRole || UserRole.CUSTOMER,
        otpCode: otp,
        otpExpiresAt,
        otpAttempts: 0,
        otpLastSentAt: now,
        isVerified: false,
      },
    });

    try {
      await this.whatsapp.sendOtp(dto.phone, otp);
    } catch (e) {
      this.logger.warn(`OTP send failed for ${dto.phone}: ${e.message}`);
    }

    if (process.env.NODE_ENV !== 'production') {
      this.logger.debug(`🔑 OTP for ${dto.phone}: ${otp}`);
    }

    await this.prisma.loginHistory.create({
      data: {
        userId: user.id, phone: dto.phone, role: user.role,
        platform: dto.platform || Platform.WEB, action: AuthAction.SEND_OTP,
        success: true, ip: clientIp(req), userAgent: req.headers['user-agent'],
      },
    });

    return { message: 'OTP sent', phone: dto.phone, expiresInSeconds: 600, isNewUser: !user.isVerified };
  }

  async verifyOtp(dto: VerifyOtpDto, req: Request) {
    const platform = dto.platform || Platform.WEB;
    const logFailure = async (userId: string | undefined, role: UserRole | undefined, reason: string) => {
      await this.prisma.loginHistory.create({
        data: {
          userId, phone: dto.phone, role, platform, action: AuthAction.VERIFY_OTP,
          success: false, failureReason: reason, ip: clientIp(req), userAgent: req.headers['user-agent'],
        },
      });
    };

    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user) {
      await logFailure(undefined, undefined, 'Phone not registered');
      throw new BadRequestException('Phone not registered');
    }
    if (!user.otpCode || !user.otpExpiresAt) {
      await logFailure(user.id, user.role, 'No OTP requested');
      throw new BadRequestException('No OTP requested');
    }

    // Real WhatsApp/SMS delivery isn't configured yet (no MSG91_AUTH_KEY on Railway), so a
    // fixed test code can be enabled via DEV_OTP_OVERRIDE env var. Still requires a prior
    // send-otp call (the check above), and still runs the real role-elevation logic below —
    // unlike the old frontend-only "1234 always works" shortcuts this replaces, which skipped
    // the backend (and role elevation) entirely. Unset the env var to disable.
    const devOtp = process.env.DEV_OTP_OVERRIDE;
    const isDevOtp = !!devOtp && dto.otp === devOtp;
    if (!isDevOtp) {
      if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
        await logFailure(user.id, user.role, 'Too many attempts');
        throw new UnauthorizedException('Too many attempts — request a new OTP');
      }
      if (user.otpExpiresAt < new Date()) {
        await logFailure(user.id, user.role, 'OTP expired');
        throw new BadRequestException('OTP expired');
      }
      if (user.otpCode !== dto.otp) {
        const attempts = user.otpAttempts + 1;
        await this.prisma.user.update({
          where: { id: user.id },
          data: { otpAttempts: attempts, ...(attempts >= OTP_MAX_ATTEMPTS ? { otpCode: null } : {}) },
        });
        await logFailure(user.id, user.role, 'Invalid OTP');
        throw new UnauthorizedException('Invalid OTP');
      }
    }

    // Allow a plain CUSTOMER to be elevated to a vendor role on their own verified OTP request
    // (e.g. someone who browsed as a customer earlier and is now completing vendor registration).
    // Never touches ADMIN/SUPER_ADMIN accounts or downgrades an existing vendor.
    const ELEVATABLE_ROLES: UserRole[] = [UserRole.SERVICE_VENDOR, UserRole.PRODUCT_VENDOR];
    const roleUpgrade = dto.role && user.role === UserRole.CUSTOMER && ELEVATABLE_ROLES.includes(dto.role)
      ? dto.role : undefined;

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        otpCode: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        lastLoginAt: new Date(),
        ...(dto.name && user.name === 'New User' ? { name: dto.name } : {}),
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.language ? { language: dto.language } : {}),
        ...(roleUpgrade ? { role: roleUpgrade } : {}),
      },
    });

    const tokens = await this.issueTokens(updated.id, updated.phone, updated.role, platform, req);

    await this.prisma.loginHistory.create({
      data: {
        userId: updated.id, phone: updated.phone, role: updated.role, platform,
        action: AuthAction.VERIFY_OTP, success: true, ip: clientIp(req), userAgent: req.headers['user-agent'],
      },
    });

    return {
      user: {
        id: updated.id, name: updated.name, phone: updated.phone, email: updated.email,
        role: updated.role, language: updated.language, walletBalance: updated.walletBalance,
      },
      ...tokens,
    };
  }

  async refresh(refreshToken: string, req: Request) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(refreshToken, { secret: process.env.JWT_REFRESH_SECRET! });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.prisma.refreshSession.findUnique({ where: { tokenId: payload.jti } });
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.tokenHash !== tokenHash) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();

    await this.prisma.refreshSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(user.id, user.phone, user.role, session.platform, req);
  }

  async logout(refreshToken: string) {
    let jti: string | undefined;
    try {
      const payload = await this.jwt.verifyAsync(refreshToken, { secret: process.env.JWT_REFRESH_SECRET! });
      jti = payload.jti;
    } catch {
      // Still allow logging out an already-expired/invalid token — best-effort decode.
      const decoded: any = this.jwt.decode(refreshToken);
      jti = decoded?.jti;
    }
    if (!jti) return { message: 'Logged out' };

    await this.prisma.refreshSession.updateMany({
      where: { tokenId: jti, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { message: 'Logged out' };
  }

  async logoutAll(userId: string) {
    const result = await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { message: 'Logged out from all devices', sessionsRevoked: result.count };
  }

  async listSessions(userId: string) {
    return this.prisma.refreshSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, platform: true, deviceInfo: true, ip: true, userAgent: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async issueTokens(userId: string, phone: string, role: UserRole, platform: Platform, req: Request) {
    const jti = randomUUID();
    const payload = { sub: userId, phone, role };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = await this.jwt.signAsync({ ...payload, jti }, {
      secret: process.env.JWT_REFRESH_SECRET!,
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
    });

    const decoded: any = this.jwt.decode(refreshToken);
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    await this.prisma.refreshSession.create({
      data: {
        userId, tokenId: jti, tokenHash, platform,
        ip: clientIp(req), userAgent: req.headers['user-agent'],
        expiresAt: new Date(decoded.exp * 1000),
      },
    });

    return { accessToken, refreshToken, tokenType: 'Bearer' };
  }
}

// ─── Controller ───
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto, @Req() req: Request) { return this.auth.sendOtp(dto, req); }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) { return this.auth.verifyOtp(dto, req); }

  @Public() @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) { return this.auth.refresh(dto.refreshToken, req); }

  @Public() @Post('logout')
  logout(@Body() dto: LogoutDto) { return this.auth.logout(dto.refreshToken); }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post('logout-all')
  logoutAll(@CurrentUser() user: JwtPayload) { return this.auth.logoutAll(user.sub); }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Get('sessions')
  sessions(@CurrentUser() user: JwtPayload) { return this.auth.listSessions(user.sub); }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Get('me')
  me(@CurrentUser() user: JwtPayload) { return user; }
}

// ─── Module ───
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET!,
        signOptions: { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
      }),
    }),
    WhatsappModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
