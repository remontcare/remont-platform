import {
  Module, Injectable, Controller, Post, Body, Get, UseGuards, BadRequestException, UnauthorizedException, Logger,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsPhoneNumber, IsOptional, IsEnum, IsEmail, Length } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole, Language } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload, generateOtp } from '../../common';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';

// ─── DTOs ───
export class SendOtpDto {
  @IsString() @IsPhoneNumber('IN') phone: string;
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
}
export class VerifyOtpDto {
  @IsString() @IsPhoneNumber('IN') phone: string;
  @IsString() @Length(4, 6) otp: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsEnum(Language) language?: Language;
}
export class RefreshTokenDto {
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

// ─── Service ───
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private whatsapp: WhatsappService,
  ) {}

  async sendOtp(dto: SendOtpDto) {
    const otp = generateOtp();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const user = await this.prisma.user.upsert({
      where: { phone: dto.phone },
      update: { otpCode: otp, otpExpiresAt },
      create: {
        phone: dto.phone,
        name: 'New User',
        role: dto.role || UserRole.CUSTOMER,
        otpCode: otp,
        otpExpiresAt,
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

    return { message: 'OTP sent', phone: dto.phone, expiresInSeconds: 600, isNewUser: !user.isVerified };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user) throw new BadRequestException('Phone not registered');
    if (!user.otpCode || !user.otpExpiresAt) throw new BadRequestException('No OTP requested');
    if (user.otpExpiresAt < new Date()) throw new BadRequestException('OTP expired');
    if (user.otpCode !== dto.otp) throw new UnauthorizedException('Invalid OTP');

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        otpCode: null,
        otpExpiresAt: null,
        lastLoginAt: new Date(),
        ...(dto.name && user.name === 'New User' ? { name: dto.name } : {}),
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.language ? { language: dto.language } : {}),
      },
    });

    const tokens = await this.issueTokens(updated.id, updated.phone, updated.role);
    return {
      user: {
        id: updated.id, name: updated.name, phone: updated.phone, email: updated.email,
        role: updated.role, language: updated.language, walletBalance: updated.walletBalance,
      },
      ...tokens,
    };
  }

  async adminPinLogin(phone: string, pin: string) {
    const adminPin = process.env.ADMIN_PIN;
    if (!adminPin || pin !== adminPin) throw new UnauthorizedException('Invalid admin PIN');

    const user = await this.prisma.user.upsert({
      where: { phone },
      update: { role: UserRole.ADMIN, isVerified: true, lastLoginAt: new Date() },
      create: { phone, name: 'Admin', role: UserRole.ADMIN, isVerified: true, lastLoginAt: new Date() },
    });

    const tokens = await this.issueTokens(user.id, user.phone, user.role);
    return {
      user: { id: user.id, name: user.name, phone: user.phone, role: user.role },
      ...tokens,
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = await this.jwt.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET!,
      });
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) throw new UnauthorizedException();
      return this.issueTokens(user.id, user.phone, user.role);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async issueTokens(userId: string, phone: string, role: UserRole) {
    const payload = { sub: userId, phone, role };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_REFRESH_SECRET!,
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
    });
    return { accessToken, refreshToken, tokenType: 'Bearer' };
  }
}

// ─── Controller ───
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) { return this.auth.sendOtp(dto); }

  @Public() @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) { return this.auth.verifyOtp(dto); }

  @Public() @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) { return this.auth.refresh(dto.refreshToken); }

  @Public() @Post('admin/login')
  adminLogin(@Body() body: { phone: string; pin: string }) {
    return this.auth.adminPinLogin(body.phone, body.pin);
  }

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
