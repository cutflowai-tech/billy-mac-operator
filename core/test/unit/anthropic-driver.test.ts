// The Anthropic driver streams responses (long planner turns would otherwise hit a request timeout and be
// billed without a result). Exercised offline against a local SSE endpoint: no provider call, no spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AnthropicDriver } from '../../src/ai/anthropic.ts';

test('the driver streams a turn and returns its text, stop reason and usage', async () => {
  let body: any = null;
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '{"kind":"done",' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '"summary":"ok"}' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } });
      ev('message_stop', {});
      res.end();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const d = new AnthropicDriver('test-key-not-real', { baseURL: `http://127.0.0.1:${(server.address() as any).port}` });
    const out = await d.call('claude-opus-5-5', { role: 'planner', system: 's', messages: [{ role: 'user', content: 'u' }], schema: { type: 'object' } as any,
      max_tokens: 16000, effort: 'medium' } as any);
    assert.equal(body.stream, true, 'the request is streamed');
    assert.equal(out.text, '{"kind":"done","summary":"ok"}');
    assert.equal(out.stop_reason, 'end_turn');
    assert.equal(out.usage.output_tokens, 42);
    assert.equal(out.usage.input_tokens, 120);
  } finally { server.close(); }
});
