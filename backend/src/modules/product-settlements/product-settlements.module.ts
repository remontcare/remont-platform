import { Module } from '@nestjs/common';
import { ProductSettlementsService } from './product-settlements.service';
import { ProductSettlementsController } from './product-settlements.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProductLedgerModule } from '../product-ledger/product-ledger.module';

@Module({
  imports: [PrismaModule, ProductLedgerModule],
  controllers: [ProductSettlementsController],
  providers: [ProductSettlementsService],
  exports: [ProductSettlementsService],
})
export class ProductSettlementsModule {}
