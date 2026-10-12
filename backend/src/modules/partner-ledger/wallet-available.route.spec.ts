import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard, RolesGuard, ROLES_KEY } from '../../common';
import { PartnerLedgerController } from './partner-ledger.module';

/**
 * GET /vendors/wallet/available — the route the Partner app calls (ApiConfig.partnerWalletAvailable).
 * Pins the HTTP contract: path, method, JWT + SERVICE_VENDOR guards, and that it serves the
 * caller's own balance from the verified user id (never a client-supplied one).
 */
describe('GET /vendors/wallet/available route', () => {
  const handler = PartnerLedgerController.prototype.myAvailable;

  it('is mapped to GET vendors/wallet/available', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PartnerLedgerController)).toBe('vendors');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('wallet/available');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it('requires a JWT and the SERVICE_VENDOR role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PartnerLedgerController)).toContain(JwtAuthGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.SERVICE_VENDOR]);
  });

  it("returns the service's { available, canWithdraw } for the verified caller only", async () => {
    const withdrawals = { myAvailable: jest.fn(async () => ({ available: 1234.56, canWithdraw: true })) };
    const ctrl = new PartnerLedgerController({} as any, withdrawals as any, {} as any);
    await expect(ctrl.myAvailable({ sub: 'user-1' } as any)).resolves.toEqual({ available: 1234.56, canWithdraw: true });
    expect(withdrawals.myAvailable).toHaveBeenCalledWith('user-1');
  });
});
