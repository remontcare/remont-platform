import * as jwt from 'jsonwebtoken';
import { UnauthorizedException } from '@nestjs/common';
import { OptionalJwtAuthGuard } from '../../common';
import { JwtStrategy } from '../auth/auth.module';
import { MasterOrdersService, PublicMasterOrderController } from './master-orders.module';

/**
 * WALLET OWNERSHIP (critical fix) — the public cart checkout used to resolve the customer from a
 * submitted phone number and spend that account's wallet. A wallet may now only be spent by its
 * verified owner: identity comes from a verified login (OTP-issued JWT, re-checked by JwtStrategy),
 * never from the request body. Real guard + real passport JWT strategy below; no network, no money.
 */
const SECRET = 'wallet-ownership-test-secret';
process.env.JWT_SECRET = SECRET;

const USERS: Record<string, any> = {
  'cust-a': { id: 'cust-a', phone: '+919800000001', role: 'CUSTOMER', isVerified: true, name: 'A', isBlocked: false },
  'cust-b': { id: 'cust-b', phone: '+919800000002', role: 'CUSTOMER', isVerified: true, name: 'B', isBlocked: false },
  'unverified': { id: 'unverified', phone: '+919800000003', role: 'CUSTOMER', isVerified: false, name: 'U', isBlocked: false },
};
// Registers the 'jwt' passport strategy exactly as the app does.
new JwtStrategy({ user: { findUnique: jest.fn(async ({ where }: any) => USERS[where.id] || null) } } as any);

const token = (sub: string, secret = SECRET) => jwt.sign({ sub, phone: USERS[sub]?.phone, role: 'CUSTOMER' }, secret, { expiresIn: '5m' });
function ctx(headers: Record<string, string> = {}) {
  const req: any = { headers };
  return { req, context: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }), getHandler: () => null, getClass: () => null } as any };
}
const body = (over: any = {}) => ({
  name: 'Victim Name', phone: USERS['cust-b'].phone, fullAddress: 'Somewhere', city: 'Bhopal',
  items: [{ type: 'SERVICE', serviceId: 'svc-1', quantity: 1 }], paymentMethod: 'COD', ...over,
});

describe('OptionalJwtAuthGuard — verified login only (real passport JWT strategy)', () => {
  const guard = new OptionalJwtAuthGuard();
  it('no Authorization header → anonymous (passes, no user)', async () => {
    const { req, context } = ctx();
    await expect(Promise.resolve().then(() => guard.canActivate(context))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });
  it('valid token of a verified (OTP-confirmed) customer → request.user is that customer', async () => {
    const { req, context } = ctx({ authorization: `Bearer ${token('cust-a')}` });
    await expect(Promise.resolve().then(() => guard.canActivate(context))).resolves.toBe(true);
    expect(req.user.sub).toBe('cust-a');
  });
  it('forged token (wrong signing secret) → 401', async () => {
    const { context } = ctx({ authorization: `Bearer ${token('cust-b', 'attacker-secret')}` });
    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('malformed token → 401', async () => {
    const { context } = ctx({ authorization: 'Bearer not-a-jwt' });
    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('token of an account whose OTP verification never completed (isVerified=false) → 401', async () => {
    const { context } = ctx({ authorization: `Bearer ${token('unverified')}` });
    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('expired token → 401', async () => {
    const expired = jwt.sign({ sub: 'cust-a', role: 'CUSTOMER', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
    const { context } = ctx({ authorization: `Bearer ${expired}` });
    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('PublicMasterOrderController.checkout — wallet owner comes from the login, never the body', () => {
  const svc = () => ({ checkout: jest.fn(async () => ({ ok: true })) });
  it('1. unauthenticated request with walletAmount is rejected before the service is called', async () => {
    const s = svc();
    await expect(Promise.resolve().then(() => new PublicMasterOrderController(s as any).checkout(undefined, body({ walletAmount: 500 }) as any))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(s.checkout).not.toHaveBeenCalled();
  });
  it('2/3. customer A sending B\'s phone/name: the order and wallet owner are A (from the token), the body cannot substitute B', async () => {
    const s = svc();
    await new PublicMasterOrderController(s as any).checkout({ sub: 'cust-a' } as any, body({ walletAmount: 500 }) as any);
    const [, opts] = s.checkout.mock.calls[0] as any;
    expect(opts.customerId).toBe('cust-a');
    expect(opts.guestPhone).toBeUndefined();
    expect(opts.guestName).toBeUndefined();
  });
  it('a guest checkout without wallet is unchanged (guest identity, no customerId)', async () => {
    const s = svc();
    await new PublicMasterOrderController(s as any).checkout(undefined, body() as any);
    const [, opts] = s.checkout.mock.calls[0] as any;
    expect(opts.customerId).toBeUndefined();
    expect(opts.guestPhone).toBe(USERS['cust-b'].phone);
  });
});

describe('MasterOrdersService.checkout — defence in depth', () => {
  it('a guest (no verified customerId) can never use a wallet: rejected before any account lookup or row creation', async () => {
    const prisma: any = { user: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() }, masterOrder: { findUnique: jest.fn() }, $transaction: jest.fn() };
    const svc = new MasterOrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(svc.checkout({ items: [{ type: 'SERVICE', serviceId: 'svc-1' }], walletAmount: 100 } as any,
      { guestName: 'X', guestPhone: USERS['cust-b'].phone, paymentMethod: 'COD' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
