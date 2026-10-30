// Agent Floor server. Zero dependencies.
//
//   POST /events        one event or an array of events (see docs/protocol.md)
//   GET  /stream        Server-Sent Events: a `snapshot`, then `event` + `effects`
//   POST /chat          spawn a chat session, stream reply via SSE
//   GET  /state         current world as JSON
//   POST /reset         clear the floor
//   GET  /*             the built web app (dist/)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, createState, normalizeEvent, sweep, PROTOCOL_VERSION } from '../shared/protocol.js';
import { streamChat, resolveConfig } from './chat.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function startServer({
  port = Number(process.env.AGENT_FLOOR_PORT) || 4317,
  host = process.env.AGENT_FLOOR_HOST || '127.0.0.1',
  staticDir = resolve(here, '../dist'),
  log = console.log,
} = {}) {
  const state = createState();
  const clients = new Set();

  function broadcast(name, data) {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function ingest(raw) {
    const ev = normalizeEvent(raw);
    if (!ev) return false;
    const { effects } = applyEvent(state, ev);
    broadcast('event', { event: ev, effects });
    return true;
  }

  const sweeper = setInterval(() => {
    const removed = sweep(state);
    if (removed.length) broadcast('removed', { agents: removed });
  }, 2000);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20000);

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  }

  function cors(req, res) {
    // Local tool: allow any localhost origin plus the hosted demo to talk to it.
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(staticDir, path);
    if (!file.startsWith(staticDir)) return json(res, 403, { error: 'Forbidden' });
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(staticDir, 'index.html');
    }
    try {
      const body = await readFile(file);
      const cache = file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
      res.end(body);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Agent Floor server is running, but the web app is not built.\nRun `npm run build`, or use `npm run dev` while developing.\n');
    }
  }

  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  // POST /chat { prompt } -> SSE stream: `delta` frames, then `done` or `error`.
  // Runs on the same trust level as POST /events: loopback only, no auth.
  async function handleChat(req, res) {
    let body;
    try { body = await readBody(req); }
    catch (err) { return json(res, 400, { error: err.message }); }

    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return json(res, 400, { error: 'prompt is required' });
    if (prompt.length > 8000) return json(res, 400, { error: 'prompt too long' });

    const agentId = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const model = typeof body?.model === 'string' ? body.model : resolveConfig().model;

    // The agent takes a desk while it works, then walks out.
    ingest({ type: 'join', agent: agentId, name: 'Web Chat', role: 'Agent', team: 'web-chat', source: 'agent-floor', ts: Date.now() });
    ingest({ type: 'status', agent: agentId, status: 'thinking', activity: 'Thinking...', ts: Date.now() });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    req.on('close', () => { closed = true; });

    let text = '';
    try {
      for await (const chunk of streamChat({ prompt, model })) {
        if (closed) return;
        text += chunk;
        res.write(`event: delta\ndata: ${JSON.stringify(chunk)}\n\n`);
      }
      if (!closed) res.write(`event: done\ndata: ${JSON.stringify(text || '(no response)')}\n\n`);
      ingest({ type: 'status', agent: agentId, status: 'done', activity: 'Finished', ts: Date.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`);
      ingest({ type: 'status', agent: agentId, status: 'error', activity: msg.slice(0, 280), ts: Date.now() });
    } finally {
      // The desk stays a little while after the reply, then the agent walks out.
      setTimeout(() => ingest({ type: 'leave', agent: agentId }), 10000);
      res.end();
    }
  }

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: when bound to loopback, only answer loopback hostnames.
    if (loopback && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) {
      return json(res, 403, { error: 'Forbidden host' });
    }
    cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const { pathname } = new URL(req.url, 'http://x');
    // Requiring JSON forces a CORS preflight, so random web pages cannot post
    // "simple" form requests to your floor. curl and the hooks send this header.
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'Send Content-Type: application/json' });
    }

    try {
      if (pathname === '/events' && req.method === 'POST') {
        const body = await readBody(req);
        const list = Array.isArray(body) ? body : [body];
        let accepted = 0;
        for (const raw of list.slice(0, 200)) if (ingest(raw)) accepted++;
        return json(res, accepted ? 202 : 400, { accepted, rejected: list.length - accepted });
      }
      if (pathname === '/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify({ version: PROTOCOL_VERSION, state })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (pathname === '/state' && req.method === 'GET') return json(res, 200, state);
      if (pathname === '/health') return json(res, 200, { ok: true, version: PROTOCOL_VERSION, agents: Object.keys(state.agents).length });
      if (pathname === '/chat' && req.method === 'POST') {
        await handleChat(req, res);
        return;
      }
      if (pathname === '/reset' && req.method === 'POST') {
        ingest({ type: 'reset' });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET') return serveStatic(req, res);
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || 'Bad request' });
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`Agent Floor is live at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      resolvePromise({
        server,
        state,
        ingest,
        close() {
          clearInterval(sweeper);
          clearInterval(heartbeat);
          for (const res of clients) res.end();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? 'Port is already in use. Set AGENT_FLOOR_PORT to pick another.' : err);
    process.exit(1);
  });
}
