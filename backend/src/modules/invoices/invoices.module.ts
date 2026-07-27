import { Module, Injectable, Controller, Get, Post, Param, UseGuards, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload, computeInvoiceBreakdown } from '../../common';

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async generate(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: true, vendor: { include: { user: true } }, service: true,
        items: { include: { product: true } },
        extraWorkItems: { where: { customerApproved: true } },
        invoice: true,
      },
    });
    if (!order) throw new NotFoundException();
    if (order.invoice) return order.invoice;

    const count = await this.prisma.invoice.count();
    const b = computeInvoiceBreakdown({
      orderNumber: order.orderNumber,
      subtotal: Number(order.subtotal),
      totalAmount: Number(order.totalAmount),
      gstAmount: Number(order.gstAmount),
      serviceAmount: Number(order.serviceAmount),
      remontCommission: Number(order.remontCommission),
      approvedExtraWorkAmount: order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0),
    }, count);

    return this.prisma.invoice.create({
      data: { orderId: order.id, ...b },
    });
  }

  async get(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { invoice: true, vendor: true },
    });
    if (!order?.invoice) throw new NotFoundException();
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
    return order.invoice;
  }
}

@ApiTags('Invoices')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private inv: InvoicesService) {}
  @Post('orders/:orderId/generate') gen(@Param('orderId') id: string) { return this.inv.generate(id); }
  @Get('orders/:orderId') get(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) {
    return this.inv.get(u.sub, id);
  }
}

@Module({ controllers: [InvoicesController], providers: [InvoicesService], exports: [InvoicesService] })
export class InvoicesModule {}
