import * as path from 'path';
import { DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';
import { AppConfig } from '../config/configuration';

/** Single source of TypeORM options for the Nest app, the CLI data-source and the tests. */
export function buildTypeOrmOptions(db: AppConfig['db']): DataSourceOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.database,
    namingStrategy: new SnakeNamingStrategy(),
    entities: [path.join(__dirname, '..', 'modules', '**', 'entities', '*.{ts,js}')],
    migrations: [path.join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'typeorm_migrations',
    migrationsRun: db.migrationsRun,
    synchronize: false,
    logging: ['error', 'warn']
  };
}
