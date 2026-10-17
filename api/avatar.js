// api/avatar.js — аватар Telegram-пользователя через Bot API.
// Токен бота остаётся на сервере: браузер получает только картинку.
//   GET /api/avatar?id=<telegram user id>
export const config = { runtime: 'edge' };

const notFound = () => new Response('', { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } });

export default async function handler(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('', { status: 405 });
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!/^\d{3,20}$/.test(id)) return notFound();

  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token || !token.includes(':')) return notFound();

  try {
    const api = `https://api.telegram.org/bot${token}`;
    const pr = await fetch(`${api}/getUserProfilePhotos?user_id=${id}&limit=1`, {
      headers: { 'User-Agent': 'KulshAvatar/1.0' },
    });
    if (!pr.ok) return notFound();
    const pj = await pr.json();
    const photos = pj && pj.ok && pj.result && pj.result.photos;
    if (!photos || !photos.length || !photos[0].length) return notFound();
    const sizes = photos[0];
    const fileId = sizes[sizes.length - 1].file_id;

    const fr = await fetch(`${api}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      headers: { 'User-Agent': 'KulshAvatar/1.0' },
    });
    if (!fr.ok) return notFound();
    const fj = await fr.json();
    const filePath = fj && fj.ok && fj.result && fj.result.file_path;
    if (!filePath) return notFound();

    const ir = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      headers: { 'User-Agent': 'KulshAvatar/1.0' },
    });
    if (!ir.ok || !ir.body) return notFound();

    return new Response(req.method === 'HEAD' ? null : ir.body, {
      headers: {
        'Content-Type': ir.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      },
    });
  } catch {
    return notFound();
  }
}
