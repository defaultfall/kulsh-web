// api/rate.js — реальный курс USD → RUB для отображения баланса.
//   GET /api/rate → { base:'USD', quote:'RUB', rate, source, date }
//
// Источник — ежедневные данные ЦБ РФ через cbr-xml-daily.ru (JSON, без ключей).
// Если источник недоступен, отдаём USD_TO_RUB из env (по умолчанию 90), чтобы
// интерфейс никогда не ломался. Ответ кэшируется на час на edge.
export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      ...CORS,
      ...extra,
    },
  });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  try {
    const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', {
      headers: { 'User-Agent': 'Kulsh/1.0 (+https://kulsh.vercel.app)' },
    });
    if (!res.ok) throw new Error('cbr_' + res.status);
    const data = await res.json();
    const usd = data && data.Valute && data.Valute.USD;
    const rate = Number(usd && usd.Value);
    if (!(rate > 0)) throw new Error('bad_rate');
    return json({
      base: 'USD',
      quote: 'RUB',
      rate,
      source: 'cbr',
      date: data.Date || null,
      previous: Number(usd.Previous) || null,
    });
  } catch {
    return json({
      base: 'USD',
      quote: 'RUB',
      rate: Number(process.env.USD_TO_RUB || 90),
      source: 'fallback',
      date: null,
    });
  }
}
