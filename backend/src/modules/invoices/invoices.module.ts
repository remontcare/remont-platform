import { Module, Injectable, Controller, Get, Post, Param, UseGuards, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload } from '../../common';

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

    const customerSubtotal = Number(order.subtotal);
    const customerTotal = Number(order.totalAmount);
    const customerCgst = Math.round((Number(order.gstAmount) / 2) * 100) / 100;
    const customerSgst = customerCgst;

    const vendorLabor = Number(order.serviceAmount) +
      order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0);
    const vendorMaterial = 0;
    const vendorPretax = vendorLabor + vendorMaterial;
    const vendorCgst = Math.round(vendorPretax * 0.09 * 100) / 100;
    const vendorSgst = vendorCgst;
    const vendorTotal = vendorPretax + vendorCgst + vendorSgst;

    const platformCommission = Number(order.remontCommission);
    const bookingFee = 49;
    const remontPretax = platformCommission + bookingFee;
    const remontCgst = Math.round(remontPretax * 0.09 * 100) / 100;
    const remontSgst = remontCgst;
    const remontTotal = remontPretax + remontCgst + remontSgst;

    const count = await this.prisma.invoice.count();
    const invoiceNumber = `INV-${order.orderNumber}-${(count + 1).toString().padStart(4, '0')}`;

    return this.prisma.invoice.create({
      data: {
        invoiceNumber, orderId: order.id,
        customerSubtotal, customerCgst, customerSgst, customerTotal,
        vendorLabor, vendorMaterial, vendorCgst, vendorSgst, vendorTotal,
        platformCommission, bookingFee, remontCgst, remontSgst, remontTotal,
      },
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
