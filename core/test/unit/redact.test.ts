import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../src/util/redact.ts';

test('redaction preserves observation element tokens and noncredential key suffixes', () => {
  const receipt = { observation_ref: 'observation-id', elements: [{ element_token: 'snapshot:7', label: 'Save' }],
    cancellation_generation: 2, max_tokens: 16000, total_token: 12, client_secretary: 'visible' };
  assert.deepEqual(JSON.parse(redact(JSON.stringify(receipt))), receipt);
});

test('redaction still removes complete credential keys in JSON and assignment text', () => {
  for (const key of ['token', 'password', 'authorization', 'api_key', 'api-key', 'access_token', 'refresh-token', 'client_secret']) {
    for (const format of [`"${key}":"credential-value"`, `${key}=credential-value`, `${key.toUpperCase()}: 'credential-value'`]) {
      const output = redact(format);
      assert.ok(!output.includes('credential-value'), `${format} -> ${output}`);
      assert.ok(output.includes('[REDACTED]'));
    }
  }
});
