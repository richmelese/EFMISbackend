// First System Administrator for a fresh (migrations-only) production database.
//   npm run create-admin -- --email admin@moa.gov.et --name "System Administrator" [--phone 0911000000]
//   (in the container: node dist/database/create-admin.js --email … --name …)
// Prints a temporary password ONCE; it must be changed at first sign-in. Refuses if the email already exists.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { UsersService } from '../modules/users/users.service';
import { RbacService } from '../modules/users/rbac.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');
  const name = arg('name') || 'System Administrator';
  const phone = arg('phone');
  if (!email) {
    console.error('Usage: create-admin --email <email> [--name "<full name>"] [--phone 09XXXXXXXX]');
    process.exit(2);
  }
  process.env.SCHEDULER_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    await app.get(RbacService).syncCatalog();
    const users = app.get(UsersService);
    if (await users.repo.createQueryBuilder('u').where('LOWER(u.email) = LOWER(:email)', { email }).getExists()) {
      console.error(`A user with email ${email} already exists. Use the admin UI (or reset-password) instead.`);
      process.exitCode = 1;
      return;
    }
    const system = { id: 'SYSTEM', name: 'create-admin CLI', email: null, phone: null, role: 'ADMIN', title: null, regionId: null, zoneId: null, woredaId: null, kebeleId: null, preferredLanguage: 'en' };
    const res = await users.create({ name, email, phone, role: 'ADMIN', title: 'System Administrator' }, system, { source: 'CLI' });
    console.log('\nSystem Administrator created');
    console.log(`  id:                 ${res.user.id}`);
    console.log(`  email:              ${res.user.email}`);
    console.log(`  temporary password: ${res.temporaryPassword}`);
    console.log('\nThis password is shown once. Sign in at /admin and change it immediately.\n');
  } finally {
    await app.close();
  }
}

main().catch(err => {
  console.error(err?.message || err);
  process.exit(1);
});
