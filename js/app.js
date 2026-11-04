import { parseGuide, plainText } from './parser.js';
import { inline, isShout, esc } from './render.js';
import { createStore, reconcile, storageWorks, askPersistent, loadSettings, saveSettings } from './store.js';
import { loadLocalGuide, fetchNewerGuide, PAGE_URL } from './sync.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// The guides on offer. Variants are edit layers on top of B0aty's wiki page.
const GUIDES = [
  { id: 'b0aty', name: 'B0aty HCIM V3', overlay: null },
  { id: 'hcw', name: 'HC Worlds edition', overlay: 'guides/hardcore-worlds.json' },
];
const chosen = GUIDES.find(g => g.id === loadSettings().guide) || GUIDES[0];
const store = createStore(chosen.id);
let overlay = null;
const ui = {
  main: $('#main'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  list: $('#episodeList'),
  search: $('#search'),
};

let guide = null;       // parsed guide
let guideMeta = null;   // { revid, timestamp, fetched }
let view = { kind: 'loading' };
let lastCheck = 0;
let checking = false;
const expanded = new Set();   // finished banks the user opened by hand
const collapsed = new Set();  // unfinished banks the user folded by hand

// ---------------------------------------------------------------- boot

boot();

async function boot() {
  applySettings();
  bindGlobalEvents();
  if (!storageWorks()) $('#storageWarn').hidden = false;
  askPersistent();
  setupGuidePicker();
  try {
    if (chosen.overlay) {
      try {
        const res = await fetch(chosen.overlay, { cache: 'no-cache' });
        if (!res.ok) throw new Error(res.status);
        overlay = await res.json();
      } catch {
        toast(`Couldn't load the ${chosen.name}. Showing the original guide.`, { ms: 8000 });
      }
    }
    const local = await loadLocalGuide();
    useGuide(local, { initial: true });
  } catch (err) {
    ui.main.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
  checkForUpdates();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function useGuide(meta, { initial = false } = {}) {
  const parsed = parseGuide(meta.wikitext, overlay);
  linkParents(parsed);
  guide = parsed;
  guideMeta = { revid: meta.revid, timestamp: meta.timestamp, fetched: meta.fetched };
  if (overlay) {
    const applied = parsed.report.reduce((a, r) => a + r.hits.length, 0);
    const missing = parsed.report.filter(r => !r.hits.length).length;
    $('#changesCount').textContent = missing ? `${applied} · ${missing}!` : String(applied);
  }
  const result = reconcile(store, guide);
  renderSidebar();
  updateVersionInfo();
  if (initial) {
    route({ fromLoad: true });
  } else {
    const anchor = topVisibleStep();
    renderView();
    if (anchor && guide.byId.has(anchor)) scrollToStep(anchor, { behavior: 'instant', flash: false, block: 'start' });
  }
  updateTotals();
  return result;
}

// Give every step a .parent so ticking children can tick the parent.
function linkParents(g) {
  for (const ep of g.episodes) {
    for (const block of ep.blocks) {
      const stack = [];
      for (const step of block.steps) {
        while (stack.length && stack[stack.length - 1].depth >= step.depth) stack.pop();
        step.parent = stack[stack.length - 1] || null;
        stack.push(step);
      }
    }
  }
}

// ---------------------------------------------------------------- live sync

async function checkForUpdates({ manual = false } = {}) {
  if (!guideMeta || checking) return;
  if (!navigator.onLine) {
    setSyncStatus('offline');
    if (manual) toast("You're offline. Using the saved copy of the guide.");
    return;
  }
  checking = true;
  setSyncStatus('checking');
  try {
    const newer = await fetchNewerGuide(guideMeta.revid);
    lastCheck = Date.now();
    if (newer) {
      const before = guideMeta.timestamp;
      const r = useGuide(newer);
      const bits = [];
      if (r.reworded) bits.push(`${r.reworded} ticked step${r.reworded > 1 ? 's were' : ' was'} reworded (marked “edited”)`);
      if (r.lost) bits.push(`${r.lost} tick${r.lost > 1 ? 's' : ''} no longer match a step`);
      toast(`Guide updated from the wiki (${fmtDate(newer.timestamp)}).${bits.length ? ' ' + bits.join('; ') + '.' : ''}`, { ms: 8000 });
      if (before && new Date(newer.timestamp) < new Date(before)) { /* never happens; revid is monotonic */ }
    } else if (manual) {
      toast('You already have the latest version of the guide.');
    }
    setSyncStatus('ok');
  } catch (err) {
    setSyncStatus('error', err);
    if (manual) toast(`Couldn't reach the wiki: ${err.message}`);
  } finally {
    checking = false;
    updateVersionInfo();
  }
}

function setSyncStatus(state) {
  const el = $('#syncStatus');
  if (!guideMeta) return;
  const rev = `Guide revision ${fmtDate(guideMeta.timestamp)}`;
  const text = {
    checking: `${rev} · checking the wiki…`,
    ok: `${rev} · up to date`,
    offline: `${rev} · offline, using saved copy`,
    error: `${rev} · couldn't reach the wiki`,
  }[state] || rev;
  el.innerHTML = `${esc(text)}${state === 'checking' ? '' : ' · <button type="button" data-action="check">check now</button>'}`;
}

function updateVersionInfo() {
  if (!guideMeta) return;
  const ago = lastCheck ? `Last checked ${relTime(lastCheck)}.` : 'Not checked yet this visit.';
  $('#versionInfo').textContent = `Using the wiki revision from ${fmtDate(guideMeta.timestamp, true)} (#${guideMeta.revid}). ${ago} The site checks for edits each time you open it.`;
}

// ---------------------------------------------------------------- routing

function route({ fromLoad = false } = {}) {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (!hash) {
    if (fromLoad) return continueFromProgress({ quiet: true });
    view = { kind: 'episode', id: guide.episodes[0].id };
  } else if (hash === 'intro') {
    view = { kind: 'intro' };
  } else if (hash === 'changes' && overlay) {
    view = { kind: 'changes' };
  } else if (hash.startsWith('search=')) {
    const q = hash.slice(7);
    ui.search.value = q;
    view = { kind: 'search', q };
  } else {
    const block = guide.blocksById.get(hash);
    const ep = guide.episodes.find(e => e.id === hash) || (block && guide.episodes.find(e => e.id === block.episodeId));
    if (!ep) { view = { kind: 'episode', id: guide.episodes[0].id }; }
    else view = { kind: 'episode', id: ep.id, block: block?.id };
  }
  renderView();
  if (view.kind === 'episode') store.setView(view.id);
  if (view.block) {
    const el = document.getElementById(view.block);
    if (el) {
      if (el.classList.contains('collapsed')) toggleBank(el, true);
      el.scrollIntoView({ block: 'start' });
      pinScroll(el, 'start');
    }
  } else if (!fromLoad || hash) {
    scrollTo({ top: 0 });
  }
}

function go(hash) {
  if (location.hash.slice(1) === hash) route();
  else location.hash = hash;
}

// ---------------------------------------------------------------- rendering

function renderView() {
  closeDrawer();
  if (view.kind === 'intro') renderIntro();
  else if (view.kind === 'changes') renderChanges();
  else if (view.kind === 'search') renderSearch(view.q);
  else renderEpisode(view.id);
  markSidebarActive();
}

function renderEpisode(id) {
  const ep = guide.episodes.find(e => e.id === id) || guide.episodes[0];
  const idx = guide.episodes.indexOf(ep);
  const { eyebrow, name } = splitEpisodeTitle(ep);
  const prev = guide.episodes[idx - 1], next = guide.episodes[idx + 1];
  const html = [];
  html.push(`<header class="ep-head">
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h1>${esc(name)}</h1>
    <div class="ep-progress"><div class="bar"><i data-ep-bar></i></div><span data-ep-count></span></div>
  </header>`);
  if (overlay) {
    const n = ep.blocks.reduce((a, b) => a + b.items.filter(i => i.mods?.length).length, 0);
    html.push(`<div class="variant-banner"><span><strong>${esc(chosen.name)}.</strong> ${n ? `${n} step${n === 1 ? '' : 's'} in this episode ${n === 1 ? 'is' : 'are'} changed or flagged for Hardcore Worlds.` : 'No changes in this episode — this is B0aty\'s route as written.'}</span><a href="#changes">See all changes</a></div>`);
  }
  for (const block of ep.blocks) html.push(blockHtml(block));
  html.push(`<nav class="ep-nav">
    ${prev ? `<a class="prev" href="#${prev.id}"><small>← Previous</small>${esc(splitEpisodeTitle(prev).eyebrow)}</a>` : ''}
    ${next ? `<a class="next" href="#${next.id}"><small>Next →</small>${esc(splitEpisodeTitle(next).eyebrow)}</a>` : ''}
  </nav>`);
  ui.main.innerHTML = html.join('');
  ui.main.dataset.episode = ep.id;
  for (const img of $$('.shot img', ui.main)) img.addEventListener('error', () => img.closest('.shot').classList.add('broken'), { once: true });
  updateEpisodeHeader(ep);
  document.title = `${eyebrow} · HCIM V3 Checklist`;
}

function blockHtml(block) {
  const done = block.steps.filter(s => store.isDone(s.id)).length;
  const total = block.steps.length;
  const finished = total > 0 && done === total;
  const isCollapsed = finished ? (store.state.settings.collapseDone && !expanded.has(block.id)) : collapsed.has(block.id);
  const shots = block.images.map((url, i) =>
    `<button type="button" class="shot" data-src="${esc(url)}" aria-label="Enlarge screenshot ${i + 1} for ${esc(block.title)}"><img src="${esc(url)}" alt="Screenshot for ${esc(block.title)}" loading="lazy" decoding="async"></button>`).join('');
  const items = block.items.map(itemHtml).join('');
  const blockNote = block.note ? `<div class="mod-note mod-added bank-note"><b>HC WORLDS</b>${inline(block.note)}</div>` : '';
  return `<section class="bank${finished ? ' done' : ''}${isCollapsed ? ' collapsed' : ''}${block.added ? ' added-block' : ''}" id="${block.id}" data-block="${block.id}">
    <div class="bank-head">
      <button type="button" class="bank-toggle" aria-expanded="${!isCollapsed}">
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        <h2>${esc(block.title)}</h2>
        <span class="count">${done}/${total}</span>
      </button>
      <button type="button" class="icon-btn tick-all" title="${finished ? 'Untick this whole bank' : 'Tick this whole bank'}" aria-label="${finished ? 'Untick' : 'Tick'} all steps in ${esc(block.title)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 12 4 4 7-8M11 16l1 0M14 12l7-8"/></svg>
      </button>
    </div>
    ${blockNote ? `<div class="bank-notes">${blockNote}</div>` : ''}
    <div class="bank-body${block.images.length ? '' : ' no-img'}">
      ${shots ? `<div class="shots">${shots}</div>` : ''}
      <ul class="steps">${items}</ul>
    </div>
  </section>`;
}

function itemHtml(item) {
  if (item.kind === 'step') return stepHtml(item);
  if (item.kind === 'removed') return removedHtml(item);
  return `<li class="note">${inline(item.text)}${modNotes(item)}</li>`;
}

function removedHtml(item, extra = '') {
  const why = item.mods?.find(m => m.kind === 'removed')?.text;
  return `<li class="removed ${extra}"><span class="pill pill-warn">Removed</span> <span class="was">${inline(item.text, { decorate: false })}</span>${why ? `<span class="why">${inline(why, { decorate: false })}</span>` : ''}</li>`;
}

const MOD_LABEL = { warn: 'DANGER', tip: 'HC WORLDS', money: 'MONEY', changed: 'CHANGED', added: 'ADDED' };
function modNotes(item) {
  const mods = (item.mods || []).filter(m => m.kind !== 'removed' && (m.text || m.original));
  if (!mods.length) return '';
  return `<div class="mod-notes">${mods.map(m => `<div class="mod-note mod-${m.kind}"><b>${MOD_LABEL[m.kind]}</b>${m.text ? inline(m.text, { decorate: false }) : ''}${m.original ? `<span class="orig">B0aty's original: ${inline(m.original, { decorate: false })}</span>` : ''}</div>`).join('')}</div>`;
}

function modPills(item) {
  const kinds = new Set((item.mods || []).map(m => m.kind));
  let out = '';
  if (kinds.has('added')) out += '<span class="pill pill-added">Added</span>';
  if (kinds.has('changed')) out += '<span class="pill pill-changed">Changed</span>';
  return out;
}

function stepHtml(step, { mark } = {}) {
  const done = store.isDone(step.id);
  const old = store.state.changed[step.id];
  let text = inline(step.text);
  if (mark) text = highlight(text, mark);
  const edited = old ? `<button type="button" class="edited" data-dismiss="${step.id}" title="The wiki reworded this step after you ticked it. It used to say: ${esc(plainText(old))}. Click to dismiss.">edited</button>` : '';
  return `<li class="step d${step.depth}${done ? ' done' : ''}${isShout(step.text) ? ' shout' : ''}" data-id="${step.id}">
    <label><input type="checkbox"${done ? ' checked' : ''}><span class="txt">${text}${modPills(step)}${edited}</span></label>${modNotes(step)}
  </li>`;
}

function renderIntro() {
  const out = [];
  let inList = false;
  for (const item of guide.intro) {
    const kind = item.kind === 'removed' ? item.was : item.kind;
    const isLi = kind === 'bullet' || kind === 'step';
    if (isLi && !inList) { out.push('<ul>'); inList = true; }
    if (!isLi && inList) { out.push('</ul>'); inList = false; }
    const html = inline(item.text || '', { decorate: false });
    if (item.kind === 'removed') out.push(isLi ? removedHtml(item, 'intro-removed') : `<div class="removed intro-removed">${removedHtml(item).replace(/^<li[^>]*>|<\/li>$/g, '')}</div>`);
    else if (kind === 'heading') { if (item.level > 2) out.push(`<h2>${html}</h2>`); }
    else if (kind === 'image') out.push(`<img src="${esc(item.url)}" alt="" loading="lazy">`);
    else if (isLi) out.push(`<li>${html}${modNotes(item)}</li>`);
    else out.push(`<p>${html}</p>${modNotes(item)}`);
  }
  if (inList) out.push('</ul>');
  const body = out.join('\n');
  const variant = overlay ? `<div class="callout">
      <p><strong>${esc(overlay.name || chosen.name)}.</strong> ${inline(overlay.summary || '', { decorate: false })} <a href="#changes">See every change</a>.</p>
      ${(overlay.notes || []).map(n => `<p>${inline(n, { decorate: false })}</p>`).join('')}
    </div>` : '';
  const total = guide.steps.length;
  ui.main.innerHTML = `<article class="prose">
    <p class="eyebrow">About</p>
    <h1>${overlay ? `B0aty HCIM Guide V3 · ${esc(chosen.name)}` : 'B0aty HCIM Guide V3'}</h1>
    <div class="callout">
      <p><strong>How this checklist works.</strong> Every step from the wiki guide is a tickable box (${total.toLocaleString()} in total), grouped into episodes and banks just like the original.
      Ticks are saved in this browser automatically. Use <em>Continue</em> to jump back to where you left off.</p>
      <p>Each time you open the site it checks the <a href="${PAGE_URL}" target="_blank" rel="noopener">wiki page</a> for edits and pulls them in. If a step you already ticked gets reworded, it keeps its tick and shows an <span class="edited">edited</span> badge.</p>
      <p>Video-only episodes (16–26) are left out. Back up your progress from <em>Settings → Export backup</em> now and then. Each guide in the menu at the top keeps its own ticks.</p>
    </div>
    ${variant}
    ${body}
    <p><a class="btn primary" href="#${guide.episodes[0].id}">Start with Episode 1</a></p>
  </article>`;
  document.title = 'About · HCIM V3 Checklist';
}

function renderSearch(q) {
  const query = q.trim();
  if (!query) { view = { kind: 'episode', id: store.state.view || guide.episodes[0].id }; return renderView(); }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = guide.steps.filter(s => { const t = plainText(s.text).toLowerCase(); return words.every(w => t.includes(w)); });
  const shown = hits.slice(0, 200);
  const items = shown.map(step => {
    const block = guide.blocksById.get(step.blockId);
    const ep = guide.episodes.find(e => e.id === step.episodeId);
    return `<li class="where-wrap"><span class="where"><a href="#${block.id}" data-goto="${step.id}">${esc(splitEpisodeTitle(ep).eyebrow)} · ${esc(block.title)}</a></span>${stepHtml(step, { mark: words })}</li>`;
  }).join('');
  ui.main.innerHTML = `<header class="ep-head"><p class="eyebrow">Search</p>
    <h1>${hits.length.toLocaleString()} step${hits.length === 1 ? '' : 's'} matching “${esc(query)}”</h1>
    ${hits.length > shown.length ? `<p class="muted">Showing the first ${shown.length}. Add another word to narrow it down.</p>` : ''}</header>
    ${hits.length ? `<ul class="results">${items}</ul>` : '<p class="empty">No steps match. Try a quest, item or NPC name.</p>'}`;
  ui.main.dataset.episode = '';
  document.title = `Search · HCIM V3 Checklist`;
}

// Every edit of the active variant, grouped by where it lands, plus the ones that
// no longer match because B0aty rewrote the step they were attached to.
function renderChanges() {
  const report = guide.report || [];
  const missing = report.filter(r => !r.hits.length);
  const where = block => {
    if (!block) return { label: 'Guide introduction', href: '#intro', ep: '' };
    const ep = guide.episodes.find(e => e.id === block.episodeId);
    return { label: `${splitEpisodeTitle(ep).eyebrow} · ${block.title}`, href: `#${block.id}`, ep: ep.id };
  };
  const cards = [];
  for (const r of report) {
    for (const hit of r.hits) {
      const w = where(hit.block);
      const target = hit.item || hit.items[0];
      const stepId = (hit.item?.id) || hit.items.find(i => i.id)?.id;
      const what = hit.block && hit.items.length && !hit.item
        ? `New bank: <strong>${esc(hit.block.title)}</strong>`
        : hit.item ? `<span class="${hit.item.kind === 'removed' ? 'was' : ''}">${inline(hit.item.text, { decorate: false })}</span>` : '';
      const added = hit.item && hit.items.length ? `<div class="mod-notes">${hit.items.map(s => `<div class="mod-note mod-added"><b>ADDED</b>${inline(s.text, { decorate: false })}</div>`).join('')}</div>` : '';
      const notes = hit.item ? modNotes({ mods: (hit.item.mods || []).filter(m => m.kind !== 'added') }) : '';
      const why = hit.item?.kind === 'removed' ? `<div class="mod-notes"><div class="mod-note mod-warn"><b>REMOVED</b>${inline(r.edit.why || '', { decorate: false })}</div></div>` : '';
      const epObj = hit.block && guide.episodes.find(e => e.id === hit.block.episodeId);
      const bi = epObj ? epObj.blocks.indexOf(hit.block) : -1;
      const ii = hit.block ? hit.block.items.indexOf(target) : guide.intro.indexOf(target);
      cards.push({ order: bi * 1000 + ii, ep: w.ep, html: `<li class="change">
        <span class="where"><a href="${w.href}"${stepId ? ` data-goto="${stepId}"` : ''}>${esc(w.label)}</a></span>
        <span class="what">${what}</span>${why}${notes}${added}
      </li>` });
    }
  }
  // de-duplicate (an item with several edits shows all notes once)
  const seen = new Set();
  const unique = cards.filter(c => (seen.has(c.html) ? false : seen.add(c.html))).sort((a, b) => a.order - b.order);
  const groups = new Map();
  for (const c of unique) { if (!groups.has(c.ep)) groups.set(c.ep, []); groups.get(c.ep).push(c); }
  const order = ['', ...guide.episodes.map(e => e.id)];
  const sections = order.filter(id => groups.has(id)).map(id => {
    const ep = guide.episodes.find(e => e.id === id);
    const title = ep ? ep.title : 'Guide introduction';
    return `<h2>${esc(title)}</h2><ul class="results">${groups.get(id).map(c => c.html).join('')}</ul>`;
  }).join('');
  ui.main.innerHTML = `<article class="changes">
    <header class="ep-head"><p class="eyebrow">${esc(chosen.name)}</p><h1>What's changed from B0aty's guide</h1>
    <p class="muted">${unique.length} edits on top of the original. Everything else is B0aty's route as written, and it keeps updating from his wiki page.</p></header>
    ${missing.length ? `<div class="change missing"><strong>${missing.length} edit${missing.length === 1 ? '' : 's'} no longer match a step</strong>, probably because B0aty reworded it on the wiki. They are not applied:<div class="mod-notes" style="margin-top:6px">${missing.map(r => `<div class="mod-note mod-warn"><b>NOT APPLIED</b>${esc(r.edit.find || r.edit.addBlock?.title || '')}${r.edit.in ? ` (in ${esc(r.edit.in)})` : ''}</div>`).join('')}</div></div>` : ''}
    ${sections}
  </article>`;
  ui.main.dataset.episode = '';
  document.title = `What's changed · HCIM V3 Checklist`;
}

function setupGuidePicker() {
  const pick = $('#guidePick');
  pick.value = chosen.id;
  pick.addEventListener('change', () => {
    const next = GUIDES.find(g => g.id === pick.value);
    if (!next || next.id === chosen.id) return;
    store.flush();
    const s = loadSettings();
    s.guide = next.id;
    saveSettings(s);
    location.replace(location.pathname + location.search);
  });
  if (chosen.overlay) $('#changesLink').hidden = false;
}

function highlight(html, words) {
  // highlight only in text nodes, not inside tags
  const re = new RegExp(`(${words.map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return html.replace(/(^|>)([^<]+)/g, (_, a, t) => a + t.replace(re, '<mark>$1</mark>'));
}

function renderSidebar() {
  ui.list.innerHTML = guide.episodes.map(ep => {
    const { eyebrow, name } = splitEpisodeTitle(ep);
    const n = eyebrow.match(/\d+/)?.[0] || '•';
    return `<li data-ep="${ep.id}">
      <a class="ep-link" href="#${ep.id}" title="${esc(ep.title)}">
        <span class="ep-num">${n}</span>
        <span class="ep-name">${esc(name)}</span>
        <span class="ep-pct" data-pct></span>
        <span class="mini-bar"><i data-mini></i></span>
      </a>
      <div class="bank-chips" data-chips hidden></div>
    </li>`;
  }).join('');
}

function markSidebarActive() {
  const current = view.kind === 'episode' ? ui.main.dataset.episode : null;
  $('#introLink').classList.toggle('active', view.kind === 'intro');
  $('#changesLink').classList.toggle('active', view.kind === 'changes');
  for (const li of ui.list.children) {
    const active = li.dataset.ep === current;
    $('.ep-link', li).classList.toggle('active', active);
    const chips = $('[data-chips]', li);
    chips.hidden = !active;
    if (active) {
      const ep = guide.episodes.find(e => e.id === current);
      chips.innerHTML = ep.blocks.map(b => `<a class="chip" href="#${b.id}" data-chip="${b.id}" title="${esc(b.title)}">${esc(chipLabel(b.title))}</a>`).join('');
      updateChips(ep);
    }
  }
}

function chipLabel(title) {
  const m = title.match(/^Bank\s+(\S+)(\s*\(continued\))?$/i);
  if (m) return m[1] + (m[2] ? '+' : '');
  return title.replace(/\s*\(continued\)$/i, '+').slice(0, 14);
}

// ---------------------------------------------------------------- counts

function countDone(steps) {
  let n = 0;
  for (const s of steps) if (store.state.ticks[s.id]) n++;
  return n;
}

function updateTotals() {
  if (!guide) return;
  const total = guide.steps.length, done = countDone(guide.steps);
  const pct = total ? (done / total) * 100 : 0;
  $('#overallBar').style.width = pct + '%';
  $('#overallText').innerHTML = `<b>${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.floor(pct)}%</b><span class="desktop-only"> · ${done.toLocaleString()} / ${total.toLocaleString()} steps</span>`;
  $('#overall').title = `${done.toLocaleString()} of ${total.toLocaleString()} steps ticked`;
  for (const ep of guide.episodes) {
    const li = ui.list.querySelector(`[data-ep="${ep.id}"]`);
    if (!li) continue;
    const d = countDone(ep.steps), t = ep.steps.length;
    const p = t ? Math.floor((d / t) * 100) : 0;
    $('[data-pct]', li).textContent = d === 0 ? '' : `${p}%`;
    $('[data-mini]', li).style.width = (t ? (d / t) * 100 : 0) + '%';
    $('.ep-link', li).classList.toggle('complete', t > 0 && d === t);
  }
  $('#progressInfo').textContent = `${done.toLocaleString()} of ${total.toLocaleString()} steps ticked (${pct.toFixed(1)}%).`;
  const ep = guide.episodes.find(e => e.id === ui.main.dataset.episode);
  if (ep) { updateEpisodeHeader(ep); updateChips(ep); }
}

function updateEpisodeHeader(ep) {
  const d = countDone(ep.steps), t = ep.steps.length;
  const bar = $('[data-ep-bar]', ui.main), c = $('[data-ep-count]', ui.main);
  if (bar) bar.style.width = (t ? (d / t) * 100 : 0) + '%';
  if (c) c.textContent = `${d} / ${t} steps`;
}

function updateChips(ep) {
  for (const b of ep.blocks) {
    const chip = ui.list.querySelector(`[data-chip="${b.id}"]`);
    if (!chip) continue;
    const d = countDone(b.steps);
    chip.classList.toggle('done', d === b.steps.length && d > 0);
    chip.classList.toggle('part', d > 0 && d < b.steps.length);
  }
}

function refreshBlock(blockId) {
  const block = guide.blocksById.get(blockId);
  const els = $$(`[data-block="${blockId}"]`, ui.main);
  for (const el of els) {
    const d = countDone(block.steps), t = block.steps.length;
    const finished = t > 0 && d === t;
    const wasDone = el.classList.contains('done');
    el.classList.toggle('done', finished);
    $('.count', el).textContent = `${d}/${t}`;
    const ta = $('.tick-all', el);
    ta.title = finished ? 'Untick this whole bank' : 'Tick this whole bank';
    if (finished && !wasDone && store.state.settings.collapseDone && !expanded.has(blockId)) {
      setTimeout(() => {
        if (!el.classList.contains('done')) return;
        const keepCursor = el.contains($('.step.cursor', ui.main));
        toggleBank(el, false);
        if (keepCursor) moveCursor(1, { from: el });
        // keep the next bank in view when the finished one folds away
        if (el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
      }, 450);
    }
  }
}

function syncStepEls(steps) {
  for (const step of steps) {
    const done = store.isDone(step.id);
    for (const li of $$(`.step[data-id="${step.id}"]`, ui.main)) {
      li.classList.toggle('done', done);
      $('input', li).checked = done;
      if (!done) $('.edited', li)?.remove();
    }
  }
}

// ---------------------------------------------------------------- ticking

function setStep(step, done) {
  const pending = new Map();
  pending.set(step.id, [step, done]);
  for (const c of step.children) pending.set(c.id, [c, done]);
  const isDone = s => pending.has(s.id) ? pending.get(s.id)[1] : store.isDone(s.id);
  for (let p = step.parent; p; p = p.parent) {
    const all = p.children.every(isDone);
    if (all !== isDone(p)) pending.set(p.id, [p, all]);
  }
  const changes = [...pending.values()].filter(([s, d]) => store.isDone(s.id) !== d).map(([s, d]) => ({ step: s, done: d }));
  store.apply(changes);
}

function setBlock(block, done) {
  const changes = block.steps.filter(s => store.isDone(s.id) !== done).map(s => ({ step: s, done }));
  if (!changes.length) return;
  store.apply(changes);
  toast(`${done ? 'Ticked' : 'Unticked'} ${changes.length} step${changes.length > 1 ? 's' : ''} in ${block.title}.`, { action: 'Undo', onAction: () => store.undo() });
}

store.onChange(changes => {
  const steps = changes.map(c => c.step);
  syncStepEls(steps);
  for (const id of new Set(steps.map(s => s.blockId))) refreshBlock(id);
  updateTotals();
});

// ---------------------------------------------------------------- continue / navigation

function furthestTick() {
  let max = -1;
  for (const s of guide.steps) if (s.index > max && store.state.ticks[s.id]) max = s.index;
  return max;
}

function continueFromProgress({ quiet = false } = {}) {
  const from = furthestTick();
  const next = guide.steps.find(s => s.index > from && !store.isDone(s.id));
  if (!next) {
    view = { kind: 'episode', id: guide.episodes[guide.episodes.length - 1].id };
    renderView();
    if (!quiet) toast('Every step after your furthest tick is done. Nice.');
    return;
  }
  openStep(next, { flash: !quiet || from >= 0 });
}

function firstUnticked() {
  const s = guide.steps.find(s => !store.isDone(s.id));
  if (!s) return toast('Everything is ticked!');
  openStep(s);
}

function openStep(step, { flash = true } = {}) {
  let fresh = false;
  if (view.kind !== 'episode' || ui.main.dataset.episode !== step.episodeId) {
    history.replaceState(null, '', '#' + step.episodeId);
    view = { kind: 'episode', id: step.episodeId };
    renderView();
    store.setView(step.episodeId);
    fresh = true;
  }
  scrollToStep(step.id, { flash, behavior: fresh ? 'instant' : 'smooth' });
}

function scrollToStep(id, { flash = true, behavior = 'smooth', block = 'center' } = {}) {
  const li = ui.main.querySelector(`.step[data-id="${id}"]`);
  if (!li) return;
  const bank = li.closest('.bank');
  if (bank?.classList.contains('collapsed')) toggleBank(bank, true);
  setCursor(li);
  requestAnimationFrame(() => {
    li.scrollIntoView({ block, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : behavior });
    if (flash) { li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); }
    pinScroll(li, block);
  });
}

// Screenshots load lazily and push content down. For a moment after a jump,
// keep the target in place as they arrive, unless the user starts scrolling.
let unpin = null;
function pinScroll(li, block) {
  unpin?.();
  const onLoad = e => { if (e.target.tagName === 'IMG') li.scrollIntoView({ block, behavior: 'instant' }); };
  const stop = () => unpin?.();
  ui.main.addEventListener('load', onLoad, true);
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) addEventListener(ev, stop, { passive: true, once: true });
  const timer = setTimeout(stop, 2500);
  unpin = () => {
    ui.main.removeEventListener('load', onLoad, true);
    for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) removeEventListener(ev, stop);
    clearTimeout(timer);
    unpin = null;
  };
}

function topVisibleStep() {
  for (const li of $$('.step', ui.main)) {
    const r = li.getBoundingClientRect();
    if (r.bottom > 70 && r.height) return li.dataset.id;
  }
  return null;
}

function toggleBank(el, open) {
  const id = el.dataset.block;
  const willOpen = open ?? el.classList.contains('collapsed');
  el.classList.toggle('collapsed', !willOpen);
  $('.bank-toggle', el).setAttribute('aria-expanded', String(willOpen));
  const finished = el.classList.contains('done');
  if (finished) { willOpen ? expanded.add(id) : expanded.delete(id); }
  else { willOpen ? collapsed.delete(id) : collapsed.add(id); }
}

function setCursor(li) {
  $$('.step.cursor', ui.main).forEach(x => x.classList.remove('cursor'));
  if (li) li.classList.add('cursor');
}

function visibleSteps() {
  return $$('.step', ui.main).filter(li => li.offsetParent !== null);
}

function moveCursor(dir, { from } = {}) {
  const list = visibleSteps();
  if (!list.length) return;
  const cur = $('.step.cursor', ui.main);
  let i = cur ? list.indexOf(cur) : -1;
  if (i < 0 && from) {
    // first visible step after the given element
    i = list.findIndex(li => from.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING) - 1;
  }
  if (i < 0 && !cur) {
    const top = list.findIndex(li => li.getBoundingClientRect().bottom > 70);
    i = top < 0 ? 0 : top - (dir > 0 ? 1 : 0);
  }
  const next = list[Math.max(0, Math.min(list.length - 1, i + dir))];
  setCursor(next);
  next.scrollIntoView({ block: 'nearest' });
}

function stepFromEl(li) { return guide.byId.get(li.dataset.id); }

// ---------------------------------------------------------------- events

function bindGlobalEvents() {
  addEventListener('hashchange', () => route());

  ui.main.addEventListener('change', e => {
    const input = e.target.closest('.step input');
    if (!input) return;
    const li = input.closest('.step');
    setCursor(li);
    setStep(stepFromEl(li), input.checked);
  });

  ui.main.addEventListener('click', e => {
    const t = e.target;
    const dismiss = t.closest('[data-dismiss]');
    if (dismiss) { e.preventDefault(); store.dismissChanged(dismiss.dataset.dismiss); dismiss.remove(); return; }
    const toggle = t.closest('.bank-toggle');
    if (toggle) { toggleBank(toggle.closest('.bank')); return; }
    const all = t.closest('.tick-all');
    if (all) {
      const block = guide.blocksById.get(all.closest('.bank').dataset.block);
      setBlock(block, !block.steps.every(s => store.isDone(s.id)));
      return;
    }
    const shot = t.closest('.shot');
    if (shot) { openLightbox(shot.dataset.src); return; }
    const gotoLink = t.closest('[data-goto]');
    if (gotoLink) { e.preventDefault(); ui.search.value = ''; openStep(guide.byId.get(gotoLink.dataset.goto)); return; }
  });

  $('#continueBtn').addEventListener('click', () => continueFromProgress());
  $('#menuBtn').addEventListener('click', () => (ui.sidebar.classList.contains('open') ? closeDrawer() : openDrawer()));
  ui.scrim.addEventListener('click', closeDrawer);
  ui.list.addEventListener('click', e => { if (e.target.closest('a')) closeDrawer(); });
  $('#introLink').addEventListener('click', closeDrawer);
  $('#syncStatus').addEventListener('click', e => { if (e.target.closest('[data-action="check"]')) checkForUpdates({ manual: true }); });

  let searchTimer;
  ui.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = ui.search.value;
      if (q.trim()) { history.replaceState(null, '', '#search=' + encodeURIComponent(q)); view = { kind: 'search', q }; renderSearch(q); markSidebarActive(); }
      else { history.replaceState(null, '', '#' + (store.state.view || guide.episodes[0].id)); route(); }
    }, 160);
  });
  ui.search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { ui.search.value = ''; ui.search.dispatchEvent(new Event('input')); ui.search.blur(); }
    if (e.key === 'Enter') { closeDrawer(); ui.search.blur(); }
  });

  // settings
  const dlg = $('#settings');
  $('#settingsBtn').addEventListener('click', () => { updateVersionInfo(); updateTotals(); dlg.showModal(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  $('#setCollapse').addEventListener('change', e => { store.setSetting('collapseDone', e.target.checked); expanded.clear(); if (view.kind === 'episode') rerenderKeepingPlace(); });
  $('#setImages').addEventListener('change', e => { store.setSetting('images', e.target.checked); applySettings(); });
  for (const r of $$('input[name="theme"]')) r.addEventListener('change', e => { store.setSetting('theme', e.target.value); applySettings(); });
  $('#checkNow').addEventListener('click', () => checkForUpdates({ manual: true }));
  $('#firstUnticked').addEventListener('click', () => { dlg.close(); firstUnticked(); });
  $('#exportBtn').addEventListener('click', exportProgress);
  $('#importFile').addEventListener('change', importProgress);
  const reset = $('#resetBtn');
  reset.addEventListener('click', () => {
    if (!reset.classList.contains('armed')) {
      reset.classList.add('armed'); reset.textContent = 'Click again to wipe all ticks';
      setTimeout(() => { reset.classList.remove('armed'); reset.textContent = 'Reset…'; }, 4000);
      return;
    }
    const n = store.reset();
    reset.classList.remove('armed'); reset.textContent = 'Reset…';
    dlg.close();
    renderView(); updateTotals();
    toast(`Cleared ${n} ticks.`);
  });
  $('#wikiLink').href = PAGE_URL;
  $('#creditLink').href = PAGE_URL;

  $('#lightbox').addEventListener('click', () => $('#lightbox').close());

  // keyboard
  addEventListener('keydown', e => {
    const target = e.target instanceof Element ? e.target : document.body;
    if (target.closest('input[type="search"], input[type="text"], textarea') || e.altKey || e.metaKey) return;
    if (document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey && e.key.toLowerCase() === 'z')) {
      e.preventDefault();
      if (store.undo()) toast('Undone.'); else toast('Nothing to undo.');
      return;
    }
    if (e.ctrlKey) return;
    const key = e.key;
    if (key === '/') { e.preventDefault(); openDrawer({ focusSearch: true }); return; }
    if (key === 'j' || key === 'ArrowDown' && e.shiftKey) { e.preventDefault(); moveCursor(1); return; }
    if (key === 'k' || key === 'ArrowUp' && e.shiftKey) { e.preventDefault(); moveCursor(-1); return; }
    if (key === 'c') { continueFromProgress(); return; }
    if (key === '[' || key === ']') { stepEpisode(key === ']' ? 1 : -1); return; }
    if (key === 'x' || (key === ' ' && $('.step.cursor', ui.main) && !target.closest('button, a, input'))) {
      const li = $('.step.cursor', ui.main);
      if (!li) return;
      e.preventDefault();
      const step = stepFromEl(li);
      setStep(step, !store.isDone(step.id));
      if (store.isDone(step.id)) moveCursor(1);
    }
  });

  addEventListener('online', () => checkForUpdates());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 30 * 60 * 1000) checkForUpdates();
  });
}

function stepEpisode(dir) {
  const i = guide.episodes.findIndex(e => e.id === ui.main.dataset.episode);
  const next = guide.episodes[(i < 0 ? 0 : i) + dir];
  if (next) go(next.id);
}

function rerenderKeepingPlace() {
  const anchor = topVisibleStep();
  renderView();
  if (anchor) scrollToStep(anchor, { behavior: 'instant', flash: false, block: 'start' });
}

function openDrawer({ focusSearch = false } = {}) {
  if (matchMedia('(max-width: 860px)').matches) {
    ui.sidebar.classList.add('open');
    ui.scrim.hidden = false;
    $('#menuBtn').setAttribute('aria-expanded', 'true');
  }
  if (focusSearch) setTimeout(() => ui.search.focus(), 50);
}
function closeDrawer() {
  ui.sidebar.classList.remove('open');
  ui.scrim.hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
}

function openLightbox(src) {
  const dlg = $('#lightbox');
  $('img', dlg).src = src;
  dlg.showModal();
}

function applySettings() {
  const s = store.state.settings;
  document.documentElement.classList.toggle('no-images', !s.images);
  if (s.theme === 'light' || s.theme === 'dark') document.documentElement.dataset.theme = s.theme;
  else delete document.documentElement.dataset.theme;
  $('#setCollapse').checked = s.collapseDone;
  $('#setImages').checked = s.images;
  for (const r of $$('input[name="theme"]')) r.checked = r.value === s.theme;
}

function exportProgress() {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hcim-v3-progress-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importProgress(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const from = store.importJson(await file.text());
    const r = reconcile(store, guide);
    $('#settings').close();
    renderView(); updateTotals();
    const other = from !== chosen.id ? ` (the backup was from ${GUIDES.find(g => g.id === from)?.name || 'another guide'})` : '';
    toast(`Imported ${countDone(guide.steps).toLocaleString()} ticks into ${chosen.name}${other}.${r.lost ? ` ${r.lost} couldn't be matched to this guide.` : ''}`, { ms: 7000 });
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- toast

let toastTimer;
function toast(text, { action, onAction, ms = 4500 } = {}) {
  const el = $('#toast'), btn = $('#toastAction');
  $('#toastText').textContent = text;
  btn.hidden = !action;
  if (action) {
    btn.textContent = action;
    btn.onclick = () => { onAction?.(); el.hidden = true; };
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------------------------------------------------------------- utils

function splitEpisodeTitle(ep) {
  const m = ep.title.match(/^(Episode\s+\d+)\s*[-–:]\s*(.+)$/i);
  return m ? { eyebrow: m[1], name: m[2] } : { eyebrow: ep.title, name: ep.title };
}

function fmtDate(iso, long = false) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, long ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
