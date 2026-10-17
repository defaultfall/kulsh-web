// api/_accounts.js — общие аккаунты бота и сайта.
//
// Один аккаунт объединяет несколько способов входа:
//   google:<sub>   github:<id>   tg:<telegram id>   ds:<discord id>
//
//   kulsh:acct:{id}          → { id, createdAt, ids:[...], names:{}, avatars:{}, handles:{} }
//   kulsh:ident:{identity}   → account id
//   kulsh:merged:{old}       → новый account id (после слияния)
//   kulsh:u:{id}:balance     → копейки (общий с ботом)
//   kulsh:u:{id}:topup       → всего пополнено, копейки
//   kulsh:u:{id}:topupcount  → число пополнений
//   kulsh:u:{id}:bonus       → бонус к следующему пополнению, %
//   kulsh:u:{id}:usage:{day} → токены за день
//   kulsh:u:{id}:apikeys     → JSON список ключей
//   kulsh:key:{sha256}       → account id
//   kulsh:pend:{token}       → отложенная привязка (TTL 10 минут)

import { backend, pipeline } from './_store.js';

const DAY = 86400;

export const identityOf = (provider, id) => `${provider}:${id}`;
export const providerOf = (ident) => String(ident || '').split(':', 1)[0];

const K = {
  acct: (id) => `kulsh:acct:${id}`,
  ident: (ident) => `kulsh:ident:${ident}`,
  merged: (id) => `kulsh:merged:${id}`,
  balance: (id) => `kulsh:u:${id}:balance`,
  topup: (id) => `kulsh:u:${id}:topup`,
  count: (id) => `kulsh:u:${id}:topupcount`,
  bonus: (id) => `kulsh:u:${id}:bonus`,
  usage: (id, day) => `kulsh:u:${id}:usage:${day}`,
  keys: (id) => `kulsh:u:${id}:apikeys`,
  pend: (token) => `kulsh:pend:${token}`,
  link: (code) => `kulsh:link:${String(code || '').toUpperCase()}`,
};

const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => Number(v) || 0;

// Старые сессии писали Telegram как `telegram:<id>`, бот и новый сайт — `tg:<id>`.
export const normIdentity = (ident) => {
  const s = String(ident || '');
  return s.startsWith('telegram:') ? `tg:${s.slice(9)}` : s;
};

function parse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function follow(env, acct) {
  const b = backend(env);
  if (!b || !acct) return acct;
  let id = normIdentity(acct);
  for (let i = 0; i < 4; i++) {
    const [next] = await pipeline(b, [['GET', K.merged(id)]]);
    if (!next) return id;
    id = String(next);
  }
  return id;
}

export async function getAccount(env, acct) {
  const b = backend(env);
  const id = await follow(env, acct);
  if (!b || !id) return { id, createdAt: 0, ids: id ? [id] : [], names: {}, avatars: {}, handles: {} };
  const [raw] = await pipeline(b, [['GET', K.acct(id)]]);
  const rec = parse(raw, null);
  if (rec && typeof rec === 'object') {
    rec.id = id;
    if (!Array.isArray(rec.ids)) rec.ids = [id];
    if (!rec.names || typeof rec.names !== 'object') rec.names = {};
    if (!rec.avatars || typeof rec.avatars !== 'object') rec.avatars = {};
    if (!rec.handles || typeof rec.handles !== 'object') rec.handles = {};
    return rec;
  }
  return { id, createdAt: 0, ids: [id], names: {}, avatars: {}, handles: {} };
}

async function saveAccount(env, rec) {
  const b = backend(env);
  if (!b) return;
  await pipeline(b, [['SET', K.acct(rec.id), JSON.stringify(rec)]]);
}

export async function lookupIdentity(env, identity) {
  const b = backend(env);
  if (!b) return null;
  const [raw] = await pipeline(b, [['GET', K.ident(normIdentity(identity))]]);
  if (!raw) return null;
  return follow(env, String(raw));
}

export async function resolveIdentity(env, identity, profile = {}) {
  const b = backend(env);
  identity = normIdentity(identity);
  if (!b) return identity;
  let acct = (await lookupIdentity(env, identity)) || '';
  if (!acct) {
    acct = identity;
    await pipeline(b, [['SET', K.ident(identity), acct, 'NX']]);
  }
  const rec = await getAccount(env, acct);
  let changed = false;
  if (!rec.ids.includes(identity)) { rec.ids.push(identity); changed = true; }
  if (!rec.createdAt) { rec.createdAt = now(); changed = true; }
  const provider = providerOf(identity);
  if (profile.name && rec.names[provider] !== profile.name) { rec.names[provider] = profile.name; changed = true; }
  if (profile.avatar && rec.avatars[provider] !== profile.avatar) { rec.avatars[provider] = profile.avatar; changed = true; }
  if (profile.handle && rec.handles[provider] !== profile.handle) { rec.handles[provider] = profile.handle; changed = true; }
  if (changed) await saveAccount(env, rec);
  return acct;
}

// Привязка свободного способа входа к существующему аккаунту (без слияния).
export async function attachIdentity(env, identity, acct, profile = {}) {
  const b = backend(env);
  if (!b) return acct;
  identity = normIdentity(identity);
  const rec = await getAccount(env, acct);
  if (!rec.ids.includes(identity)) rec.ids.push(identity);
  const provider = providerOf(identity);
  if (profile.name) rec.names[provider] = profile.name;
  if (profile.avatar) rec.avatars[provider] = profile.avatar;
  if (profile.handle) rec.handles[provider] = profile.handle;
  await pipeline(b, [
    ['SET', K.acct(rec.id), JSON.stringify(rec)],
    ['SET', K.ident(identity), rec.id],
  ]);
  return rec.id;
}

// Суммарное состояние аккаунта: то, что показывает сайт и бот.
export async function accountView(env, acct) {
  const rec = await getAccount(env, acct);
  const b = backend(env);
  const id = rec.id;
  const base = {
    id,
    identities: rec.ids.map((ident) => ({
      identity: ident,
      provider: providerOf(ident),
      name: rec.names[providerOf(ident)] || '',
      avatar: rec.avatars[providerOf(ident)] || '',
      handle: rec.handles[providerOf(ident)] || '',
    })),
    balance: 0,
    topup: 0,
    topups: 0,
    bonus: 0,
    used: 0,
    limit: 100000,
    enabled: false,
  };
  if (!b) return base;
  const [bal, topup, count, bonus, used] = await pipeline(b, [
    ['GET', K.balance(id)],
    ['GET', K.topup(id)],
    ['GET', K.count(id)],
    ['GET', K.bonus(id)],
    ['GET', K.usage(id, today())],
  ]);
  return {
    ...base,
    enabled: true,
    balance: num(bal),
    topup: num(topup),
    topups: num(count),
    bonus: num(bonus),
    used: num(used),
  };
}

export async function readBalance(env, acct) {
  const b = backend(env);
  if (!b) return 0;
  const [raw] = await pipeline(b, [['GET', K.balance(await follow(env, acct))]]);
  return num(raw);
}

// Атомарное списание: не уходим в минус, даже при параллельных запросах.
export async function chargeBalance(env, acct, kopecks) {
  const b = backend(env);
  if (!b || kopecks <= 0) return true;
  const id = await follow(env, acct);
  const script =
    "local b=tonumber(redis.call('GET',KEYS[1]) or '0') " +
    "local a=tonumber(ARGV[1]) " +
    "if b>=a then redis.call('DECRBY',KEYS[1],a) return 1 else return 0 end";
  const [out] = await pipeline(b, [['EVAL', script, '1', K.balance(id), String(Math.round(kopecks))]]);
  return Number(out) === 1;
}

export async function addBalance(env, acct, kopecks) {
  const b = backend(env);
  if (!b || kopecks <= 0) return;
  const id = await follow(env, acct);
  await pipeline(b, [['INCRBY', K.balance(id), String(Math.round(kopecks))]]);
}

export async function readUsageRaw(env, acct) {
  const b = backend(env);
  if (!b) return 0;
  const id = await follow(env, acct);
  const [raw] = await pipeline(b, [['GET', K.usage(id, today())]]);
  return num(raw);
}

export async function mergeAccounts(env, srcRaw, dstRaw) {
  const b = backend(env);
  const src = await follow(env, srcRaw);
  const dst = await follow(env, dstRaw);
  if (!b || !src || !dst) return { merged: false };
  if (src === dst) return { merged: false, balance: await readBalance(env, dst) };

  const [sBal, dBal, sTop, dTop, sCnt, dCnt, sBonus, dBonus, sUsed, dUsed, sKeysRaw, dKeysRaw, sRecRaw, dRecRaw] =
    await pipeline(b, [
      ['GET', K.balance(src)], ['GET', K.balance(dst)],
      ['GET', K.topup(src)], ['GET', K.topup(dst)],
      ['GET', K.count(src)], ['GET', K.count(dst)],
      ['GET', K.bonus(src)], ['GET', K.bonus(dst)],
      ['GET', K.usage(src, today())], ['GET', K.usage(dst, today())],
      ['GET', K.keys(src)], ['GET', K.keys(dst)],
      ['GET', K.acct(src)], ['GET', K.acct(dst)],
    ]);

  const sKeys = parse(sKeysRaw, []);
  const dKeys = parse(dKeysRaw, []);
  const seen = new Set(dKeys.map((k) => String(k.id)));
  const keys = [...dKeys, ...sKeys.filter((k) => !seen.has(String(k.id)))].slice(0, 10);

  const sRec = parse(sRecRaw, { ids: [src], names: {} });
  const dRec = parse(dRecRaw, { id: dst, ids: [dst], names: {} });
  const ids = [...new Set([...(dRec.ids || [dst]), ...(sRec.ids || [src])])];
  const names = { ...(sRec.names || {}), ...(dRec.names || {}) };
  const avatars = { ...(sRec.avatars || {}), ...(dRec.avatars || {}) };
  const handles = { ...(sRec.handles || {}), ...(dRec.handles || {}) };
  const record = {
    id: dst,
    createdAt: Math.min(num(dRec.createdAt), num(sRec.createdAt) || num(dRec.createdAt)) || now(),
    ids,
    names,
    avatars,
    handles,
  };

  const cmds = [
    ['SET', K.balance(dst), String(num(sBal) + num(dBal))],
    ['SET', K.topup(dst), String(num(sTop) + num(dTop))],
    ['SET', K.count(dst), String(num(sCnt) + num(dCnt))],
    ['SET', K.usage(dst, today()), String(Math.max(num(sUsed), num(dUsed)))],
    ['SET', K.keys(dst), JSON.stringify(keys)],
    ['SET', K.acct(dst), JSON.stringify(record)],
    ['SET', K.merged(src), dst],
    ['DEL', K.acct(src)],
    ['DEL', K.balance(src)],
    ['DEL', K.topup(src)],
    ['DEL', K.count(src)],
    ['DEL', K.bonus(src)],
    ['DEL', K.keys(src)],
    ['DEL', K.usage(src, today())],
  ];
  const bonus = Math.max(num(sBonus), num(dBonus));
  if (bonus) cmds.push(['SET', K.bonus(dst), String(bonus)]);
  for (const ident of ids) cmds.push(['SET', K.ident(ident), dst]);
  for (const key of sKeys) {
    if (key && key.hash) cmds.push(['SET', `kulsh:key:${key.hash}`, dst]);
  }
  await pipeline(b, cmds);
  return { merged: true, from: src, into: dst, added: num(sBal), balance: num(sBal) + num(dBal) };
}

export async function unlinkIdentity(env, acct, identity) {
  const b = backend(env);
  if (!b) return { error: 'storage_off' };
  identity = normIdentity(identity);
  const rec = await getAccount(env, acct);
  if (!rec.ids.includes(identity)) return { error: 'not_linked' };
  if (rec.ids.length <= 1) return { error: 'last' };

  // Если отвязываем способ, который дал аккаунту id, переносим аккаунт на другой.
  if (identity === rec.id) {
    const newId = rec.ids.find((x) => x !== identity);
    if (!newId) return { error: 'last' };
    await mergeAccounts(env, rec.id, newId);
    const merged = await getAccount(env, newId);
    merged.ids = merged.ids.filter((x) => x !== identity);
    const provider = providerOf(identity);
    if (!merged.ids.some((x) => providerOf(x) === provider)) {
      delete merged.names[provider];
      delete merged.avatars[provider];
      delete merged.handles[provider];
    }
    await pipeline(b, [
      ['SET', K.acct(newId), JSON.stringify(merged)],
      ['DEL', K.ident(identity)],
    ]);
    return { ok: true, newId };
  }

  rec.ids = rec.ids.filter((x) => x !== identity);
  const provider = providerOf(identity);
  if (!rec.ids.some((x) => providerOf(x) === provider)) {
    delete rec.names[provider];
    delete rec.avatars[provider];
    delete rec.handles[provider];
  }
  await pipeline(b, [
    ['SET', K.acct(rec.id), JSON.stringify(rec)],
    ['DEL', K.ident(identity)],
  ]);
  return { ok: true };
}

export async function deleteAccount(env, acct) {
  const b = backend(env);
  if (!b) return { error: 'storage_off' };
  const rec = await getAccount(env, acct);
  const cmds = [];
  for (const ident of rec.ids) cmds.push(['DEL', K.ident(ident)]);
  cmds.push(
    ['DEL', K.acct(rec.id)],
    ['DEL', K.balance(rec.id)],
    ['DEL', K.topup(rec.id)],
    ['DEL', K.count(rec.id)],
    ['DEL', K.bonus(rec.id)],
    ['DEL', K.keys(rec.id)],
    ['DEL', K.usage(rec.id, today())],
  );
  await pipeline(b, cmds);
  return { ok: true };
}

// ---------- отложенные привязки ----------
export async function putPending(env, data, ttl = 600) {
  const b = backend(env);
  if (!b) return null;
  const token = crypto.randomUUID().replace(/-/g, '');
  await pipeline(b, [['SET', K.pend(token), JSON.stringify({ ...data, ts: now() }), 'EX', String(ttl)]]);
  return token;
}

export async function getPending(env, token) {
  const b = backend(env);
  if (!b || !token) return null;
  const [raw] = await pipeline(b, [['GET', K.pend(String(token))]]);
  return parse(raw, null);
}

export async function dropPending(env, token) {
  const b = backend(env);
  if (!b) return;
  await pipeline(b, [['DEL', K.pend(String(token))]]);
}

export async function readLinkCode(env, code) {
  const b = backend(env);
  if (!b) return null;
  const [raw] = await pipeline(b, [['GET', K.link(code)]]);
  return parse(raw, null);
}

export async function dropLinkCode(env, code) {
  const b = backend(env);
  if (!b) return;
  await pipeline(b, [['DEL', K.link(code)]]);
}

export async function apiKeys(env, acct) {
  const b = backend(env);
  if (!b) return [];
  const [raw] = await pipeline(b, [['GET', K.keys(await follow(env, acct))]]);
  const list = parse(raw, []);
  return Array.isArray(list) ? list : [];
}

export { DAY };
