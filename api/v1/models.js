// api/v1/models.js — публичный API: список моделей, цены API и множители лимита.
//   GET /v1/models   (Authorization: Bearer kulsh_sk_...)
import { MODELS, modelLabel, API_PRICING, API_FREE } from '../_models.js';
import { resolveApiKey, apiKeyFromRequest } from '../_apikeys.js';

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, api-key, x-api-key',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const raw = apiKeyFromRequest(req);
  const userId = raw ? await resolveApiKey(process.env, raw) : null;
  if (!userId) return json({ error: 'invalid_key', message: 'API key is invalid or missing.' }, 401);

  const models = Object.entries(MODELS).map(([id, m]) => {
    const p = API_PRICING[id] || { in: 0, out: 0 };
    const free = API_FREE.has(id);
    return {
      id, dev: m.dev, vision: m.vision, mult: m.mult, name: modelLabel(id),
      free,
      pricing: {
        input: p.in, output: p.out,
        cacheRead: p.cacheIn ?? 0, cacheWrite: p.cacheOut ?? 0,
        currency: 'USD', per: '1M tokens',
      },
    };
  });
  const created = 1735689600; // 2025-01-01, стабильная метка для клиентов
  return json({
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created,
      owned_by: m.dev || m.provider,
      name: m.name,
      vision: m.vision,
      mult: m.mult,
      free: m.free,
      pricing: m.pricing,
    })),
    models,
  });
}
