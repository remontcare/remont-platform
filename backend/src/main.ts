import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

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

  // Increase body limit to 15MB for base64 document uploads in partner registration
  const express = require('express');
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ limit: '15mb', extended: true }));

  // Task 3 uploads (backend/src/modules/uploads) now go to Cloudinary, not this local
  // folder. Kept mounted only so any pre-Cloudinary /api/uploads/* URLs still saved in the
  // DB keep resolving until they're naturally replaced; nothing new is written here.
  app.use('/api/uploads', express.static(require('path').join(process.cwd(), 'uploads')));

  const allowedOrigins = [
    'https://remontindia.com',
    'https://www.remontindia.com',
    'https://remontone.in',
  ];
  if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);
  if (process.env.NODE_ENV !== 'production') allowedOrigins.push('http://localhost:3000', 'http://localhost:3001');

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

  // Every /api/v1/* response is dynamic, admin-editable data (prices, categories,
  // services, site settings/logo, etc). Express auto-generates an ETag for JSON
  // responses but sends no Cache-Control, so without this, HTTP caches fall back to
  // heuristic freshness — mobile/standalone-PWA HTTP caches are far more aggressive
  // about reusing a stale GET response this way than a desktop browser tab, which is
  // why admin edits used to lag on the installed mobile PWA while desktop looked fine.
  app.use('/api/v1', (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

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
