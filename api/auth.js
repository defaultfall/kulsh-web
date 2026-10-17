// api/auth.js — вход через Google / GitHub (OAuth 2.0) и Telegram (Login Widget).
// Маршруты (см. rewrites в vercel.json):
//   GET  /api/auth/me                  → { user, providers, telegramBotId }
//   GET  /api/auth/start/:provider     → редирект на Google / GitHub
//   GET  /api/auth/callback/:provider  → обмен code на профиль, выдача сессии
//   POST /api/auth/telegram            → проверка подписи Telegram, выдача сессии
//   POST /api/auth/logout              → удаление сессии
import { signSession, readSession, setCookie, getCookie, SESSION_COOKIE } from './_session.js';
import { dropLinkCode, dropPending, getPending, normIdentity, putPending, readLinkCode, resolveIdentity } from './_accounts.js';

export const config = { runtime: 'edge' };

const STATE_COOKIE = 'kulsh_oauth_state';
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function origin(req, env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/+$/, '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// Куда вернуть пользователя после входа. Принимаем только локальные пути.
function safeNext(raw) {
  const s = String(raw || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return '';
  if (!/^\/[\x20-\x7E]*$/.test(s)) return '';
  return s.slice(0, 300);
}
// Добавляет параметр к пути, сохраняя query и hash.
function withParam(path, key, value) {
  const [base, hash] = String(path).split('#');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${key}=${encodeURIComponent(value)}${hash ? '#' + hash : ''}`;
}

const PROVIDERS = {
  google: {
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    extra: { scope: 'openid profile email', prompt: 'select_account' },
    async profile(code, redirect, id, secret) {
      const t = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
      }).then((r) => r.json());
      if (!t.access_token) throw new Error('google_token');
      const u = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${t.access_token}` },
      }).then((r) => r.json());
      if (!u.sub) throw new Error('google_profile');
      // handle: для Google показываем e-mail, для остальных — @username.
      return { id: `google:${u.sub}`, name: u.name || 'Google user', avatar: u.picture || '', provider: 'google', handle: u.email || '' };
    },
  },
  github: {
    env: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    authUrl: 'https://github.com/login/oauth/authorize',
    extra: { scope: 'read:user' },
    async profile(code, redirect, id, secret) {
      const t = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, client_id: id, client_secret: secret, redirect_uri: redirect }),
      }).then((r) => r.json());
      if (!t.access_token) throw new Error('github_token');
      const u = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'kulshgpt', Accept: 'application/vnd.github+json' },
      }).then((r) => r.json());
      if (!u.id) throw new Error('github_profile');
      return { id: `github:${u.id}`, name: u.name || u.login, avatar: u.avatar_url || '', provider: 'github', handle: u.login ? `@${u.login}` : '' };
    },
  },
};

const creds = (p, env) => PROVIDERS[p].env.map((k) => (env[k] || '').trim());
const isOn = (p, env) => !!env.AUTH_SECRET && creds(p, env).every(Boolean);
const tgOn = (env) => !!env.AUTH_SECRET && !!(env.TELEGRAM_BOT_TOKEN || '').includes(':');

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

function redirect(to, cookies = []) {
  const h = new Headers({ Location: to, 'Cache-Control': 'no-store' });
  cookies.forEach((c) => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
}

async function verifyTelegram(data, token) {
  const { hash, ...rest } = data || {};
  if (!hash || !rest.id || !rest.auth_date) return false;
  if (Date.now() / 1000 - Number(rest.auth_date) > 86400) return false;
  const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = await crypto.subtle.digest('SHA-256', enc.encode(token));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(check)));
  if (sig.length !== String(hash).length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ String(hash).charCodeAt(i);
  return diff === 0;
}

export default async function handler(req) {
  const env = process.env;
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || url.pathname.split('/')[3] || '';
  const provider = url.searchParams.get('provider') || url.pathname.split('/')[4] || '';

  if (action === 'me') {
    return json({
      user: await readSession(req, env),
      providers: { google: isOn('google', env), github: isOn('github', env), telegram: tgOn(env) },
      telegramBotId: tgOn(env) ? env.TELEGRAM_BOT_TOKEN.split(':')[0] : null,
    });
  }

  if (action === 'logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', { maxAge: 0, req }) });
  }

  if (action === 'telegram' && req.method === 'POST') {
    if (!tgOn(env)) return json({ error: 'telegram_off' }, 400);
    let data; try { data = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    // Режим привязки — наш собственный флаг, в подпись Telegram он не входит.
    const mode = data && data.mode === 'link' ? 'link' : '';
    if (data) delete data.mode;
    if (!(await verifyTelegram(data, env.TELEGRAM_BOT_TOKEN.trim()))) return json({ error: 'bad_signature' }, 401);
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username || 'Telegram user';
    const identity = `tg:${data.id}`;
    if (mode === 'link') {
      const current = await readSession(req, env);
      if (!current || !current.id) return json({ error: 'auth_required' }, 401);
      const pending = await putPending(env, {
        kind: 'link', identity, acct: normIdentity(current.id),
        profile: { name, avatar: data.photo_url || '', handle: data.username ? `@${data.username}` : '' },
      });
      return json({ pending });
    }
    const acct = await resolveIdentity(env, identity, {
      name, avatar: data.photo_url || '', handle: data.username ? `@${data.username}` : '',
    });
    const user = { id: acct, name, avatar: data.photo_url || '', provider: 'telegram', handle: data.username ? `@${data.username}` : '', identity };
    return json({ user }, 200, { 'Set-Cookie': setCookie(SESSION_COOKIE, await signSession(user, env.AUTH_SECRET), { req }) });
  }

  // Привязка Telegram через код из бота: код создаёт бот командой «привязать аккаунт».
  // Так работает и там, где виджет Telegram не может доставить подтверждение.
  if (action === 'telegram_code' && req.method === 'POST') {
    if (!env.AUTH_SECRET) return json({ error: 'auth_off' }, 400);
    let data; try { data = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const code = String(data.code || '').trim().toUpperCase();
    if (!code) return json({ error: 'no_code' }, 400);
    const link = await readLinkCode(env, code);
    if (!link || !link.identity) return json({ error: 'bad_code' }, 400);
    const platform = String(link.platform || '');
    if (platform !== 'tg' && platform !== 'telegram') return json({ error: 'bad_code' }, 400);
    const name = String(link.name || (platform === 'tg' ? 'Telegram' : 'Telegram'));
    const identity = String(link.identity);
    const token = await putPending(env, {
      kind: 'login', identity, profile: { name }, code,
    });
    return json({
      ok: true,
      token,
      identity,
      name,
    });
  }

  if (action === 'telegram_code_confirm' && req.method === 'POST') {
    if (!env.AUTH_SECRET) return json({ error: 'auth_off' }, 400);
    let data; try { data = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const token = String(data.token || '');
    const pending = await getPending(env, token);
    if (!pending || !pending.identity) return json({ error: 'expired' }, 400);
    const identity = String(pending.identity);
    const acct = await resolveIdentity(env, identity, pending.profile || {});
    await dropPending(env, token);
    if (pending.code) await dropLinkCode(env, pending.code);
    const provider = identity.split(':', 1)[0] === 'ds' ? 'discord' : 'telegram';
    const user = {
      id: acct,
      name: (pending.profile && pending.profile.name) || 'Telegram',
      avatar: '',
      provider,
      handle: '',
    };
    return json({ user }, 200, { 'Set-Cookie': setCookie(SESSION_COOKIE, await signSession(user, env.AUTH_SECRET), { req }) });
  }

  const P = PROVIDERS[provider];
  const nextFromQuery = safeNext(url.searchParams.get('next'));
  if (!P || !isOn(provider, env)) return redirect(withParam(nextFromQuery || '/', 'auth_error', 'provider_off'));
  const [clientId, clientSecret] = creds(provider, env);
  const redirectUri = `${origin(req, env)}/api/auth/callback/${provider}`;

  if (action === 'start') {
    const state = b64rand();
    const mode = url.searchParams.get('mode') === 'link' ? 'link' : '';
    let acct = '';
    if (mode === 'link') {
      const current = await readSession(req, env);
      if (!current || !current.id) {
        return redirect(withParam(nextFromQuery || '/', 'auth_error', 'login_required'));
      }
      acct = normIdentity(current.id);
    }
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, ...P.extra });
    // next и режим храним вместе со state: callback должен знать, куда вернуть человека.
    const cookie = `${state}|${encodeURIComponent(nextFromQuery)}|${mode}|${encodeURIComponent(acct)}`;
    return redirect(`${P.authUrl}?${q}`, [setCookie(STATE_COOKIE, cookie, { maxAge: 600, req })]);
  }

  if (action === 'callback') {
    const clear = setCookie(STATE_COOKIE, '', { maxAge: 0, req });
    const parts = (getCookie(req, STATE_COOKIE) || '').split('|');
    const cookieState = parts[0] || '';
    let next = '';
    let mode = '';
    let acct = '';
    try { next = safeNext(decodeURIComponent(parts[1] || '')); } catch { next = ''; }
    mode = parts[2] === 'link' ? 'link' : '';
    try { acct = decodeURIComponent(parts[3] || ''); } catch { acct = ''; }
    const code = url.searchParams.get('code');
    if (!code || !url.searchParams.get('state') || url.searchParams.get('state') !== cookieState) {
      return redirect(withParam(next || '/', 'auth_error', 'state'), [clear]);
    }
    try {
      const user = await P.profile(code, redirectUri, clientId, clientSecret);
      if (mode === 'link') {
        if (!acct) return redirect(withParam(next || '/', 'auth_error', 'login_required'), [clear]);
        const token = await putPending(env, {
          kind: 'link', identity: user.id, acct,
          profile: { name: user.name, avatar: user.avatar, handle: user.handle },
        });
        return redirect(withParam(next || '/', 'link', token), [clear]);
      }
      const accountId = await resolveIdentity(env, user.id, {
        name: user.name, avatar: user.avatar, handle: user.handle,
      });
      const session = { ...user, id: accountId, identity: user.id };
      return redirect(next || '/', [clear, setCookie(SESSION_COOKIE, await signSession(session, env.AUTH_SECRET), { req })]);
    } catch (e) {
      return redirect(withParam(next || '/', 'auth_error', e.message || 'failed'), [clear]);
    }
  }

  return json({ error: 'not_found' }, 404);
}

function b64rand() {
  const a = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
