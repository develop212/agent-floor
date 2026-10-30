import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer } from '../server/index.mjs';

/** A stand-in for the Anthropic-compatible proxy: replays fixed text deltas. */
function stubProxy({ chunks = ['Hel', 'lo'], status = 200 } = {}) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'boom' } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      for (const text of chunks) {
        const payload = JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        res.write(`event: content_block_delta\ndata: ${payload}\n\n`);
      }
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

/** Read an SSE response into [{ event, data }] frames. */
async function readFrames(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      let event = '', data = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trimStart();
      }
      if (event) frames.push({ event, data });
    }
  }
  return frames;
}

test('POST /chat streams deltas, then done, and puts an agent on the floor', async () => {
  const proxy = await stubProxy();
  const saved = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
  process.env.ANTHROPIC_BASE_URL = proxy.url;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const floor = await startServer({ port: 0, log: () => {} });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'say hi' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const frames = await readFrames(res);
    const deltas = frames.filter((f) => f.event === 'delta').map((f) => JSON.parse(f.data));
    assert.deepEqual(deltas, ['Hel', 'lo'], 'each proxy delta becomes one delta frame');
    const done = frames.find((f) => f.event === 'done');
    assert.ok(done, 'stream ends with a done frame');
    assert.equal(JSON.parse(done.data), 'Hello', 'done carries the whole reply');

    const agent = Object.values(floor.state.agents).find((a) => a.name === 'Web Chat');
    assert.ok(agent, 'a Web Chat agent took a desk');
    assert.equal(agent.status, 'done');
  } finally {
    await floor.close();
    proxy.server.close();
    Object.assign(process.env, saved);
  }
});

test('POST /chat rejects an empty prompt and reports proxy failures', async () => {
  const proxy = await stubProxy({ status: 500 });
  const saved = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
  process.env.ANTHROPIC_BASE_URL = proxy.url;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const floor = await startServer({ port: 0, log: () => {} });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    const empty = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'prompt is required');

    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'boom?' }),
    });
    const frames = await readFrames(res);
    const err = frames.find((f) => f.event === 'error');
    assert.ok(err, 'a failing proxy sends an error frame');
    assert.match(JSON.parse(err.data), /HTTP 500/);
    const agent = Object.values(floor.state.agents).find((a) => a.name === 'Web Chat');
    assert.equal(agent.status, 'error', 'the desk shows the failure');
  } finally {
    await floor.close();
    proxy.server.close();
    Object.assign(process.env, saved);
  }
});
