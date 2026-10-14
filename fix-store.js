import fs from 'node:fs';

let content = fs.readFileSync('platform/memory/store.ts', 'utf-8');
content = content.replace(
  `      CREATE INDEX IF NOT EXISTS acknowledgements_by_tenant ON acknowledgements (tenant, at);
  version: 3,`,
  `      CREATE INDEX IF NOT EXISTS acknowledgements_by_tenant ON acknowledgements (tenant, at);
    \`,
  },
  {
    version: 3,`
);

fs.writeFileSync('platform/memory/store.ts', content);
console.log('Fixed platform/memory/store.ts migration syntax.');
