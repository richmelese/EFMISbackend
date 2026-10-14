// Production entrypoint step: apply pending migrations before the API starts (see Dockerfile).
import 'reflect-metadata';
import dataSource from './data-source';

async function main() {
  await dataSource.initialize();
  const applied = await dataSource.runMigrations({ transaction: 'each' });
  console.log(`[EFMIS] ${applied.length} migration(s) applied`);
  await dataSource.destroy();
}

main().catch(err => {
  console.error('[EFMIS] Migration failed', err);
  process.exit(1);
});
