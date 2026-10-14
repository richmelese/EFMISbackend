import 'reflect-metadata';
import { Logger, ValidationError, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { Errors } from './common/utils/errors';
import { SeedService } from './database/seeds/seed.service';

const flattenValidation = (e: ValidationError, prefix = ''): Array<{ field: string; message: string }> => {
  const field = prefix ? `${prefix}.${e.property}` : e.property;
  return Object.values(e.constraints || {}).map(message => ({ field, message })).concat((e.children || []).flatMap(c => flattenValidation(c, field)));
};

/** Shared bootstrap configuration (also used by the e2e tests). */
export function configureApp(app: NestExpressApplication) {
  const config = app.get(ConfigService);
  app.setGlobalPrefix('api');
  // Logistics controllers declare version '1' -> /api/v1/...; existing EFMIS controllers stay unversioned (/api/...)
  app.enableVersioning({ type: VersioningType.URI });
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  const origins = config.get<string[]>('corsOrigins') || [];
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || origins.includes('*') || origins.includes(origin)),
    credentials: true,
    exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Page-Size', 'Content-Disposition']
  });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: errors => Errors.unprocessable('Request validation failed', errors.flatMap(e => flattenValidation(e)))
  }));
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false }));
  const config = app.get(ConfigService);

  const swagger = new DocumentBuilder()
    .setTitle('EFMIS API')
    .setDescription('Ethiopian Fertilizer Supply Chain Management Information System — Demand Forecasting & Planning, Quota Allocation and Integration Framework (Requirements Specification, Aug 2026)')
    .setVersion('2.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));

  if (config.get<boolean>('db.seedOnStart')) await app.get(SeedService).seedIfEmpty();

  const port = config.get<number>('port')!;
  await app.listen(port);
  Logger.log(`EFMIS API on http://localhost:${port}/api  |  Swagger: http://localhost:${port}/api/docs  |  demoMode=${config.get('demoMode')}`, 'Bootstrap');
}

if (require.main === module) bootstrap();
