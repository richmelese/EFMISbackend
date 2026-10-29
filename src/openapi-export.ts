import 'reflect-metadata';
import { writeFileSync } from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { applyRouting, buildOpenApiDocument } from './main';

/**
 * Writes the API contract to backend/openapi.json without a database or Redis: Nest "preview" mode builds the module
 * graph (controllers, routes, DTO metadata) without instantiating providers. The frontend generates its typed client
 * from this file (`npm run api:generate` in frontend/). Runs after every build (`postbuild`).
 */
async function exportOpenApi() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { preview: true, logger: ['error'], abortOnError: false });
  applyRouting(app);
  const doc = buildOpenApiDocument(app);
  const out = path.resolve(__dirname, '..', 'openapi.json');
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`OpenAPI: ${Object.keys(doc.paths).length} paths → ${path.relative(process.cwd(), out)}`);
  await app.close();
}

exportOpenApi().then(
  () => process.exit(0),
  e => {
    console.error('OpenAPI export failed:', e);
    process.exit(1);
  }
);
