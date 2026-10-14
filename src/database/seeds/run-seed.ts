// npm run seed        -> seed if the database is empty
// npm run seed:reset  -> drop schema, re-run migrations, seed
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { SeedService } from './seed.service';

async function main() {
  process.env.SCHEDULER_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const seeder = app.get(SeedService);
  if (process.argv.includes('--reset')) {
    await seeder.reset();
    await seeder.seed();
  } else if (!(await seeder.seedIfEmpty())) {
    console.log('Database already contains data. Use "npm run seed:reset" to rebuild it.');
  }
  await app.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
