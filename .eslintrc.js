// Backend lint: keeps files small (BACKEND_ARCHITECTURE_PLAN §2 modularity). Module boundaries (platform never imports
// domain) are checked by src/architecture.spec.ts.
const { LEGACY_LARGE_FILES } = require('./eslint-legacy-large-files');

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true, es2022: true, jest: true },
  ignorePatterns: ['dist/', 'node_modules/', 'openapi.json', '*.js'],
  rules: {
    // 300 lines of code per file (blank lines and comments not counted): split a service or controller before it grows
    'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }]
  },
  overrides: [
    // Files already above the limit before the rule existed. They are split when their roadmap phase rebuilds them;
    // remove a file from the list once it is under 300 lines. Never add new files here.
    { files: LEGACY_LARGE_FILES, rules: { 'max-lines': 'off' } },
    // Seed data, migrations and e2e scenarios are long by nature
    { files: ['src/database/**', 'test/**'], rules: { 'max-lines': 'off' } }
  ]
};
