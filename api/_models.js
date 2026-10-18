// api/_models.js — единый реестр моделей (серверная сторона).
// ВАЖНО: этот список дублируется на фронтенде в public/app.js (MODELS).
// При добавлении модели правь оба места.
//
// provider — какой адаптер использовать (api/_providers.js);
// dev      — разработчик модели (для группировки и owned_by в /v1/models);
// vision   — принимает ли модель изображения (false → вложения отклоняются);
// mult     — множитель расхода дневного лимита (в токенах) за запрос.
//            Лёгкие модели ×1, флагманы — дороже (до ×3).

export const GUEST_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-2.5-flash';

export const MODELS = {
  // ---- Anthropic ----
  'claude-opus-5-5': { provider: 'neutralbeats', dev: 'anthropic', vision: true, mult: 3, label: 'Claude Opus 5.5', paid: true },
  'claude-sonnet-5-5': { provider: 'neutralbeats', dev: 'anthropic', vision: true, mult: 3, label: 'Claude Sonnet 5.5', paid: true },
  'claude-fable-5-1': { provider: 'neutralbeats', dev: 'anthropic', vision: true, mult: 3, label: 'Claude Fable 5.1', paid: true },
  'claude-haiku-5-5': { provider: 'neutralbeats', dev: 'anthropic', vision: true, mult: 1, label: 'Claude Haiku 5.5' },
  // ---- Google DeepMind (нативный API, ротация APIKEY1..APIKEY5) ----
  'gemini-2.5-flash':      { provider: 'google', dev: 'google', vision: true,  mult: 1,   label: 'Gemini 2.5 Flash' },
  'gemini-2.5-flash-lite': { provider: 'google', dev: 'google', vision: true,  mult: 1,   label: 'Gemini 2.5 Flash Lite' },
  'gemini-3.5-flash':      { provider: 'google', dev: 'google', vision: true,  mult: 1.5, label: 'Gemini 3.5 Flash' },
  'gemini-3.5-flash-lite': { provider: 'google', dev: 'google', vision: true,  mult: 1.5, label: 'Gemini 3.5 Flash Lite' },
  'gemini-3.6-flash':      { provider: 'google', dev: 'google', vision: true,  mult: 3,   label: 'Gemini 3.6 Flash' },
  'gemini-3.7-flash':      { provider: 'google', dev: 'google', vision: true,  mult: 3,   label: 'Gemini 3.7 Flash' },
  'gemini-3.8-flash':      { provider: 'google', dev: 'google', vision: true,  mult: 3,   label: 'Gemini 3.8 Flash' },

  // ---- DeepSeek ----
  // V4.1 Flash — повседневная модель: расход лимита в 10 раз ниже обычного.
  'deepseek-v4.1-flash':   { provider: 'neutralbeats', dev: 'deepseek', vision: true,  mult: 0.1, label: 'DeepSeek V4.1 Flash' },
  'deepseek-v4-pro':       { provider: 'neutralbeats', dev: 'deepseek', vision: false, mult: 2, label: 'DeepSeek V4 Pro' },
  // ---- Z.AI ----
  'glm-5.3-flash':         { provider: 'neutralbeats', dev: 'zai', vision: true,  mult: 0.1, label: 'GLM 5.3 Flash' },
  // ---- Moonshot AI ----
  'kimi-k3':               { provider: 'neutralbeats', dev: 'moonshot', vision: true,  mult: 3, label: 'Kimi K3' },
  // ---- [OI] ----
  'gpt-6-luna':            { provider: 'neutralbeats', dev: 'openai', vision: true,  mult: 2, label: 'GPT-6 Luna' },
  'gpt-6.1-sol':           { provider: 'neutralbeats', dev: 'openai', vision: true,  mult: 3, label: 'GPT-6.1 Sol' },
  'gpt-6-astra':           { provider: 'neutralbeats', dev: 'openai', vision: true,  mult: 3, label: 'GPT-6 Astra', paid: true },
  // ---- xAI ----
  'grok-4.7':              { provider: 'neutralbeats', dev: 'xai', vision: true,  mult: 3, label: 'Grok 4.7', paid: true },
  // ---- Alibaba ----
  'qwen3.8-max-0902':      { provider: 'neutralbeats', dev: 'alibaba', vision: true,  mult: 3, label: 'Qwen3.8 Max', paid: true },
};

// Цены чата за 1 млн токенов в USD — те же, что в боте (src/util.py MODEL_PRICING).
export const PRICING = {
  'claude-opus-5-5': { in: 0.60, out: 3.20 },
  'claude-sonnet-5-5': { in: 0.40, out: 2.00 },
  'claude-fable-5-1': { in: 1.20, out: 6.00 },
  'grok-4.7':         { in: 0.20, out: 1.00 },
  'gpt-6-astra':      { in: 0.34, out: 1.70 },
  'qwen3.8-max-0902': { in: 0.20, out: 1.00 },
};

// Цены API за 1 млн токенов в USD. Это отдельный прайс: в чате бесплатные
// модели входят в дневной лимит, а в API они стоят денег (кроме двух
// бесплатных исключений). Для платных моделей цена API совпадает с чатом.
// Бесплатные модели оценены примерно в 1.5–2× от закупочной цены провайдера.
export const API_PRICING = {
  ...PRICING,
  // Anthropic
  'claude-haiku-5-5':       { in: 0.08, out: 0.40 },
  // Google DeepMind — почти по себестоимости, чтобы быть дешевле официальных
  // цен по каждому тарифу, а не только в среднем.
  'gemini-2.5-flash':       { in: 0.02, out: 0.18 },
  'gemini-2.5-flash-lite':  { in: 0.01, out: 0.05 },
  'gemini-3.5-flash':       { in: 0.04, out: 0.25 },
  'gemini-3.5-flash-lite':  { in: 0.01, out: 0.05 },
  'gemini-3.6-flash':       { in: 0.04, out: 0.25 },
  'gemini-3.7-flash':       { in: 0.04, out: 0.25 },
  'gemini-3.8-flash':       { in: 0.04, out: 0.25 },
  // DeepSeek
  'deepseek-v4-pro':        { in: 0.29, out: 1.15 },
  // Moonshot AI
  'kimi-k3':                { in: 0.23, out: 1.30 },
  // [OI]
  'gpt-6-luna':             { in: 0.08, out: 0.40 },
  'gpt-6.1-sol':            { in: 0.18, out: 0.90 },
  // Бесплатные в API
  'deepseek-v4.1-flash':    { in: 0, out: 0 },
  'glm-5.3-flash':          { in: 0, out: 0 },
};

export const API_FREE = new Set(['deepseek-v4.1-flash', 'glm-5.3-flash']);

const USD_TO_RUB = Number(process.env.USD_TO_RUB || 90);

export const isPaid = (id) => Object.prototype.hasOwnProperty.call(PRICING, id);
export const isApiFree = (id) => API_FREE.has(id);
export const isApiPaid = (id) => Object.prototype.hasOwnProperty.call(MODELS, id) && !API_FREE.has(id);

// Стоимость запроса в чате, в копейках.
export function costKopecks(id, inputTokens, outputTokens) {
  const p = PRICING[id];
  if (!p) return 0;
  const usd = (Math.max(0, inputTokens) * p.in + Math.max(0, outputTokens) * p.out) / 1_000_000;
  return Math.max(1, Math.round(usd * USD_TO_RUB * 100));
}

// Стоимость запроса в API, в копейках. Для двух бесплатных моделей — 0.
export function apiCostKopecks(id, inputTokens, outputTokens) {
  if (isApiFree(id)) return 0;
  const p = API_PRICING[id];
  if (!p) return 0;
  const usd = (Math.max(0, inputTokens) * p.in + Math.max(0, outputTokens) * p.out) / 1_000_000;
  return Math.max(1, Math.round(usd * USD_TO_RUB * 100));
}

export const isAllowed = (id) => Object.prototype.hasOwnProperty.call(MODELS, id);
export const modelInfo = (id) => MODELS[id] || null;

// Человеческое имя: для Anthropic собираем из id, чтобы не зависеть от label.
export function modelLabel(id) {
  const m = MODELS[id];
  if (!m) return id;
  if (m.dev === 'anthropic' && String(id).startsWith('claude-')) {
    const p = String(id).split('-');
    const family = p[1] ? p[1][0].toUpperCase() + p[1].slice(1) : '';
    const ver = p.slice(2).join('.');
    return ('Claude ' + family + ' ' + ver).trim();
  }
  return m.label || id;
}
