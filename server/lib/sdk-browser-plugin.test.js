import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkBrowserPlugin } from '../../live/sdk-browser-plugin.js';

test('built SDK strips direct commitment, private-note and raw error logging', () => {
  const root = path.dirname(fileURLToPath(import.meta.resolve('privacycash/utils')));
  const plugin = sdkBrowserPlugin();
  for (const relative of ['withdraw.js', 'deposit.js', 'depositSPL.js', 'models/utxo.js']) {
    const filename = path.join(root, relative);
    const original = fs.readFileSync(filename, 'utf8');
    assert.ok(original.includes('console.log('));
    const changed = plugin.transform(original, filename).code;
    assert.equal(changed.includes('console.log('), false, relative);
  }
});
