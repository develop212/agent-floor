// Stream a chat reply from the Anthropic-compatible proxy.
//
// Reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from env at call time, so a
// server started without them can still serve chat once they are configured.
// Returns an async generator of text deltas.

const DEFAULT_MAX_TOKENS = 4096;

export function resolveConfig() {
  const raw = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  // Some gateways already carry /v1 in the base; do not ask for /v1/messages twice.
  const messagesUrl = /\/v1$/.test(raw) ? `${raw}/messages` : `${raw}/v1/messages`;
  return {
    messagesUrl,
    key: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AGENT_FLOOR_CHAT_MODEL || 'claude-opus-4-5',
  };
}

export async function* streamChat({ prompt, model }) {
  const { messagesUrl, key, model: fallback } = resolveConfig();
  if (!key) throw new Error('chat: ANTHROPIC_API_KEY is not set');

  const res = await fetch(messagesUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || fallback,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  }).catch((err) => {
    throw Object.assign(new Error(`chat: cannot reach ${messagesUrl}`), { cause: err });
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`chat: HTTP ${res.status} ${text.slice(0, 200)}`), { status: res.status });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        let event = '';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trimStart();
        }
        if (event !== 'content_block_delta') continue;
        try {
          const delta = JSON.parse(data)?.delta;
          if (delta?.type === 'text_delta' && delta.text) yield delta.text;
        } catch { /* skip malformed frame */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
