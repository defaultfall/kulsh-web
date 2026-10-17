// api/_promo.js — промокоды, общие с ботом.
//
// Формат в Redis (его же пишет админ-панель бота):
//   kulsh:promo:{CODE}       → { type: 'amount'|'bonus', value, uses, expiresAt, createdAt, active }
//   kulsh:promo:{CODE}:used  → hash: accountId → timestamp
//
// type=amount — фиксированная сумма на баланс (в рублях),
// type=bonus  — процент к следующему пополнению.
import { backend, pipeline } from './_store.js';
import { follow } from './_accounts.js';

const key = (code) => `kulsh:promo:${String(code || '').trim().toUpperCase()}`;

export async function redeemPromo(env, acct, rawCode) {
  const b = backend(env);
  if (!b) return { error: 'storage_off' };
  const code = String(rawCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) return { error: 'bad_code' };
  const id = await follow(env, acct);

  const [raw, usedCount, already] = await pipeline(b, [
    ['GET', key(code)],
    ['HLEN', `${key(code)}:used`],
    ['HEXISTS', `${key(code)}:used`, id],
  ]);
  if (!raw) return { error: 'not_found' };
  let item;
  try { item = JSON.parse(raw); } catch { return { error: 'not_found' }; }
  if (!item || typeof item !== 'object') return { error: 'not_found' };
  if (item.active === false) return { error: 'disabled' };
  if (Number(item.expiresAt) && Date.now() > Number(item.expiresAt)) return { error: 'expired' };
  if (Number(already) === 1) return { error: 'used' };
  const uses = Number(item.uses) || 0;
  if (uses && Number(usedCount) >= uses) return { error: 'limit' };

  const value = Math.max(0, Math.round(Number(item.value) || 0));
  if (!value) return { error: 'broken' };

  const cmds = [['HSET', `${key(code)}:used`, id, String(Date.now())]];
  let balanceAdded = 0;
  let bonus = 0;
  if (item.type === 'amount') {
    balanceAdded = value * 100;
    cmds.push(['INCRBY', `kulsh:u:${id}:balance`, String(balanceAdded)]);
  } else if (item.type === 'bonus') {
    bonus = Math.min(500, value);
    const [current] = await pipeline(b, [['GET', `kulsh:u:${id}:bonus`]]);
    if (bonus > Number(current || 0)) cmds.push(['SET', `kulsh:u:${id}:bonus`, String(bonus)]);
  } else {
    return { error: 'broken' };
  }
  await pipeline(b, cmds);
  return { ok: true, type: item.type, value, balanceAdded, bonus };
}
