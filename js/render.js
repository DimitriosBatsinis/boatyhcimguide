// Inline wikitext -> safe HTML, plus the step-text decorations
// (quest/diary tags, dialogue choices, NOTE/WARNING labels, Withdraw lines).

const WIKI = 'https://oldschool.runescape.wiki/w/';

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function wikiUrl(page) {
  const [title, frag] = page.split('#');
  const t = title.trim().replace(/ /g, '_');
  return WIKI + encodeURI(t).replace(/\?/g, '%3F') + (frag ? '#' + encodeURIComponent(frag.trim().replace(/ /g, '_')) : '');
}

export function inline(src, { decorate = true } = {}) {
  const slots = [];
  const put = html => `\u0000${slots.push(html) - 1}\u0000`;

  let s = src
    // drop any template we do not understand
    .replace(/\{\{[^{}]*\}\}/g, '')
    // [[Page|Label]] / [[Page]]
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, page, label) =>
      put(`<a href="${esc(wikiUrl(page))}" target="_blank" rel="noopener">${esc((label || page).replace(/_/g, ' '))}</a>`))
    // [https://url label]
    .replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, (_, url, label) =>
      put(`<a href="${esc(url)}" target="_blank" rel="noopener nofollow">${esc(label)}</a>`))
    // bare urls
    .replace(/https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/g, url =>
      put(`<a href="${esc(url)}" target="_blank" rel="noopener nofollow">${esc(shortUrl(url))}</a>`));

  s = esc(s)
    .replace(/'''(.+?)'''/g, '<strong>$1</strong>')
    .replace(/''(.+?)''/g, '<em>$1</em>');

  if (decorate) {
    s = s
      // leading labels
      .replace(/^(IMPORTANT WARNING|WARNING|IMPORTANT|NOTE|OPTIONAL|TIP)\s*:\s*/i,
        (_, l) => `<span class="lbl lbl-${l.toLowerCase().includes('warn') || l.toUpperCase() === 'IMPORTANT' ? 'warn' : l.toLowerCase() === 'optional' ? 'opt' : 'note'}">${l.toUpperCase()}</span> `)
      .replace(/^(Deposit All, then )?(Withdraw(?: and (?:equip|wear))?|Gear|Inventory)\s*:\s*/i,
        (_, pre, l) => `${pre ? pre : ''}<span class="lbl lbl-wd">${l}</span> `)
      // (8 Inventory slots)
      .replace(/\((\d+\+?)\s+Inventory\s+(?:slots?|spaces?|spots?)\)/gi,
        (_, n) => `<span class="inv" title="Inventory slots used">${n} slots</span>`)
      // dialogue choices like (2,1) or (3,1,2,2,1,1)
      .replace(/\((\d(?:\s*,\s*\d)*)\)/g,
        (_, d) => `<span class="dlg" title="Dialogue options">${d.replace(/\s+/g, '')}</span>`)
      // [Quest name] / [Diary] tags — but not our placeholders
      .replace(/\[([^\[\]\u0000]{2,80})\]/g, (_, t) => {
        const cls = /optional/i.test(t) ? 'tag tag-opt' : /diary/i.test(t) ? 'tag tag-diary' : 'tag';
        return `<span class="${cls}">${t.trim()}</span>`;
      });
  }

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    if (/youtu\.?be/.test(u.hostname)) return 'video link';
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? '/…' : '');
  } catch { return url; }
}

// Lines written in capitals are the guide shouting something important.
export function isShout(text) {
  const letters = text.replace(/\[\[[^\]]*\]\]|\[[^\]]*\]|\([^)]*\)/g, '').replace(/[^A-Za-z]/g, '');
  if (letters.length < 12) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.75;
}

export { esc };
