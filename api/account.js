// api/account.js — единый аккаунт Kulsh: привязки, баланс, usage, API-ключи.
//
//   GET  /api/account                    → { account, keys }
//   POST /api/account { action }         → см. обработчики ниже
//
// Привязка способа входа, у которого уже есть свой аккаунт, НЕ происходит молча:
// сначала отдаётся предпросмотр с суммами, затем link_confirm сливает аккаунты.
import { readSession, setCookie, signSession, SESSION_COOKIE } from './_session.js';
import {
  accountView, apiKeys, attachIdentity, deleteAccount, dropLinkCode, dropPending,
  getAccount, getPending, lookupIdentity, mergeAccounts, normIdentity, putPending,
  readBalance, readLinkCode, unlinkIdentity,
} from './_accounts.js';
import { redeemPromo } from './_promo.js';

export const config = { runtime: 'edge' };

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

const PROVIDER_LABEL = {
  google: 'Google', github: 'GitHub', telegram: 'Telegram', tg: 'Telegram', ds: 'Discord',
};

const publicKey = (k) => ({
  id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsed: k.lastUsed || 0,
});

async function preview(env, acct, identity, profile) {
  const current = await accountView(env, acct);
  if (current.identities.some((x) => x.identity === identity)) {
    return { status: 'already', provider: identity.split(':', 1)[0] };
  }
  const target = await lookupIdentity(env, identity);
  const provider = identity.split(':', 1)[0];
  if (!target || target === current.id) {
    return {
      status: 'confirm',
      merge: false,
      provider,
      incoming: { name: (profile && profile.name) || PROVIDER_LABEL[provider] || provider, balance: 0 },
      balances: { current: current.balance, incoming: 0, total: current.balance },
    };
  }
  const targetView = await accountView(env, target);
  const name = (profile && profile.name) || targetView.identities[0]?.name || PROVIDER_LABEL[provider] || provider;
  return {
    status: 'confirm',
    merge: true,
    provider,
    incoming: { name, balance: targetView.balance },
    balances: {
      current: current.balance,
      incoming: targetView.balance,
      total: current.balance + targetView.balance,
    },
  };
}

export default async function handler(req) {
  const env = process.env;
  const user = await readSession(req, env);
  if (!user || !user.id) return json({ error: 'auth_required' }, 401);
  const acct = normIdentity(user.id);

  if (req.method === 'GET') {
    const [account, keys] = await Promise.all([accountView(env, acct), apiKeys(env, acct)]);
    const tg = account.identities.find((x) => x.provider === 'tg');
    const topupTag = tg ? `ID${String(tg.identity).slice(3)}` : '';
    const topupUrl = env.DONATIONALERTS_PAGE || 'https://www.donationalerts.com/r/downfalls';
    return json({ account, keys: keys.map(publicKey), topup: { tag: topupTag, url: topupUrl } });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || '');

  if (action === 'link_code_preview' || action === 'link_token_preview') {
    let identity = '';
    let profile = {};
    let pendingToken = '';
    let code = '';
    if (action === 'link_code_preview') {
      code = String(body.code || '').trim().toUpperCase();
      const data = await readLinkCode(env, code);
      if (!data || !data.identity) return json({ error: 'bad_code' }, 400);
      identity = String(data.identity);
      profile = { name: data.name || PROVIDER_LABEL[String(data.platform || '')] || '' };
    } else {
      pendingToken = String(body.token || '');
      const data = await getPending(env, pendingToken);
      if (!data || !data.identity) return json({ error: 'bad_token' }, 400);
      if (String(data.acct || '') !== String(acct)) return json({ error: 'wrong_account' }, 403);
      identity = String(data.identity);
      profile = data.profile || {};
    }
    const info = await preview(env, acct, identity, profile);
    if (info.status === 'already') return json(info);
    const token = await putPending(env, {
      kind: 'link', identity, acct, profile, code,
    });
    return json({ ...info, token });
  }

  if (action === 'link_confirm') {
    const token = String(body.token || '');
    const data = await getPending(env, token);
    if (!data || !data.identity) return json({ error: 'expired' }, 400);
    if (String(data.acct || '') !== String(acct)) return json({ error: 'wrong_account' }, 403);
    const identity = String(data.identity);
    const target = await lookupIdentity(env, identity);
    let result;
    if (target && target !== data.acct) {
      result = await mergeAccounts(env, target, data.acct);
    } else {
      await attachIdentity(env, identity, data.acct, data.profile || {});
      result = { merged: false, balance: await readBalance(env, data.acct) };
    }
    await dropPending(env, token);
    if (data.code) await dropLinkCode(env, data.code);
    const account = await accountView(env, data.acct);
    return json({ ok: true, ...result, account });
  }

  if (action === 'unlink') {
    const identity = String(body.identity || '');
    const account = await getAccount(env, acct);
    const match = account.ids.find((x) => x === identity)
      || account.ids.find((x) => x.startsWith(`${body.provider}:`));
    if (!match) return json({ error: 'not_linked' }, 400);
    const result = await unlinkIdentity(env, acct, match);
    if (result.error === 'last') return json({ error: 'last_method' }, 400);
    if (result.error) return json({ error: result.error }, 400);
    const headers = {};
    if (result.newId) {
      const session = { ...user, id: result.newId };
      headers['Set-Cookie'] = setCookie(SESSION_COOKIE, await signSession(session, env.AUTH_SECRET), { req });
    }
    return json({ ok: true, account: await accountView(env, result.newId || acct) }, 200, headers);
  }

  if (action === 'promo') {
    const result = await redeemPromo(env, acct, body.code);
    if (result.error) return json({ error: result.error }, 400);
    return json({ ok: true, ...result, account: await accountView(env, acct) });
  }

  if (action === 'delete') {
    await deleteAccount(env, acct);
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', { maxAge: 0, req }) });
  }

  return json({ error: 'unknown_action' }, 400);
}
