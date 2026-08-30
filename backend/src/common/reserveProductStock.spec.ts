import { BadRequestException } from '@nestjs/common';
import { reserveProductStock } from './index';

/**
 * Phase 8 (H-07) — Product.stock previously existed but was never read or decremented
 * anywhere in checkout. reserveProductStock() is the one shared atomic fix used by all 3
 * checkout paths (MasterOrdersService.checkout(), OrdersService.create(),
 * GuestBookingService.publicProductCheckout()) — see their own targeted tests for the
 * wiring; this covers the helper's own contract.
 */
function makeTx(stockByProduct: Record<string, number>) {
  const stock = { ...stockByProduct };
  const tx = {
    product: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const available = stock[where.id] ?? 0;
        if (available < where.stock.gte) return { count: 0 };
        stock[where.id] = available - data.stock.decrement;
        return { count: 1 };
      }),
      findUnique: jest.fn(async ({ where }: any) => ({ name: `Product ${where.id}`, stock: stock[where.id] ?? 0 })),
    },
  };
  return { tx, stock };
}

describe('reserveProductStock (H-07)', () => {
  it('decrements stock atomically when enough is available', async () => {
    const { tx, stock } = makeTx({ p1: 10 });
    await reserveProductStock(tx, [{ productId: 'p1', quantity: 3 }]);
    expect(stock.p1).toBe(7);
  });

  it('rejects the whole checkout with a clear error when stock is insufficient — never goes negative', async () => {
    const { tx, stock } = makeTx({ p1: 2 });
    await expect(reserveProductStock(tx, [{ productId: 'p1', quantity: 5 }])).rejects.toBeInstanceOf(BadRequestException);
    expect(stock.p1).toBe(2); // untouched — the conditional updateMany matched nothing
  });

  it('aggregates the SAME product appearing on multiple lines before checking/decrementing once', async () => {
    const { tx, stock } = makeTx({ p1: 5 });
    await reserveProductStock(tx, [{ productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 2 }]);
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1); // one call for the combined qty=4, not two separate calls
    expect(stock.p1).toBe(1);
  });

  it('rolls back nothing itself on a later item\'s failure — caller\'s transaction handles that (this just throws)', async () => {
    const { tx } = makeTx({ p1: 10, p2: 1 });
    await expect(reserveProductStock(tx, [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 5 }])).rejects.toBeInstanceOf(BadRequestException);
    // p1 was already decremented before p2 failed — this is exactly why every call site wraps
    // this inside its own $transaction(), so the whole checkout (including p1's decrement)
    // rolls back together, not just this function's own two calls.
  });

  it('a concurrent request that already exhausted stock (updateMany matches 0 rows) is rejected, not silently allowed through', async () => {
    const tx = {
      product: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // simulates another concurrent checkout winning the race first
        findUnique: jest.fn().mockResolvedValue({ name: 'Widget', stock: 0 }),
      },
    };
    await expect(reserveProductStock(tx, [{ productId: 'p1', quantity: 1 }])).rejects.toThrow(/Insufficient stock/);
  });

  it('is a no-op for an empty item list', async () => {
    const { tx } = makeTx({});
    await expect(reserveProductStock(tx, [])).resolves.toBeUndefined();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
});
