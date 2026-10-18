// api/_search.js — веб-поиск без внешних ключей: DuckDuckGo + Wikipedia.
// Тот же принцип, что в боте: сначала DDG, при нехватке результатов — Wikipedia.

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function unwrap(url) {
  let u = String(url || '');
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.includes('duckduckgo.com/l/')) {
    try {
      const q = new URL(u).searchParams.get('uddg');
      if (q) u = decodeURIComponent(q);
    } catch { /* ignore */ }
  }
  return u;
}

async function fetchText(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function ddg(query, max) {
  const out = [];
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'ru,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const body = 'q=' + encodeURIComponent(query);
  const endpoints = [
    'https://lite.duckduckgo.com/lite/',
    'https://html.duckduckgo.com/html/',
  ];
  for (const url of endpoints) {
    const page = await fetchText(url, { method: 'POST', headers, body });
    if (!page) continue;
    const lite = /<a\s+rel="nofollow"\s+href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<td\s+class="result-snippet">([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = lite.exec(page)) && out.length < max) {
      const href = unwrap(m[1]);
      const title = stripTags(decodeEntities(m[2]));
      const snippet = stripTags(decodeEntities(m[3]));
      if (href && title) out.push({ title, url: href, snippet });
    }
    if (!out.length) {
      const html = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = html.exec(page)) && out.length < max) {
        const href = unwrap(m[1]);
        const title = stripTags(decodeEntities(m[2]));
        const snippet = stripTags(decodeEntities(m[3]));
        if (href && title) out.push({ title, url: href, snippet });
      }
    }
    if (out.length) return out.slice(0, max);
  }
  return out;
}

async function wikipedia(query, max) {
  const u = 'https://ru.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1' +
    '&srlimit=' + max + '&srsearch=' + encodeURIComponent(query);
  const text = await fetchText(u, { headers: { 'User-Agent': UA } }, 8000);
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    const items = (data && data.query && data.query.search) || [];
    return items.slice(0, max).map((it) => ({
      title: String(it.title || ''),
      url: 'https://ru.wikipedia.org/wiki/' + encodeURIComponent(String(it.title || '').replace(/ /g, '_')),
      snippet: stripTags(it.snippet || ''),
    })).filter((r) => r.title && r.url);
  } catch {
    return [];
  }
}

export async function webSearch(query, maxResults = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  const ddgResults = await ddg(q, maxResults);
  if (ddgResults.length >= maxResults) return ddgResults.slice(0, maxResults);
  const wiki = await wikipedia(q, maxResults);
  const seen = new Set(ddgResults.map((r) => r.url));
  for (const r of wiki) {
    if (seen.has(r.url)) continue;
    ddgResults.push(r);
    seen.add(r.url);
    if (ddgResults.length >= maxResults) break;
  }
  return ddgResults.slice(0, maxResults);
}

export function formatSearchResults(results, maxChars = 4000) {
  const lines = [];
  (results || []).forEach((r, i) => {
    const title = String(r.title || '').trim();
    const url = String(r.url || '').trim();
    const snippet = String(r.snippet || '').trim();
    lines.push(`[${i + 1}] ${title}\nURL: ${url}\n${snippet}`);
  });
  return lines.join('\n\n').slice(0, maxChars);
}
