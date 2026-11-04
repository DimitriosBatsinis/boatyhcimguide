// Live sync with the OSRS Wiki. The MediaWiki API allows anonymous cross-origin
// reads when the request carries origin=*, so a static GitHub Pages site can use it.

import { guideCache } from './store.js';

const API = 'https://oldschool.runescape.wiki/api.php';
const PAGE = 'Guide:B0aty_HCIM_Guide_V3';
export const PAGE_URL = 'https://oldschool.runescape.wiki/w/' + PAGE;

async function getJson(params, timeoutMs = 15000) {
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`Wiki answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// The newest copy we have without asking the wiki: browser cache or the bundled snapshot.
export async function loadLocalGuide() {
  const cached = guideCache.get();
  let bundled = null;
  try {
    const res = await fetch('data/guide.json', { cache: 'no-cache' });
    if (res.ok) bundled = await res.json();
  } catch { /* offline and no service worker yet */ }
  const pick = [cached, bundled].filter(g => g && g.wikitext).sort((a, b) => b.revid - a.revid)[0];
  if (!pick) throw new Error('Could not load the guide. Check your connection and reload.');
  return pick;
}

export async function latestRevision() {
  const j = await getJson({ action: 'query', prop: 'revisions', titles: PAGE, rvprop: 'ids|timestamp' });
  const rev = j?.query?.pages?.[0]?.revisions?.[0];
  if (!rev) throw new Error('Unexpected answer from the wiki.');
  return { revid: rev.revid, timestamp: rev.timestamp };
}

// Returns a newer guide { revid, timestamp, wikitext } or null if current is up to date.
export async function fetchNewerGuide(currentRevid) {
  const latest = await latestRevision();
  if (latest.revid <= currentRevid) return null;
  const j = await getJson({ action: 'parse', page: PAGE, prop: 'wikitext|revid' }, 30000);
  const wikitext = j?.parse?.wikitext;
  if (!wikitext) throw new Error('The wiki did not return the guide text.');
  const guide = { revid: j.parse.revid || latest.revid, timestamp: latest.timestamp, fetched: new Date().toISOString(), wikitext };
  guideCache.set(guide);
  return guide;
}
