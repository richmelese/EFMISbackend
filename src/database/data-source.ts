// DataSource used by the TypeORM CLI (migration:generate / migration:run).
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import configuration from '../config/configuration';
import { buildTypeOrmOptions } from './typeorm.config';

// Minimal .env loader for CLI usage (Nest's ConfigModule handles this at runtime)
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export default new DataSource({ ...buildTypeOrmOptions(configuration().db), migrationsRun: false });
