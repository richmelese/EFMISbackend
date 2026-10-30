const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : v.toLowerCase() === 'true');
const num = (v: string | undefined, d: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export interface AppConfig {
  env: string;
  port: number;
  corsOrigins: string[];
  db: { host: string; port: number; username: string; password: string; database: string; migrationsRun: boolean; seedOnStart: boolean };
  jwt: { secret: string; expiresIn: string };
  /** HMAC key for electronic signatures (separate from the JWT secret; replaced by government PKI later). */
  signatures: { secret: string };
  sessionIdleMinutes: number;
  demoMode: boolean;
  maxUploadBytes: number;
  /** MinIO (S3 API) holding every uploaded file — the only file storage (no local filesystem). */
  storage: {
    endPoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    region: string;
    buckets: { farmerDocuments: string; driverDocuments: string; deliveryProofs: string };
    /** Write-once retention (GOVERNANCE mode); only takes effect on buckets created with it */
    objectLock: boolean;
    /** Attempts to reach MinIO on start before refusing to start (it may still be booting) */
    connectAttempts: number;
  };
  schedulerEnabled: boolean;
  kebeleEscalationDays: number;
  integrations: { faydaUrl: string; faydaSimulateOutage: boolean; nrlaisUrl: string; nsisUrl: string; eabcUrl: string; ussdGatewayKey: string };
  redisUrl: string;
  logistics: {
    traccar: { url: string; user: string; password: string; webhookSecret: string; pollSeconds: number };
    routingProviderUrl: string;
  };
}

export default (): AppConfig => {
  const cfg: AppConfig = {
    env: process.env.NODE_ENV || 'development',
    port: num(process.env.PORT, 4000),
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean),
    db: {
      host: process.env.DB_HOST || 'localhost',
      port: num(process.env.DB_PORT, 55433),
      username: process.env.DB_USERNAME || 'efmis',
      password: process.env.DB_PASSWORD || 'efmis_dev_password',
      database: process.env.DB_NAME || 'efmis',
      migrationsRun: bool(process.env.DB_MIGRATIONS_RUN, true),
      seedOnStart: bool(process.env.DB_SEED_ON_START, true)
    },
    jwt: { secret: process.env.JWT_SECRET || 'change-me-efmis-dev-secret', expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
    signatures: { secret: process.env.SIGNATURE_SECRET || 'change-me-efmis-dev-signature-secret' },
    sessionIdleMinutes: num(process.env.SESSION_IDLE_MINUTES, 15),
    demoMode: bool(process.env.DEMO_MODE, true),
    maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
    schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),
    kebeleEscalationDays: num(process.env.KEBELE_ESCALATION_DAYS, 7),
    integrations: {
      faydaUrl: process.env.FAYDA_API_URL || '',
      faydaSimulateOutage: bool(process.env.FAYDA_SIMULATE_OUTAGE, false),
      nrlaisUrl: process.env.NRLAIS_API_URL || '',
      nsisUrl: process.env.NSIS_API_URL || '',
      eabcUrl: process.env.EABC_API_URL || '',
      ussdGatewayKey: process.env.USSD_GATEWAY_KEY || ''
    },
    storage: {
      endPoint: process.env.MINIO_ENDPOINT || 'localhost',
      port: num(process.env.MINIO_PORT, 59010),
      useSSL: bool(process.env.MINIO_USE_SSL, false),
      accessKey: process.env.MINIO_ACCESS_KEY || 'efmis-minio',
      secretKey: process.env.MINIO_SECRET_KEY || 'efmis_minio_dev_password',
      region: process.env.MINIO_REGION || 'us-east-1',
      buckets: {
        farmerDocuments: process.env.MINIO_BUCKET_FARMER_DOCUMENTS || 'efmis-farmer-documents',
        driverDocuments: process.env.MINIO_BUCKET_DRIVER_DOCUMENTS || 'efmis-driver-documents',
        deliveryProofs: process.env.MINIO_BUCKET_DELIVERY_PROOFS || 'efmis-delivery-proofs'
      },
      objectLock: bool(process.env.MINIO_OBJECT_LOCK, true),
      connectAttempts: num(process.env.MINIO_CONNECT_ATTEMPTS, 10)
    },
    redisUrl: process.env.REDIS_URL || '',
    logistics: {
      traccar: {
        url: process.env.TRACCAR_URL || '',
        user: process.env.TRACCAR_USER || '',
        password: process.env.TRACCAR_PASSWORD || '',
        webhookSecret: process.env.TRACCAR_WEBHOOK_SECRET || '',
        pollSeconds: num(process.env.TRACCAR_POLL_SECONDS, 30)
      },
      routingProviderUrl: process.env.ROUTING_PROVIDER_URL || ''
    }
  };
  if (cfg.env === 'production') {
    if (cfg.jwt.secret === 'change-me-efmis-dev-secret') throw new Error('JWT_SECRET must be set in production');
    if (cfg.jwt.secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
    if (cfg.signatures.secret === 'change-me-efmis-dev-signature-secret') throw new Error('SIGNATURE_SECRET must be set in production');
    if (cfg.signatures.secret.length < 32) throw new Error('SIGNATURE_SECRET must be at least 32 characters in production');
    if (cfg.signatures.secret === cfg.jwt.secret) throw new Error('SIGNATURE_SECRET must differ from JWT_SECRET');
    // Seeding creates demo accounts with a published password — never in production (create the first admin with create-admin).
    if (cfg.db.seedOnStart) throw new Error('DB_SEED_ON_START must be false in production');
    if (cfg.corsOrigins.includes('*')) throw new Error('CORS_ORIGINS must list explicit origins in production');
    if (cfg.demoMode) throw new Error('DEMO_MODE must be false in production');
    if (cfg.storage.secretKey === 'efmis_minio_dev_password') throw new Error('MINIO_SECRET_KEY must be set in production (a dedicated access key, not the dev default)');
    if (!cfg.storage.useSSL) throw new Error('MINIO_USE_SSL must be true in production');
    if (!cfg.logistics.traccar.webhookSecret || cfg.logistics.traccar.webhookSecret === 'change-me-traccar-secret') throw new Error('TRACCAR_WEBHOOK_SECRET must be set in production');
  }
  return cfg;
};
