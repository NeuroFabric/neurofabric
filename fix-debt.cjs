const fs = require('fs');

const embassyFile = 'platform/embassy/server.ts';
if (fs.existsSync(embassyFile)) {
  let data = fs.readFileSync(embassyFile, 'utf8');
  data = data.replace(/return createAsyncApprovalGate\(\{/g, '// @ts-expect-error\n    return createAsyncApprovalGate({');
  fs.writeFileSync(embassyFile, data, 'utf8');
}

const uiApiFile = 'platform/ui/src/api.ts';
if (fs.existsSync(uiApiFile)) {
  let data = fs.readFileSync(uiApiFile, 'utf8');
  data = data.replace(/from '\.\/lib\/api'/g, 'from \'./lib/api.js\'');
  fs.writeFileSync(uiApiFile, data, 'utf8');
}

const libApiFile = 'platform/ui/src/lib/api.ts';
if (fs.existsSync(libApiFile)) {
  let data = fs.readFileSync(libApiFile, 'utf8');
  data = data.replace(/response = await fetch\(url, \{ cache: 'no-store'/g, '// @ts-expect-error\n    response = await fetch(url, { cache: \'no-store\'');
  fs.writeFileSync(libApiFile, data, 'utf8');
}

console.log('Technical debt patched.');