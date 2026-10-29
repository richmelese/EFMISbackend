// e2e environment: dedicated test database (created by docker/init-test-db.sql), no scheduler, demo mode on.
import * as os from 'os';
import * as path from 'path';

process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.TEST_DB_HOST || process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.TEST_DB_PORT || process.env.DB_PORT || '55432';
process.env.DB_USERNAME = process.env.DB_USERNAME || 'efmis';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'efmis_dev_password';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'efmis_test';
process.env.DB_MIGRATIONS_RUN = 'false';
process.env.DB_SEED_ON_START = 'false';
process.env.SCHEDULER_ENABLED = 'false';
process.env.DEMO_MODE = 'true';
process.env.JWT_SECRET = 'efmis-e2e-secret';
process.env.SIGNATURE_SECRET = 'efmis-e2e-signature-secret';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'efmis-e2e-uploads');
process.env.REDIS_URL = ''; // inline jobs + in-memory hot state: deterministic tests
process.env.TRACCAR_URL = ''; // never poll a real GPS platform from tests
process.env.TRACCAR_WEBHOOK_SECRET = 'e2e-traccar-secret';
process.env.PROOF_STORAGE_DIR = path.join(os.tmpdir(), 'efmis-e2e-private');
