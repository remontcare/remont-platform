import {
  Module, Injectable, Controller, Get, Patch, Post, Delete, Body, Param, UseGuards,
  NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload } from '../../common';

// ─── USERS ─────────────────────────────────────────────────────────────

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { addresses: true, membership: { include: { plan: true } }, city: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { otpCode, otpExpiresAt, ...safe } = user;
    return safe;
  }

  async updateProfile(userId: string, data: any) {
    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, phone: true, email: true, role: true, language: true, avatarUrl: true, cityId: true },
    });
  }

  async addAddress(userId: string, data: any) {
    if (data.isDefault) {
      await this.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    }
    return this.prisma.address.create({ data: { ...data, userId } });
  }

  async listAddresses(userId: string) {
    return this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async deleteAddress(userId: string, addressId: string) {
    await this.prisma.address.deleteMany({ where: { id: addressId, userId } });
    return { deleted: true };
  }
}

@ApiTags('Users')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}
  @Get('me') me(@CurrentUser() u: JwtPayload) { return this.users.getProfile(u.sub); }
  @Patch('me') update(@CurrentUser() u: JwtPayload, @Body() body: any) { return this.users.updateProfile(u.sub, body); }
  @Get('me/addresses') addresses(@CurrentUser() u: JwtPayload) { return this.users.listAddresses(u.sub); }
  @Post('me/addresses') addAddr(@CurrentUser() u: JwtPayload, @Body() body: any) { return this.users.addAddress(u.sub, body); }
  @Delete('me/addresses/:id') delAddr(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.users.deleteAddress(u.sub, id); }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
