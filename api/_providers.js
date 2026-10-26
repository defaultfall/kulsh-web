// api/_providers.js — адаптеры LLM-провайдеров для api/chat.js.
//
// Единый контракт, чтобы chat.js не знал деталей каждого сервиса:
//   keys(env)  → массив API-ключей провайдера (для ротации);
//   open(ctx)  → Promise<Response> со стримом (SSE);
//   parseEvent(data) → { text, finish, blocked } из одного распарсенного SSE-события.
//
// chat.js сам нормализует поток и шлёт клиенту события { delta } / { done } / { error }.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const ETAGEONE_BASE = 'https://api.etage.one/v1';

const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

const isImage = (mime) => /^image\//i.test(mime || '');
const isText = (mime) => /^text\//i.test(mime || '') || /(json|xml|javascript|x-yaml|csv|markdown)/i.test(mime || '');

function b64ToText(b64) {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch { return ''; }
}

// ---- Google Gemini (нативный API) ----
function geminiContent(m) {
  const parts = [];
  if (m.text && m.text.trim()) parts.push({ text: m.text });
  for (const a of m.media) {
    parts.push({ inline_data: { mime_type: a.mimeType, data: a.data } });
  }
  if (!parts.length) return null;
  return { role: m.role === 'assistant' ? 'model' : 'user', parts };
}

const google = {
  id: 'google',
  envKeys: ['APIKEY1', 'APIKEY2', 'APIKEY3', 'APIKEY4', 'APIKEY5'],
  keys(env) {
    const out = [];
    for (const name of this.envKeys) { const k = (env[name] || '').trim(); if (k) out.push(k); }
    return out;
  },
  async open({ model, key, messages, systemText, temperature, signal, webSearch }) {
    const contents = messages.map(geminiContent).filter(Boolean);
    const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    const generationConfig = { maxOutputTokens: 16384 };
    if (temperature !== undefined) generationConfig.temperature = temperature;
    const payload = {
      contents,
      generationConfig,
      safetySettings: SAFETY,
    };
    // Пустой system_instruction Gemini может отвергнуть, а в API системных
    // инструкций Kulsh нет — тогда просто не передаём поле.
    if (systemText && systemText.trim()) {
      payload.system_instruction = { parts: [{ text: systemText }] };
    }
    if (webSearch) payload.tools = [{ google_search: {} }];
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(payload),
    });
  },
  parseEvent(data) {
    const br = data && data.promptFeedback && data.promptFeedback.blockReason;
    const cand = data && data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map((p) => p.text || '').join('');
    let blocked = br || null;
    if (cand && cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS' && !text) {
      blocked = blocked || cand.finishReason;
    }
    const um = data && data.usageMetadata;
    const usageIn = um ? (Number(um.promptTokenCount) || 0) : undefined;
    const usageOut = um ? (Number(um.candidatesTokenCount) || 0) : undefined;
    const usage = um ? (usageIn || 0) + (usageOut || 0) : undefined;
    return { text, finish: cand && cand.finishReason, blocked, usage, usageIn, usageOut };
  },
  // Разбор НЕ-стримингового ответа (если сервис проигнорировал stream:true).
  parseFull(data) {
    const br = data && data.promptFeedback && data.promptFeedback.blockReason;
    const cand = data && data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map((p) => p.text || '').join('');
    return { text, blocked: br || null };
  },
};

// ---- EtageOne (OpenAI-совместимый API) ----
function openaiMessage(m) {
  const images = m.media.filter((a) => isImage(a.mimeType));
  const texts = m.media.filter((a) => !isImage(a.mimeType) && isText(a.mimeType));
  if (!images.length && !texts.length) return { role: m.role, content: m.text };
  const parts = [];
  if (m.text && m.text.trim()) parts.push({ type: 'text', text: m.text });
  for (const a of texts) {
    const t = b64ToText(a.data);
    if (t) parts.push({ type: 'text', text: `\n\n[Файл: ${a.name || 'файл'}]\n${t}` });
  }
  for (const a of images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${a.data}` } });
  }
  return { role: m.role, content: parts };
}

const openaiCompat = {
  id: 'etageone',
  envKeys: ['NEUTRALBEATS_API_KEY'],
  keys(env) {
    const out = [];
    for (const name of this.envKeys) { const k = (env[name] || '').trim(); if (k) out.push(k); }
    return out;
  },
  async open({ model, key, messages, systemText, temperature, signal, env }) {
    const base = (env.NEUTRALBEATS_BASE_URL || ETAGEONE_BASE).replace(/\/+$/, '');
    const msgs = systemText && systemText.trim()
      ? [{ role: 'system', content: systemText }, ...messages.map(openaiMessage)]
      : messages.map(openaiMessage);
    const payload = { model, messages: msgs, stream: true, max_tokens: 16384 };
    if (temperature !== undefined) payload.temperature = temperature;
    return fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal,
      body: JSON.stringify(payload),
    });
  },
  parseEvent(data) {
    const ch = data && data.choices && data.choices[0];
    const d = ch && ch.delta;
    let text = '';
    let reasoning = '';
    if (d) {
      if (typeof d.content === 'string') text = d.content;
      else if (Array.isArray(d.content)) text = d.content.map((p) => (p && p.text) || '').join('');
      // Reasoning-модели (DeepSeek и др.) сначала шлют размышления в отдельном поле.
      if (typeof d.reasoning_content === 'string') reasoning = d.reasoning_content;
      else if (typeof d.reasoning === 'string') reasoning = d.reasoning;
    }
    const u = data && data.usage;
    const usageIn = u ? (Number(u.prompt_tokens) || 0) : undefined;
    const usageOut = u ? (Number(u.completion_tokens) || 0) : undefined;
    const usage = u ? (usageIn || 0) + (usageOut || 0) : undefined;
    return { text, reasoning, finish: ch && ch.finish_reason, blocked: null, usage, usageIn, usageOut };
  },
  // Разбор НЕ-стримингового ответа (если сервис проигнорировал stream:true).
  parseFull(data) {
    const ch = data && data.choices && data.choices[0];
    const msg = ch && (ch.message || ch.delta);
    let text = '';
    if (msg) {
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) text = msg.content.map((p) => (p && p.text) || '').join('');
    }
    return { text, blocked: null };
  },
};

export const PROVIDERS = { google, etageone: openaiCompat };

// Приводим входные сообщения клиента к общему виду { role, text, media[] }.
export function canonicalMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    const role = m.role === 'developer' ? 'system' : m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
    let text = '';
    let media = [];
    if (Array.isArray(m.content)) {
      // [OI]-совместимый content: [{type:'text'}, {type:'image_url'}].
      const texts = [];
      for (const part of m.content) {
        if (!part) continue;
        if (part.type === 'text' && part.text) texts.push(String(part.text));
        else if (part.type === 'image_url') {
          const url = part.image_url && part.image_url.url;
          if (typeof url === 'string' && url.startsWith('data:')) {
            const comma = url.indexOf(',');
            if (comma > 0) {
              const meta = url.slice(5, comma);
              const mimeType = meta.split(';')[0] || 'image/png';
              media.push({ mimeType, data: url.slice(comma + 1), name: 'image' });
            }
          }
        }
      }
      text = texts.join('\n');
    } else {
      text = m.content ? String(m.content) : '';
      media = Array.isArray(m.attachments)
        ? m.attachments.filter((a) => a && a.data && a.mimeType)
        : [];
    }
    // У system-сообщений не бывает вложений: только текст инструкции.
    if (role === 'system') media = [];
    if (!text.trim() && !media.length) continue;
    out.push({ role, text, media });
  }
  return out;
}
