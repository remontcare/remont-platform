import { Module, Injectable, Controller, Get, Put, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload } from '../../common';

const MAX_LINES = 100;
const MAX_QTY = 99;
const MAX_FIELDS = 25;
const MAX_FIELD_LENGTH = 1000;

/**
 * Each line's display fields (name, price, image…) travel as the client sent them, because the
 * website and the app show a cart before checkout. They are never used for charging: checkout
 * prices every line itself from the service/product id.
 */
export function sanitizeCartItems(items: unknown): Prisma.InputJsonValue[] {
  if (!Array.isArray(items)) throw new BadRequestException('items must be a list');
  if (items.length > MAX_LINES) throw new BadRequestException(`A cart can hold at most ${MAX_LINES} items`);
  return items.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Invalid cart item');
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 100) throw new BadRequestException('Invalid cart item');
    const qty = Number(item.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new BadRequestException('Invalid cart quantity');
    const clean: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(item).slice(0, MAX_FIELDS)) {
      if (typeof value === 'string' && value.length <= MAX_FIELD_LENGTH) clean[key] = value;
      else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) clean[key] = value;
    }
    return { ...clean, qty };
  });
}

@Injectable()
export class CartService {
  constructor(private prisma: PrismaService) {}

  async get(userId: string) {
    const cart = await this.prisma.cart.findUnique({ where: { userId } });
    return { items: cart?.items ?? [], updatedAt: cart?.updatedAt ?? null };
  }

  async replace(userId: string, items: unknown) {
    const clean = sanitizeCartItems(items);
    const cart = await this.prisma.cart.upsert({
      where: { userId },
      create: { userId, items: clean },
      update: { items: clean },
    });
    return { items: cart.items, updatedAt: cart.updatedAt };
  }
}

@ApiTags('Cart')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('cart')
export class CartController {
  constructor(private cart: CartService) {}
  @Get() mine(@CurrentUser() u: JwtPayload) { return this.cart.get(u.sub); }
  @Put() replace(@CurrentUser() u: JwtPayload, @Body() b: { items?: unknown }) { return this.cart.replace(u.sub, b?.items); }
}

@Module({ providers: [CartService], controllers: [CartController] })
export class CartModule {}
