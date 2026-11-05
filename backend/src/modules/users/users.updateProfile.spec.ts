import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateProfileDto, UsersService } from './users.module';

/**
 * PATCH /users/me used to take `@Body() body: any` and hand it to prisma.user.update, so the
 * global whitelist never applied and a user could write role / walletBalance / phone / etc. on
 * their own account. These tests pin the allow-list at both layers: the pipe strips unknown
 * fields, and the service only ever builds name / email / language.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false, transformOptions: { enableImplicitConversion: true } });
const viaPipe = (body: any) => pipe.transform(body, { type: 'body', metatype: UpdateProfileDto });

function makeService() {
  const prisma: any = { user: { update: jest.fn(async (args: any) => ({ id: 'u1', ...args.data })) } };
  return { svc: new UsersService(prisma), prisma };
}

describe('PATCH /users/me field allow-list', () => {
  it('strips privileged fields before they reach Prisma', async () => {
    const { svc, prisma } = makeService();
    const body = await viaPipe({
      name: 'Priya', email: 'p@x.in', language: 'HI',
      role: 'ADMIN', walletBalance: 100000, phone: '+919999999999', isBlocked: false, isVerified: true,
      referralCode: 'X', otpCode: '1', addresses: { create: { fullAddress: 'x' } },
    });
    await svc.updateProfile('u1', body);
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u1' },
      data: { name: 'Priya', email: 'p@x.in', language: 'HI' },
    }));
  });

  it('service ignores unknown keys even if called without the pipe', async () => {
    const { svc, prisma } = makeService();
    await svc.updateProfile('u1', { name: ' A ', role: 'ADMIN', walletBalance: 5 } as any);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ name: 'A' });
  });

  it('rejects invalid values that existing clients never send', async () => {
    await expect(viaPipe({ email: 'not-an-email' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(viaPipe({ language: 'FR' })).rejects.toBeInstanceOf(BadRequestException);
    const { svc } = makeService();
    await expect(svc.updateProfile('u1', { name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps the payloads the website, Partner App and Customer App send today', async () => {
    const { svc, prisma } = makeService();
    for (const body of [{ name: 'Priya' }, { name: 'Priya', email: 'p@x.in' }, { name: 'Priya', email: 'p@x.in', language: 'EN' }]) {
      await svc.updateProfile('u1', await viaPipe(body));
    }
    expect(prisma.user.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
      { name: 'Priya' },
      { name: 'Priya', email: 'p@x.in' },
      { name: 'Priya', email: 'p@x.in', language: 'EN' },
    ]);
  });
});
