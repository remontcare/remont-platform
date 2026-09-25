import { Injectable, Logger, Module } from '@nestjs/common';
import { BookingChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';

/**
 * WEBSITE -> REMONT ONE CRM ORDER SYNC
 *
 * When a customer checks out from a cart link the CRM's WhatsApp AI agent sent
 * (see ai-catalog cart-link), the website tells the CRM about the REAL order:
 *
 *   order.created    checkout created the MasterOrder (carries the CRM's crmRef)
 *   order.paid       confirmPayment() verified the online payment
 *   order.confirmed  a pending online order switched to Cash on Delivery
 *
 * The website stays the source of truth: the CRM only mirrors what happened
 * here, it never creates or confirms website orders itself.
 *
 * Only orders that came through a CRM link are sent: order.created needs a
 * crmRef, and such orders are stored with channel WHATSAPP, which is what
 * later events check. Everything else is never sent anywhere.
 *
 * CONFIG: CRM_ORDER_WEBHOOK_URL (the CRM's /integrations/website/orders) and
 * AI_CATALOG_API_KEY (the same shared key the CRM already uses for ai-catalog,
 * sent as x-ai-catalog-key). Unset URL => sync is off.
 *
 * NEVER affects checkout/payment: fire-and-forget, errors are only logged.
 */
export type CrmOrderEvent = 'order.created' | 'order.paid' | 'order.confirmed';

@Injectable()
export class CrmOrderSyncService {
  private readonly logger = new Logger('CrmOrderSync');

  constructor(private prisma: PrismaService) {}

  notify(masterOrderId: string, event: CrmOrderEvent, crmRef?: string): void {
    this.send(masterOrderId, event, crmRef).catch((e) =>
      this.logger.warn(`CRM order sync failed (${event}): ${e?.message || e}`));
  }

  async buildPayload(masterOrderId: string, event: CrmOrderEvent, crmRef?: string) {
    const mo = await this.prisma.masterOrder.findUnique({
      where: { id: masterOrderId },
      include: {
        customer: { select: { name: true, phone: true } },
        childOrders: {
          include: {
            service: { select: { id: true, name: true } },
            items: { select: { productId: true, quantity: true, product: { select: { name: true } } } },
          },
        },
      },
    });
    if (!mo) return null;
    if (!crmRef && mo.channel !== BookingChannel.WHATSAPP) return null;   // not a CRM-linked order
    const items: { type: 'service' | 'product'; id: string; name: string; quantity: number }[] = [];
    for (const c of mo.childOrders as any[]) {
      if (c.service) items.push({ type: 'service', id: c.service.id, name: c.service.name, quantity: 1 });
      for (const it of c.items || []) {
        items.push({ type: 'product', id: it.productId, name: it.product?.name || 'Product', quantity: it.quantity });
      }
    }
    return {
      event,
      crmRef: crmRef ?? null,
      masterOrderNumber: mo.masterOrderNumber,
      status: mo.status,
      paymentStatus: mo.paymentStatus,
      paymentMethod: mo.paymentMethod,
      totalAmount: Number(mo.totalAmount),
      customerName: mo.guestName || mo.customer?.name || null,
      customerPhone: mo.guestPhone || mo.customer?.phone || null,
      city: mo.snapshotCity,
      items,
      occurredAt: new Date().toISOString(),
    };
  }

  private async send(masterOrderId: string, event: CrmOrderEvent, crmRef?: string) {
    const url = (process.env.CRM_ORDER_WEBHOOK_URL || '').trim();
    const key = (process.env.AI_CATALOG_API_KEY || '').trim();
    if (!url || key.length < 32) return;
    const payload = await this.buildPayload(masterOrderId, event, crmRef);
    if (!payload) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ai-catalog-key': key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) this.logger.warn(`CRM order sync ${event} ${payload.masterOrderNumber} -> HTTP ${res.status}`);
  }
}

@Module({
  providers: [CrmOrderSyncService],
  exports: [CrmOrderSyncService],
})
export class CrmSyncModule {}
