// api/image.js — генерация и редактирование изображений для веб-чата.
// Провайдер и модель фиксированы на сервере и никогда не отдаются клиенту.
// Ответ идёт SSE: прогресс + готовое изображение в base64.
import { readSession } from './_session.js';
import { normIdentity } from './_accounts.js';
import {
  guestIdentity, readImageUsage, chargeImage, IMAGE_DAILY_LIMIT,
} from './_usage.js';

export const config = { runtime: 'edge' };

const apiBase = () => (process.env.NEUTRALBEATS_BASE_URL || 'https://api.etage.one/v1').replace(/\/+$/, '');
const IMAGE_MODEL = 'gpt-image-2.5-flare';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sseHeaders(extra = {}) {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    ...CORS,
    ...extra,
  };
}

function sizeFor(aspect, explicit) {
  if (/^\d{3,4}x\d{3,4}$/.test(String(explicit || ''))) return String(explicit);
  return {
    '1:1': '1024x1024',
    '16:9': '1536x1024',
    '9:16': '1024x1536',
    '4:3': '1536x1024',
    '3:4': '1024x1536',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
  }[String(aspect || '')] || '1024x1024';
}

function b64ToBytes(b64) {
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function extractImage(payload) {
  if (!payload || typeof payload !== 'object') return { b64: null, url: null };
  let item = null;
  for (const key of ['data', 'images', 'output', 'result']) {
    const raw = payload[key];
    if (Array.isArray(raw) && raw.length) { item = raw[0]; break; }
    if (raw && typeof raw === 'object') { item = raw; break; }
    if (typeof raw === 'string') { item = raw; break; }
  }
  if (typeof item === 'string') {
    return item.startsWith('http') ? { b64: null, url: item } : { b64: item, url: null };
  }
  if (!item || typeof item !== 'object') return { b64: null, url: null };
  return {
    b64: item.b64_json || item.b64 || item.image_base64 || item.base64 || null,
    url: item.url || item.image_url || null,
  };
}

async function downloadAsB64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('image_download_failed');
  const buf = new Uint8Array(await res.arrayBuffer());
  return bytesToB64(buf);
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  for (const ref of refs.slice(0, 4)) {
    if (!ref || typeof ref !== 'object') continue;
    let data = String(ref.data || '');
    const comma = data.indexOf(',');
    if (data.startsWith('data:') && comma !== -1) data = data.slice(comma + 1);
    data = data.replace(/\s+/g, '');
    if (!data || data.length > 12 * 1024 * 1024) continue;
    const mimeType = String(ref.mimeType || 'image/png').startsWith('image/')
      ? String(ref.mimeType || 'image/png') : 'image/png';
    out.push({ mimeType, data });
  }
  return out;
}

async function callProvider(prompt, refs, size) {
  const key = process.env.NEUTRALBEATS_API_KEY;
  if (!key) throw new Error('no_key');
  const headers = { Authorization: `Bearer ${key}` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 220000);

  try {
    let res;
    if (refs.length) {
      const form = new FormData();
      form.append('model', IMAGE_MODEL);
      form.append('prompt', prompt);
      form.append('n', '1');
      form.append('size', size);
      form.append('response_format', 'b64_json');
      const field = refs.length === 1 ? 'image' : 'image[]';
      refs.forEach((ref, i) => {
        const bytes = b64ToBytes(ref.data);
        form.append(field, new Blob([bytes], { type: ref.mimeType }), `ref${i}.png`);
      });
      res = await fetch(`${apiBase()}/images/edits`, {
        method: 'POST', headers, body: form, signal: ctrl.signal,
      });
    } else {
      res = await fetch(`${apiBase()}/images/generations`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt,
          n: 1,
          size,
          response_format: 'b64_json',
        }),
        signal: ctrl.signal,
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[image] provider error', res.status, text.slice(0, 300));
      throw new Error('provider_error');
    }
    const payload = await res.json();
    const { b64, url } = extractImage(payload);
    if (b64) return b64;
    if (url) return await downloadAsB64(url);
    throw new Error('empty_image');
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'bad_json' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  const user = await readSession(req);
  const guest = !user;
  let usageCtx;
  let usageHeaders = {};
  if (guest) {
    const g = await guestIdentity(req, process.env);
    usageCtx = { kind: 'guest', id: g.id };
    if (g.setCookie) usageHeaders = { 'Set-Cookie': g.setCookie };
  } else {
    usageCtx = { kind: 'user', id: normIdentity(user.id) };
  }

  const prompt = String(body.prompt || '').trim().slice(0, 4000);
  if (!prompt) {
    return new Response(`data: ${JSON.stringify({ error: 'Пустой промпт для изображения.' })}\n\ndata: {"done":true}\n\n`, {
      headers: sseHeaders(usageHeaders),
    });
  }
  const refs = normalizeRefs(body.refs);
  const size = sizeFor(body.aspectRatio || body.aspect_ratio, body.size);
  const before = await readImageUsage(process.env, usageCtx);

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };
      send({ imageProgress: 0, remaining: before.remaining, limit: IMAGE_DAILY_LIMIT });
      if (before.remaining <= 0) {
        send({
          error: 'Лимит генераций картинок на сегодня исчерпан. Попробуй завтра.',
          limit: true, remaining: 0,
        });
        send({ done: true });
        try { controller.close(); } catch {}
        return;
      }

      let pct = 4;
      let closed = false;
      const timer = setInterval(() => {
        if (closed) return;
        pct = Math.min(95, pct + 4 + Math.floor(Math.random() * 6));
        send({ imageProgress: pct });
      }, 2000);

      try {
        const b64 = await callProvider(prompt, refs, size);
        clearInterval(timer);
        const charged = await chargeImage(process.env, usageCtx);
        send({
          image: { data: b64, mimeType: 'image/png' },
          remaining: charged.remaining,
          limit: IMAGE_DAILY_LIMIT,
        });
        send({ done: true });
      } catch (err) {
        clearInterval(timer);
        console.error('[image] failed', err && err.message);
        const msg = err && err.message === 'no_key'
          ? 'Генерация изображений сейчас недоступна.'
          : 'Не получилось сгенерировать картинку. Попробуй ещё раз.';
        send({ error: msg });
        send({ done: true });
      } finally {
        closed = true;
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, { headers: sseHeaders(usageHeaders) });
}
