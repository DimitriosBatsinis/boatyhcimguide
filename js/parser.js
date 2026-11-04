// Turns the raw wikitext of Guide:B0aty_HCIM_Guide_V3 into
//   { intro: [...], episodes: [{ id, title, blocks: [{ id, title, images, items }] }], steps: [...] }
// It understands the handful of constructs the page uses ({{Checklist}}, {{Var}} counters,
// {{Extimage}}, headings, bullets) and degrades gracefully on anything new.

export function parseGuide(wikitext, overlay = null) {
  const text = String(wikitext)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '');

  const vars = Object.create(null);
  const lines = splitTopLevel(text);

  const intro = [];
  const episodes = [];
  let inGuide = false;
  let episode = null;
  let pendingImages = [];
  let pendingItems = [];
  let lastTitle = '';

  const ensureEpisode = () => {
    if (!episode) {
      episode = { id: 'ep0', number: 0, title: 'Guide', blocks: [], tail: [] };
      episodes.push(episode);
    }
    return episode;
  };

  const flushPending = () => {
    if (!pendingItems.some(i => i.kind === 'step')) {
      if (episode) episode.tail.push(...pendingItems.filter(i => i.kind === 'note'));
      pendingItems = [];
      return;
    }
    addBlock(lastTitle ? `${lastTitle} (continued)` : 'Steps', []);
  };

  const addBlock = (title, items) => {
    const ep = ensureEpisode();
    ep.blocks.push({
      id: `${ep.id}-b${ep.blocks.length + 1}`,
      title,
      images: pendingImages,
      items: [...pendingItems, ...items],
    });
    pendingImages = [];
    pendingItems = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(/^(={2,6})\s*(.*?)\s*\1$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].replace(/:\s*$/, '').trim();
      if (level === 2) {
        if (/^guide$/i.test(title)) { inGuide = true; continue; }
        if (!inGuide) { intro.push({ kind: 'heading', level, text: title }); continue; }
      }
      if (!inGuide) { intro.push({ kind: 'heading', level, text: title }); continue; }
      if (level <= 3) {
        flushPending();
        const num = title.match(/Episode\s+(\d+)/i);
        episode = {
          id: num ? `ep${num[1]}` : `ep-${slug(title)}-${episodes.length}`,
          number: num ? Number(num[1]) : null,
          title,
          blocks: [],
          tail: [],
        };
        episodes.push(episode);
        lastTitle = '';
      } else {
        pendingItems.push({ kind: 'note', text: `'''${title}'''` });
      }
      continue;
    }

    if (line.startsWith('{{')) {
      const tpl = parseTemplate(line, vars);
      if (!tpl) continue;
      const name = tpl.name.toLowerCase();
      if (name === 'var') {
        if (tpl.args.length >= 2) vars[tpl.args[0].trim()] = tpl.args[1].trim();
        continue;
      }
      if (name === 'extimage') {
        const url = (tpl.args[0] || '').trim();
        if (/^https?:\/\//.test(url)) {
          if (inGuide) pendingImages.push(url);
          else intro.push({ kind: 'image', url });
        }
        continue;
      }
      if (name === 'checklist') {
        if (!inGuide) { intro.push(...bodyItems(tpl.body, vars)); continue; }
        let title = expand(tpl.named.title || '', vars).trim();
        if (!title) title = lastTitle ? `${lastTitle} (continued)` : 'Steps';
        else lastTitle = title;
        addBlock(title, bodyItems(tpl.body, vars));
        continue;
      }
      // Youtube, DISPLAYTITLE, Guide header and anything unknown: skip.
      continue;
    }

    // Loose content outside any checklist.
    if (/^End of (Episode|Series)\b/i.test(line)) continue;
    const bullet = line.match(/^(\*+)\s*(.*)$/);
    const target = inGuide ? pendingItems : intro;
    if (bullet) {
      const t = cleanText(expand(bullet[2], vars));
      if (t) target.push(inGuide
        ? { kind: 'step', depth: bullet[1].length, text: t }
        : { kind: 'bullet', depth: bullet[1].length, text: t });
    } else {
      const t = cleanText(expand(line, vars));
      // A lone short word outside any list is almost always a stray typo on the wiki.
      if (t && !/^[a-z]{1,8}$/i.test(t)) target.push({ kind: inGuide ? 'note' : 'para', text: t });
    }
  }
  flushPending();

  // Episodes with nothing to tick (video-only episodes) are dropped.
  const kept = episodes.filter(e => e.blocks.some(b => b.items.some(i => i.kind === 'step')));
  const report = overlay ? applyOverlay(intro, kept, overlay) : [];
  for (const ep of kept) ep.blocks.forEach((b, i) => { b.id = `${ep.id}-b${i + 1}`; });
  return { ...finalize(intro, kept), report };
}

// ---------- edit layers ----------
// An overlay is a list of edits anchored to step text, so a variant guide keeps
// following B0aty's wiki page. Each edit is one of:
//   { find, warn }            add a warning under matching steps
//   { find, tip }             add a tip under matching steps
//   { find, replace, why }    rewrite the step (original kept for reference)
//   { find, remove, why }     strike the step out (shown, not tickable)
//   { find, before|after: [steps], why }   insert new steps
//   { addBlock: { title, steps, note }, after|before: "Bank title" }
// Optional: in: "Bank 12" limits the search to one block, intro: true searches the intro.
function applyOverlay(intro, episodes, overlay) {
  const report = [];
  const blocks = episodes.flatMap(ep => ep.blocks.map(b => ({ ep, b })));
  const sameTitle = (a, b) => a.trim().toLowerCase() === String(b).trim().toLowerCase();

  (overlay.edits || []).forEach((edit, index) => {
    const entry = { edit, index, hits: [] };
    report.push(entry);

    if (edit.addBlock) {
      const anchor = blocks.find(x => sameTitle(x.b.title, edit.after || edit.before || ''));
      if (!anchor) return;
      const nb = {
        id: '', title: edit.addBlock.title, images: [], added: true,
        note: edit.addBlock.note || '',
        items: (edit.addBlock.steps || []).map((s, k) => newStep(s, 1, k ? '' : edit.why || '')),
      };
      const list = anchor.ep.blocks;
      list.splice(list.indexOf(anchor.b) + (edit.after ? 1 : 0), 0, nb);
      entry.hits.push({ block: nb, items: nb.items });
      return;
    }

    const needle = normalize(edit.find || '');
    if (!needle) return;
    const scopes = edit.intro
      ? [{ items: intro, block: null }]
      : blocks.filter(x => !edit.in || sameTitle(x.b.title, edit.in)).map(x => ({ items: x.b.items, block: x.b }));

    for (const { items, block } of scopes) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.added || !['step', 'note', 'para', 'bullet'].includes(it.kind)) continue;
        if (!normalize(it.text).includes(needle)) continue;
        const mods = (it.mods ||= []);
        const hit = { block, item: it, items: [] };
        if (edit.warn) mods.push({ kind: 'warn', text: edit.warn });
        if (edit.tip) mods.push({ kind: 'tip', text: edit.tip });
        if (edit.replace) { mods.push({ kind: 'changed', text: edit.why || '', original: it.text }); it.text = edit.replace; }
        if (edit.remove) { mods.push({ kind: 'removed', text: edit.why || '' }); it.was = it.kind; it.kind = 'removed'; }
        if (edit.before || edit.after) {
          const depth = it.depth || 1;
          const fresh = [].concat(edit.before || edit.after).map((s, k) => newStep(s, depth, k ? '' : edit.why || ''));
          items.splice(edit.before ? i : i + 1, 0, ...fresh);
          if (edit.before) i += fresh.length;
          hit.items = fresh;
        }
        entry.hits.push(hit);
      }
    }
  });
  return report;
}

function newStep(src, baseDepth, why) {
  const m = String(src).match(/^(\*+)\s*(.*)$/);
  return {
    kind: 'step',
    depth: m ? Math.min(m[1].length, 4) : baseDepth,
    text: m ? m[2] : String(src),
    added: true,
    mods: [{ kind: 'added', text: why }],
  };
}

// ---------- helpers ----------

// Split into logical lines, but keep a multi-line {{template}} together as one "line".
function splitTopLevel(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    // skip leading spaces on a line
    if (text.startsWith('{{', i)) {
      const end = matchBraces(text, i);
      if (end > 0) {
        out.push(text.slice(i, end));
        i = end;
        // rest of the line after the template becomes its own line
        continue;
      }
    }
    let nl = text.indexOf('\n', i);
    if (nl < 0) nl = text.length;
    out.push(text.slice(i, nl));
    i = nl + 1;
  }
  return out;
}

// Index just past the "}}" closing the "{{" at position start, or -1.
function matchBraces(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; }
    else if (text[i] === '}' && text[i + 1] === '}') {
      depth--; i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Split by "|" that is not inside [[..]] or {{..}}.
function splitPipes(s) {
  const parts = [];
  let depthC = 0, depthS = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const two = s.substr(i, 2);
    if (two === '{{') { depthC++; cur += two; i++; continue; }
    if (two === '}}') { depthC--; cur += two; i++; continue; }
    if (two === '[[') { depthS++; cur += two; i++; continue; }
    if (two === ']]') { depthS--; cur += two; i++; continue; }
    if (s[i] === '|' && depthC === 0 && depthS === 0) { parts.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  parts.push(cur);
  return parts;
}

function parseTemplate(src, vars) {
  const end = matchBraces(src, 0);
  if (end < 0) return null;
  const inner = src.slice(2, end - 2);
  const parts = splitPipes(inner);
  let name = parts.shift().trim();
  const args = [];
  const named = {};
  const colon = name.indexOf(':');
  if (colon > 0 && !name.startsWith('#')) { args.push(name.slice(colon + 1)); name = name.slice(0, colon); }
  for (const p of parts) {
    const m = p.match(/^\s*([A-Za-z_][\w ]*?)\s*=([\s\S]*)$/);
    if (m && !/\n/.test(m[1])) named[m[1].toLowerCase()] = m[2];
    else args.push(expand(p, vars));
  }
  const body = name.toLowerCase() === 'checklist' ? (args.length ? parts.filter(p => !/^\s*[A-Za-z_][\w ]*?\s*=/.test(p)).join('|') : '') : '';
  return { name: name.trim(), args, named, body };
}

// Evaluate {{#var:x}} and {{#expr:...}} (innermost first).
function expand(s, vars) {
  let prev;
  let guard = 0;
  do {
    prev = s;
    s = s.replace(/\{\{\s*#var:\s*([^{}|]*?)\s*\}\}/gi, (_, n) => vars[n] ?? '');
    s = s.replace(/\{\{\s*#expr:\s*([^{}]*?)\s*\}\}/gi, (_, e) => evalExpr(e));
  } while (s !== prev && ++guard < 20);
  return s;
}

function evalExpr(e) {
  const tokens = e.replace(/\s+/g, '').match(/\d+(?:\.\d+)?|[+\-*/]/g);
  if (!tokens) return '';
  // two-pass: * and / then + and -
  const nums = [], ops = [];
  let sign = 1;
  for (const t of tokens) {
    if (/\d/.test(t)) { nums.push(sign * Number(t)); sign = 1; }
    else if (nums.length === ops.length) { if (t === '-') sign = -sign; }
    else ops.push(t);
  }
  for (let i = 0; i < ops.length;) {
    if (ops[i] === '*' || ops[i] === '/') {
      nums.splice(i, 2, ops[i] === '*' ? nums[i] * nums[i + 1] : nums[i] / nums[i + 1]);
      ops.splice(i, 1);
    } else i++;
  }
  let r = nums[0] ?? 0;
  ops.forEach((o, i) => { r = o === '+' ? r + nums[i + 1] : r - nums[i + 1]; });
  return Number.isFinite(r) ? String(Math.round(r * 1e6) / 1e6) : '';
}

function bodyItems(body, vars) {
  const items = [];
  for (const raw of expand(body || '', vars).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\{\{\s*extimage/i.test(line)) continue;
    const bullet = line.match(/^(\*+)\s*(.*)$/);
    if (bullet) {
      const t = cleanText(bullet[2]);
      if (t) items.push({ kind: 'step', depth: Math.min(bullet[1].length, 4), text: t });
    } else {
      const t = cleanText(line);
      if (t) items.push({ kind: 'note', text: t });
    }
  }
  return items;
}

// Remove things we never render: video templates, stray tags.
function cleanText(s) {
  return s
    .replace(/\{\{\s*youtube[^{}]*\}\}/gi, '')
    .replace(/<\/?(sub|sup|small|span|div|br)\b[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export function plainText(s) {
  return s
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/'''?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalize(s) {
  return plainText(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// FNV-1a, base36.
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Give every tickable step a stable id that does not depend on bank numbers
// (the wiki renumbers banks automatically when one is inserted).
function finalize(intro, episodes) {
  const steps = [];
  const seen = Object.create(null);
  let prevNorm = '';
  for (const ep of episodes) {
    for (const block of ep.blocks) {
      block.episodeId = ep.id;
      block.items.forEach((item, idx) => {
        if (item.kind !== 'step') return;
        const norm = normalize(item.text);
        let id = `${hash(norm)}${hash(prevNorm).slice(0, 3)}`;
        if (seen[id]) id += `-${++seen[id]}`;
        else seen[id] = 1;
        item.id = id;
        item.index = steps.length;
        item.blockId = block.id;
        item.episodeId = ep.id;
        item.norm = norm;
        // children: following items with greater depth
        item.children = [];
        for (let j = idx + 1; j < block.items.length; j++) {
          const next = block.items[j];
          if (next.kind !== 'step') continue;
          if (next.depth <= item.depth) break;
          item.children.push(j);
        }
        steps.push(item);
        prevNorm = norm;
      });
      // resolve child indices to step objects
      block.items.forEach(item => {
        if (item.children) item.children = item.children.map(j => block.items[j]);
      });
      block.steps = block.items.filter(i => i.kind === 'step');
    }
    ep.steps = ep.blocks.flatMap(b => b.steps);
  }
  const byId = new Map(steps.map(s => [s.id, s]));
  const blocksById = new Map(episodes.flatMap(e => e.blocks).map(b => [b.id, b]));
  return { intro, episodes, steps, byId, blocksById };
}
