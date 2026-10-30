// One-off: copy files from the retired local folders into MinIO, then verify the report.
//   npm run storage:import-local -- --upload-dir ./uploads --private-dir ./storage/private [--dry-run]
//   (in the container: node dist/database/storage-import-local.js …)
import 'reflect-metadata';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { StorageService } from '../modules/storage/storage.service';
import { importLocalFiles } from './storage-import';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return path.resolve(process.cwd(), i >= 0 ? process.argv[i + 1] : fallback);
}

async function main() {
  process.env.SCHEDULER_ENABLED = 'false';
  process.env.DB_SEED_ON_START = 'false';
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const report = await importLocalFiles(app.get(DataSource), app.get(StorageService), {
      uploadDir: arg('upload-dir', './uploads'), privateDir: arg('private-dir', './storage/private'), dryRun
    });
    console.log(`\nStorage import${dryRun ? ' (dry run — nothing written)' : ''}`);
    for (const [title, list] of Object.entries(report)) {
      console.log(`  ${title}: ${list.length}`);
      for (const line of list) console.log(`    ${line}`);
    }
    if (report.missingOnDisk.length || report.hashMismatch.length) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
