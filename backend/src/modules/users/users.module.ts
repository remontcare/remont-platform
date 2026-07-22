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
    // Validate coords if provided; reject 0,0 placeholder
    const lat = parseFloat(data.latitude) || 0;
    const lng = parseFloat(data.longitude) || 0;
    const validCoords = lat !== 0 && lng !== 0 && lat >= 6.5 && lat <= 37.6 && lng >= 68.1 && lng <= 97.4;
    return this.prisma.address.create({
      data: {
        userId,
        label:          data.label          || 'Home',
        fullAddress:    data.fullAddress     || '',
        area:           data.area            || '',
        landmark:       data.landmark        || '',
        city:           data.city            || '',
        state:          data.state           || '',
        country:        data.country         || 'India',
        pincode:        data.pincode         || '',
        latitude:       validCoords ? lat : 0,
        longitude:      validCoords ? lng : 0,
        accuracy:       data.accuracy        || null,
        locationSource: data.locationSource  || 'MANUAL',
        capturedAt:     data.capturedAt ? new Date(data.capturedAt) : null,
        isDefault:      data.isDefault       || false,
      },
    });
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

  async updateAddress(userId: string, addressId: string, data: any) {
    const existing = await this.prisma.address.findFirst({ where: { id: addressId, userId } });
    if (!existing) throw new NotFoundException('Address not found');
    if (data.isDefault) {
      await this.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    }
    const lat = data.latitude !== undefined ? parseFloat(data.latitude) : undefined;
    const lng = data.longitude !== undefined ? parseFloat(data.longitude) : undefined;
    const validCoords = lat !== undefined && lng !== undefined
      && lat !== 0 && lng !== 0 && lat >= 6.5 && lat <= 37.6 && lng >= 68.1 && lng <= 97.4;
    return this.prisma.address.update({
      where: { id: addressId },
      data: {
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.fullAddress !== undefined ? { fullAddress: data.fullAddress } : {}),
        ...(data.area !== undefined ? { area: data.area } : {}),
        ...(data.landmark !== undefined ? { landmark: data.landmark } : {}),
        ...(data.city !== undefined ? { city: data.city } : {}),
        ...(data.state !== undefined ? { state: data.state } : {}),
        ...(data.country !== undefined ? { country: data.country } : {}),
        ...(data.pincode !== undefined ? { pincode: data.pincode } : {}),
        ...(validCoords ? { latitude: lat, longitude: lng } : {}),
        ...(data.accuracy !== undefined ? { accuracy: data.accuracy } : {}),
        ...(data.locationSource !== undefined ? { locationSource: data.locationSource } : {}),
        ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
      },
    });
  }

  async setDefaultAddress(userId: string, addressId: string) {
    const existing = await this.prisma.address.findFirst({ where: { id: addressId, userId } });
    if (!existing) throw new NotFoundException('Address not found');
    await this.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    return this.prisma.address.update({ where: { id: addressId }, data: { isDefault: true } });
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
  @Patch('me/addresses/:id') updateAddr(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() body: any) { return this.users.updateAddress(u.sub, id, body); }
  @Patch('me/addresses/:id/default') setDefaultAddr(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.users.setDefaultAddress(u.sub, id); }
  @Delete('me/addresses/:id') delAddr(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.users.deleteAddress(u.sub, id); }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
