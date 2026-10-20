import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { schemas } from '../src/schemas.js';
import { assertDshVersion } from '../src/dsh.js';

test('all 17 renamed input contracts match the Pi 1d78d8a baseline', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/tool-contracts.json', import.meta.url), 'utf8'));
  const current = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]));
  assert.equal(Object.keys(current).length, 17);
  assert.deepEqual(current, baseline);
});
test('DSH version gate rejects unrelated or malformed runtime series', () => {
  for (const version of ['0.2.1-rc.2', '0.2.1', '0.2.2']) assert.doesNotThrow(() => assertDshVersion(version));
  for (const version of ['1.2.0', '0.1.7-rc.2', '0.2.0', '0.3.0', 'invalid']) assert.throws(() => assertDshVersion(version));
});
