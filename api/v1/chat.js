// api/v1/chat.js — публичный API: стриминг ответа модели.
//
// Два режима:
//   1) POST /v1/chat            — родной формат Kulsh ({ delta }, { done }).
//   2) POST /v1/chat/completions — [OI]-совместимый Chat Completions
//      (stream: true → SSE-чанки, stream: false → один JSON). Именно этот
//      режим нужен IDE, клиентам и любым [OI]-совместимым интеграциям.
//
// Авторизация: Authorization: Bearer kulsh_sk_...
// Лимиты и баланс общие с веб-чатом (см. api/_usage.js, api/_accounts.js).
import { resolveApiKey, touchApiKey, apiKeyFromRequest } from '../_apikeys.js';
import { runChat } from '../_chat-core.js';

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With, api-key, x-api-key',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });

const errBody = (message, code = 'bad_request', type = 'invalid_request_error') => ({
  error: { message, type, code },
});

function completionId() {
  try { return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24); }
  catch { return 'chatcmpl-' + Math.random().toString(36).slice(2, 14); }
}

function readSseChunks(buffer, onObj) {
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const chunk = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onObj(JSON.parse(payload)); } catch {}
    }
  }
  return buffer;
}

// [OI]-совместимый SSE.
function openaiStream(res, model) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  return new ReadableStream({
    async start(controller) {
      const reader = res.body.getReader();
      let buffer = '';
      let finished = false;
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const finish = () => {
        if (finished) return;
        finished = true;
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          buffer = readSseChunks(buffer, (o) => {
            if (o.error) {
              send(errBody(String(o.error), 'upstream_error', 'upstream_error'));
            } else if (o.delta) {
              send({
                id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { content: o.delta }, finish_reason: null }],
              });
            } else if (o.done) {
              send({
                id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              });
            }
          });
        }
      } catch {
        // Клиент отключился — просто закрываем поток.
      } finally {
        finish();
        try { controller.close(); } catch {}
      }
    },
  });
}

async function collect(res) {
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  let text = '';
  let error = '';
  let usage = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    buffer = readSseChunks(buffer, (o) => {
      if (o.error) error = String(o.error);
      else if (o.delta) text += o.delta;
      else if (o.done && o.usage) usage = Number(o.usage.used) || usage;
    });
  }
  return { text, error, usage };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(errBody('Method not allowed.', 'method_not_allowed'), 405);

  const raw = apiKeyFromRequest(req);
  if (!raw) {
    return json(errBody('Provide header: Authorization: Bearer <API_KEY>', 'missing_key', 'authentication_error'), 401);
  }
  const userId = await resolveApiKey(process.env, raw);
  if (!userId) {
    return json(errBody('API key is invalid or revoked.', 'invalid_key', 'authentication_error'), 401);
  }
  touchApiKey(process.env, userId, raw).catch(() => {});

  const openai = new URL(req.url).searchParams.get('openai') === '1';
  if (!openai) {
    const res = await runChat(req, { user: { id: userId }, api: true });
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }

  // [OI]-режим: читаем параметры, не съедая тело для runChat.
  let body = {};
  try { body = await req.clone().json(); } catch {
    return json(errBody('Invalid JSON body.', 'bad_json'), 400);
  }
  const stream = body.stream === true;
  const model = String(body.model || '');
  const res = await runChat(req, { user: { id: userId }, api: true });

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok || ctype.includes('application/json')) {
    let payload = null;
    try { payload = await res.json(); } catch {}
    const message = (payload && (payload.message || payload.error)) || 'Request failed.';
    return json(errBody(String(message), (payload && payload.error) || 'request_failed'), res.status || 400);
  }

  if (stream) {
    return new Response(openaiStream(res, model), {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        ...CORS,
      },
    });
  }

  const { text, error, usage } = await collect(res);
  if (error) return json(errBody(error, 'upstream_error', 'upstream_error'), 502);
  return json({
    id: completionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
