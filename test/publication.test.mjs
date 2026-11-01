import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
const skip = new Set(['node_modules','.git','dist','coverage','circuit2']);
function walk(dir) {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => skip.has(e.name) ? [] : e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}
test('publication contains no private configuration or credential literals', () => {
  for (const file of walk('.')) {
    assert.ok(!/(^|\/)\.env($|\.(?!example$))/.test(file), 'private configuration file');
    if (!/\.(js|mjs|json|md|html|css|yml|yaml|example|txt)$/.test(file)) continue;
    const text = fs.readFileSync(file,'utf8');
    const patterns = [
      new RegExp('gh'+'[pousr]_[A-Za-z0-9]{30,}'),
      new RegExp('github'+'_pat_[A-Za-z0-9_]{30,}'),
      new RegExp('sk'+'-ant-[A-Za-z0-9_-]{25,}'),
      new RegExp('-----BEGIN '+'(?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    ];
    for(const pattern of patterns) assert.ok(!pattern.test(text), 'credential-like material in '+file);
  }
});
test('license and contribution instructions exist', () => {
  for(const file of ['LICENSE','README.md','CONTRIBUTING.md','SECURITY.md']) assert.ok(fs.statSync(file).size>50);
});
