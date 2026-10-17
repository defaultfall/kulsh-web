// api/v1/models.js — публичный API: список моделей и их множителей лимита.
//   GET /api/v1/models   (Authorization: Bearer kulsh_sk_...)
import { MODELS, modelLabel } from '../_models.js';
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

  const models = Object.entries(MODELS).map(([id, m]) => ({
    id, dev: m.dev, vision: m.vision, mult: m.mult, name: modelLabel(id),
  }));
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
    })),
    models,
  });
}
