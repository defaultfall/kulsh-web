// api/chat.js — эндпоинт веб-чата (Vercel Edge Function).
// Аутентификация: подписанная cookie-сессия; без неё — гость с урезанными правами.
// Вся логика стриминга живёт в api/_chat-core.js (общая с публичным API).
import { readSession } from './_session.js';
import { runChat } from './_chat-core.js';
import { normIdentity } from './_accounts.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const user = await readSession(req);
  if (user && user.id) user.id = normIdentity(user.id);
  return runChat(req, { user });
}
