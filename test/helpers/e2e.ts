// Shared e2e helpers: boot the API against the efmis_test database and sign in as a role or as a specific seeded
// user (useful for "wrong unit → 403" scope tests: e.g. the Adama vs Lume woreda officers).
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'net';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { DEMO_PASSWORD, SeedService } from '../../src/database/seeds/seed.service';
import { StorageService } from '../../src/modules/storage/storage.service';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Seeded users by administrative unit (see SeedService). */
export const SEED_USERS = {
  ADMIN: 'admin@efmis.gov.et',
  MOA: 'admin.moa@efmis.gov.et',
  OROMIA_REGION: 'boa.oromia@efmis.gov.et',
  AMHARA_REGION: 'boa.amhara@efmis.gov.et',
  EAST_SHEWA_ZONE: 'zone.eshewa@efmis.gov.et',
  ADAMA_WOREDA: 'woreda.adama@efmis.gov.et',
  LUME_WOREDA: 'woreda.lume@efmis.gov.et',
  WONJI_KEBELE: 'kebele.wonji@efmis.gov.et',
  KOKA_KEBELE: 'kebele.koka@efmis.gov.et',
  DA_WONJI: 'da.bekele@efmis.gov.et',
  DA_KOKA: 'da.derese@efmis.gov.et'
} as const;

export interface TestApi {
  app: NestExpressApplication;
  http: any;
  /** Base URL when started with `listen: true` (needed for socket.io clients). */
  baseUrl?: string;
  call: (method: Method, url: string, token?: string) => request.Test;
  /** Demo persona login by role (DEMO_MODE). */
  loginAs: (role: string) => Promise<string>;
  /** Password login as a specific seeded user (choose the administrative unit). */
  loginAsUser: (email: string) => Promise<string>;
  close: () => Promise<void>;
}

/** Boots the app, resets and seeds efmis_test and empties the efmis-test-* MinIO buckets (unless `seed: false`). */
export async function startTestApi({ listen = false, seed = true }: { listen?: boolean; seed?: boolean } = {}): Promise<TestApi> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(mod.createNestApplication<NestExpressApplication>());
  if (listen) await app.listen(0);
  else await app.init();
  const http = app.getHttpServer();
  const baseUrl = listen ? `http://127.0.0.1:${(http.address() as AddressInfo).port}` : undefined;
  if (seed) {
    const seeder = app.get(SeedService);
    await app.get(StorageService).emptyTestBuckets(); // test buckets only (efmis-test-*), never dev data
    await seeder.reset();
    await seeder.seed();
  }
  const call = (method: Method, url: string, token?: string) => {
    const r = request(http)[method](`/api${url}`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const tokenFrom = (r: request.Response, who: string) => {
    if (r.status !== 200) throw new Error(`Login as ${who} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token as string;
  };
  return {
    app,
    http,
    baseUrl,
    call,
    loginAs: async role => tokenFrom(await call('post', '/auth/demo-login').send({ role }), role),
    loginAsUser: async email => tokenFrom(await call('post', '/auth/login').send({ email, password: DEMO_PASSWORD }), email),
    close: () => app.close()
  };
}
