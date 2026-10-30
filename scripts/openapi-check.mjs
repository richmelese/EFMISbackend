// Reports API operations whose success response has no documented body schema (so the frontend's generated client
// types them as unknown). Report-only: exits 0. Fix by adding @ApiOkResponse({ type: Dto }) / @ApiCreatedResponse.
//   npm run openapi:check            summary by Swagger tag
//   npm run openapi:check -- --list  every undocumented operation

import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const byTag = new Map();
let total = 0;
let undocumented = 0;
const list = [];

for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    total++;
    const ok = Object.entries(op.responses || {}).filter(([code]) => code.startsWith('2'));
    const typed = ok.some(([, r]) => r.content && Object.values(r.content).some(c => c.schema));
    const noBody = ok.some(([code]) => code === '204');
    if (typed || noBody) continue;
    undocumented++;
    const tag = op.tags?.[0] || '(untagged)';
    byTag.set(tag, (byTag.get(tag) || 0) + 1);
    list.push(`${method.toUpperCase().padEnd(6)} ${path}`);
  }
}

console.log(`OpenAPI: ${total - undocumented}/${total} operations document their success response (${undocumented} undocumented)`);
for (const [tag, n] of [...byTag].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${tag}`);
if (process.argv.includes('--list')) console.log('\n' + list.join('\n'));
// Ratchet: --max=N fails when more responses are undocumented than the baseline (new routes must be documented).
const max = process.argv.find(a => a.startsWith('--max='));
if (max && undocumented > Number(max.slice(6))) {
  console.error(`Undocumented responses went up: ${undocumented} > ${max.slice(6)}. Add @ApiOkResponse({ type }) to new routes.`);
  process.exit(1);
}
