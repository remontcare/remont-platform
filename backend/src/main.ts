import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  app.enableCors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'https://remontindia.com',
      'https://www.remontindia.com',
      'https://remontone.in',
    ],
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

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
