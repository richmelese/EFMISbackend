// Unit tests: src/**/*.spec.ts (no database). End-to-end tests use test/jest-e2e.json (`npm run test:e2e`).
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node'
};
