// api/_models.js — единый реестр моделей (серверная сторона).
// ВАЖНО: этот список дублируется на фронтенде в public/app.js (MODELS).
// При добавлении модели правь оба места.
//
// provider — какой адаптер использовать (api/_providers.js);
// vision   — принимает ли модель изображения (false → вложения отклоняются);
// mult     — множитель расхода дневного лимита (в токенах) за запрос.
//            Лёгкие модели ×1, флагманы — дороже (до ×3).

export const GUEST_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-2.5-flash';

export const MODELS = {
  // ---- Google Gemini (нативный API, ротация APIKEY1..APIKEY5) ----
  'gemini-2.5-flash':      { provider: 'google', vision: true,  mult: 1,   label: 'Gemini 2.5 Flash' },
  'gemini-2.5-flash-lite': { provider: 'google', vision: true,  mult: 1,   label: 'Gemini 2.5 Flash Lite' },
  'gemini-3.5-flash':      { provider: 'google', vision: true,  mult: 1.5, label: 'Gemini 3.5 Flash' },
  'gemini-3.5-flash-lite': { provider: 'google', vision: true,  mult: 1.5, label: 'Gemini 3.5 Flash Lite' },
  'gemini-3.6-flash':      { provider: 'google', vision: true,  mult: 3,   label: 'Gemini 3.6 Flash' },
  'gemini-3.7-flash':      { provider: 'google', vision: true,  mult: 3,   label: 'Gemini 3.7 Flash' },
  'gemini-3.8-flash':      { provider: 'google', vision: true,  mult: 3,   label: 'Gemini 3.8 Flash' },

  // ---- NeutralBeats ([OI]-совместимый API, ключ NEUTRALBEATS_API_KEY) ----
  'deepseek-v4.1-flash':   { provider: 'neutralbeats', vision: true,  mult: 1, label: 'DeepSeek V4.1 Flash' },
  'deepseek-v4-pro':       { provider: 'neutralbeats', vision: false, mult: 2, label: 'DeepSeek V4 Pro' },
  'glm-5.3-flash':         { provider: 'neutralbeats', vision: true,  mult: 1, label: 'GLM 5.3 Flash' },
  'kimi-k3':               { provider: 'neutralbeats', vision: true,  mult: 3, label: 'Kimi K3' },

  // ---- Платные модели: те же, что в боте, списываются с общего баланса ----
  'grok-4.7':              { provider: 'neutralbeats', vision: true,  mult: 3, label: 'Grok 4.7',            paid: true },
  'claude-haiku-5-5':      { provider: 'neutralbeats', vision: true,  mult: 1, label: 'Claude Haiku 5.5' },
  'claude-sonnet-5-5':     { provider: 'neutralbeats', vision: true,  mult: 3, label: 'Claude Sonnet 5.5',     paid: true },
  'claude-opus-5-5':       { provider: 'neutralbeats', vision: true,  mult: 3, label: 'Claude Opus 5.5',       paid: true },
  'claude-fable-5-1':      { provider: 'neutralbeats', vision: true,  mult: 3, label: 'Claude Fable 5.1',      paid: true },
  'gpt-6-luna':            { provider: 'neutralbeats', vision: true,  mult: 2, label: 'GPT-6 Luna' },
  'gpt-6.1-sol':           { provider: 'neutralbeats', vision: true,  mult: 3, label: 'GPT-6.1 Sol' },
  'gpt-6-astra':           { provider: 'neutralbeats', vision: true,  mult: 3, label: 'GPT-6 Astra',           paid: true },
  'qwen3.8-max-0902':      { provider: 'neutralbeats', vision: true,  mult: 3, label: 'Qwen3.8 Max',           paid: true },
};

// Цены за 1 млн токенов в USD — те же, что в боте (src/util.py MODEL_PRICING).
export const PRICING = {
  'grok-4.7':          { in: 0.20, out: 1.00 },
  'claude-sonnet-5-5': { in: 0.40, out: 2.00 },
  'claude-opus-5-5':   { in: 0.60, out: 3.20 },
  'claude-fable-5-1':  { in: 1.20, out: 6.00 },
  'gpt-6-astra':       { in: 0.34, out: 1.70 },
  'qwen3.8-max-0902':  { in: 0.20, out: 1.00 },
};

const USD_TO_RUB = Number(process.env.USD_TO_RUB || 90);

export const isPaid = (id) => Object.prototype.hasOwnProperty.call(PRICING, id);

// Стоимость запроса в копейках.
export function costKopecks(id, inputTokens, outputTokens) {
  const p = PRICING[id];
  if (!p) return 0;
  const usd = (Math.max(0, inputTokens) * p.in + Math.max(0, outputTokens) * p.out) / 1_000_000;
  return Math.max(1, Math.round(usd * USD_TO_RUB * 100));
}

export const isAllowed = (id) => Object.prototype.hasOwnProperty.call(MODELS, id);
export const modelInfo = (id) => MODELS[id] || null;
