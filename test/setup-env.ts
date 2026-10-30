// e2e environment: dedicated test database (created by docker/init-test-db.sql), no scheduler, demo mode on.

process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.TEST_DB_HOST || process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.TEST_DB_PORT || process.env.DB_PORT || '55433';
process.env.DB_USERNAME = process.env.DB_USERNAME || 'efmis';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'efmis_dev_password';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'efmis_test';
process.env.DB_MIGRATIONS_RUN = 'false';
process.env.DB_SEED_ON_START = 'false';
process.env.SCHEDULER_ENABLED = 'false';
process.env.DEMO_MODE = 'true';
process.env.JWT_SECRET = 'efmis-e2e-secret';
process.env.SIGNATURE_SECRET = 'efmis-e2e-signature-secret';
process.env.REDIS_URL = ''; // inline jobs + in-memory hot state: deterministic tests
process.env.TRACCAR_URL = ''; // never poll a real GPS platform from tests
process.env.TRACCAR_WEBHOOK_SECRET = 'e2e-traccar-secret';
// File storage: the same MinIO as development, but separate test buckets (emptied by startTestApi)
process.env.MINIO_ENDPOINT = process.env.TEST_MINIO_ENDPOINT || process.env.MINIO_ENDPOINT || 'localhost';
process.env.MINIO_PORT = process.env.TEST_MINIO_PORT || process.env.MINIO_PORT || '59010';
process.env.MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'efmis-minio';
process.env.MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'efmis_minio_dev_password';
process.env.MINIO_BUCKET_FARMER_DOCUMENTS = 'efmis-test-farmer-documents';
process.env.MINIO_BUCKET_DRIVER_DOCUMENTS = 'efmis-test-driver-documents';
process.env.MINIO_BUCKET_DELIVERY_PROOFS = 'efmis-test-delivery-proofs';
process.env.MINIO_OBJECT_LOCK = 'true';
