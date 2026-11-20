import { BadRequestException } from '@nestjs/common';
import { CartService, sanitizeCartItems } from './cart.module';

describe('sanitizeCartItems', () => {
  it('keeps display fields and the quantity', () => {
    expect(sanitizeCartItems([{ id: 's1', type: 'service', name: 'AC', price: 399, qty: 2 }]))
      .toEqual([{ id: 's1', type: 'service', name: 'AC', price: 399, qty: 2 }]);
  });

  it('defaults a missing quantity to 1 and drops nested or oversized values', () => {
    expect(sanitizeCartItems([{ id: 's1', nested: { a: 1 }, list: [1], long: 'x'.repeat(1001) }])).toEqual([{ id: 's1', qty: 1 }]);
  });

  it.each([
    ['not a list', 'x'],
    ['no id', [{ qty: 1 }]],
    ['a non-string id', [{ id: 5 }]],
    ['zero quantity', [{ id: 'a', qty: 0 }]],
    ['too large a quantity', [{ id: 'a', qty: 100 }]],
    ['a fractional quantity', [{ id: 'a', qty: 1.5 }]],
    ['too many lines', Array.from({ length: 101 }, (_, i) => ({ id: `a${i}` }))],
  ])('rejects %s', (_name, items) => {
    expect(() => sanitizeCartItems(items)).toThrow(BadRequestException);
  });
});

describe('CartService', () => {
  const make = () => {
    const prisma: any = { cart: { findUnique: jest.fn(), upsert: jest.fn(async (a: any) => ({ items: a.create.items, updatedAt: new Date(0) })) } };
    return { svc: new CartService(prisma), prisma };
  };

  it('an account with no saved cart gets an empty one', async () => {
    const { svc, prisma } = make();
    prisma.cart.findUnique.mockResolvedValue(null);
    expect(await svc.get('u1')).toEqual({ items: [], updatedAt: null });
  });

  it('writes only to the signed-in user\'s cart', async () => {
    const { svc, prisma } = make();
    await svc.replace('u1', [{ id: 'p1', userId: 'someone-else', qty: 3 }]);
    expect(prisma.cart.upsert.mock.calls[0][0].where).toEqual({ userId: 'u1' });
    expect(prisma.cart.upsert.mock.calls[0][0].create.userId).toBe('u1');
  });
});
