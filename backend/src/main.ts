import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureHttpApp } from './app.setup';

function assertRequiredEnv() {
  const logger = new Logger('Bootstrap');
  const required = ['JWT_SECRET', 'JWT_REFRESH_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error(`FATAL: Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function bootstrap() {
  assertRequiredEnv();

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
    rawBody: true,
    bodyParser: true,
  });

  // Rate limits key on req.ip — make it the real client address behind Railway's edge proxy
  // (see common/trust-proxy.ts for why this is exactly the hop count, never `true`).
  configureHttpApp(app);

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Remont India API')
      .setDescription('Full platform API — Services, Products, Orders, CRM, AMC, AI Agent, Corporate B2B')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('Auth')
      .addTag('Services')
      .addTag('Products')
      .addTag('Orders')
      .addTag('Master Orders')
      .addTag('Vendors')
      .addTag('CRM')
      .addTag('AMC')
      .addTag('AI Agent')
      .addTag('Corporate')
      .addTag('Cities')
      .addTag('Payments')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = Number(process.env.PORT) || 3001;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);

  const logger = new Logger('Bootstrap');
  logger.log(`🚀 Remont India API listening on http://${host}:${port}`);
  logger.log(`📖 Docs at http://${host}:${port}/api/docs`);
}

bootstrap();
