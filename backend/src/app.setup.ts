import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { resolveTrustProxyHops } from './common/trust-proxy';

/**
 * The HTTP pipeline of the API — used by main.ts and by the end-to-end tests, so the tests run
 * exactly what production runs.
 */
export function configureHttpApp(app: INestApplication) {
  // Trust exactly as many proxy hops as are configured (Railway's edge in production), so req.ip
  // is the real client for rate limiting and audit — see common/trust-proxy.ts.
  const proxyHops = resolveTrustProxyHops();
  if (proxyHops > 0) (app.getHttpAdapter().getInstance() as any).set('trust proxy', proxyHops);
  new Logger('Bootstrap').log(`trust proxy hops: ${proxyHops}`);

  // Base64 image uploads can exceed the default 100kb body limit.
  // `verify` keeps the exact raw bytes on req.rawBody: this parser runs before Nest's own
  // (rawBody: true) parser and consumes the stream, so without it req.rawBody was never set and
  // the Razorpay webhook's HMAC check — computed over the raw body — rejected every webhook.
  const express = require('express');
  app.use(express.json({ limit: '15mb', verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ limit: '15mb', extended: true }));

  // Serve uploaded files statically
  app.use('/api/uploads', express.static(require('path').join(process.cwd(), 'uploads')));

  // CORS — production domains only; localhost allowed outside production
  const allowedOrigins = [
    'https://remontindia.com',
    'https://www.remontindia.com',
    'https://remontone.in',
  ];
  if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);
  if (process.env.NODE_ENV !== 'production') allowedOrigins.push('http://localhost:3000', 'http://localhost:3001');
  app.enableCors({ origin: allowedOrigins, credentials: true });

  app.setGlobalPrefix('api/v1');

  // API responses are per-user and must never be cached by browsers or proxies.
  app.use('/api/v1', (req: Request, res: Response, next: NextFunction) => {
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
}
