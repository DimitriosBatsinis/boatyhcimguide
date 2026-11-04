// Progress lives in this browser's localStorage. Everything is wrapped so the
// page still works (without saving) in private windows or with storage blocked.

const KEY = 'b0aty-hcim-v3:progress';        // the original guide (kept for existing ticks)
const GUIDE_KEY = 'b0aty-hcim-v3:guide';
const SETTINGS_KEY = 'b0aty-hcim-v3:settings';

const DEFAULT_SETTINGS = { collapseDone: true, images: true, theme: 'auto', guide: 'b0aty' };

export function progressKey(guideId) {
  return guideId && guideId !== 'b0aty' ? `${KEY}:${guideId}` : KEY;
}

// Settings are shared by all guides. Older versions kept them inside the progress record.
export function loadSettings() {
  const own = read(SETTINGS_KEY);
  const s = { ...DEFAULT_SETTINGS, ...(own || read(KEY)?.settings || {}) };
  if (!own) write(SETTINGS_KEY, s); // one-time move out of the old progress record
  return s;
}
export function saveSettings(s) { write(SETTINGS_KEY, s); }

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function storageWorks() {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch { return false; }
}

export function askPersistent() {
  try { navigator.storage?.persist?.(); } catch { /* best effort */ }
}

export function createStore(guideId = 'b0aty') {
  const key = progressKey(guideId);
  const saved = read(key) || {};
  const settings = loadSettings();
  const state = {
    v: 1,
    guide: guideId,
    ticks: saved.ticks || {},       // id -> { t: time, x: text when ticked, i: position }
    changed: saved.changed || {},   // id -> old wording, for ticked steps the wiki reworded
    settings,
    view: saved.view || null,
  };
  let timer = null;
  const listeners = new Set();

  const record = () => ({ v: 1, guide: guideId, ticks: state.ticks, changed: state.changed, view: state.view });
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => write(key, record()), 150);
  };
  const flush = () => { clearTimeout(timer); write(key, record()); };
  addEventListener('pagehide', flush);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  const undoStack = [];

  return {
    state,
    isDone: id => !!state.ticks[id],
    // changes: [{ step, done }]; returns the undo record
    apply(changes, { record = true } = {}) {
      const before = changes.map(({ step }) => ({ step, done: !!state.ticks[step.id], tick: state.ticks[step.id] }));
      for (const { step, done } of changes) {
        if (done) state.ticks[step.id] = state.ticks[step.id] || { t: Date.now(), x: step.text, i: step.index };
        else { delete state.ticks[step.id]; delete state.changed[step.id]; }
      }
      if (record && changes.length) {
        undoStack.push(before);
        if (undoStack.length > 100) undoStack.shift();
      }
      save();
      listeners.forEach(fn => fn(changes));
    },
    undo() {
      const last = undoStack.pop();
      if (!last) return null;
      for (const { step, done, tick } of last) {
        if (done) state.ticks[step.id] = tick;
        else delete state.ticks[step.id];
      }
      save();
      listeners.forEach(fn => fn(last));
      return last;
    },
    canUndo: () => undoStack.length > 0,
    onChange(fn) { listeners.add(fn); },
    setSetting(k, v) { state.settings[k] = v; saveSettings(state.settings); },
    setView(v) { state.view = v; save(); },
    dismissChanged(id) { delete state.changed[id]; save(); },
    reset() {
      const all = Object.keys(state.ticks);
      state.ticks = {}; state.changed = {};
      undoStack.length = 0;
      flush();
      return all.length;
    },
    exportJson() {
      return JSON.stringify({ app: 'b0aty-hcim-v3-checklist', exported: new Date().toISOString(), ...record(), settings: state.settings }, null, 1);
    },
    // Returns the guide id the file was exported from (older files have none).
    importJson(text) {
      const data = JSON.parse(text);
      if (!data || typeof data.ticks !== 'object') throw new Error('This file does not look like a progress export.');
      state.ticks = data.ticks;
      state.changed = data.changed || {};
      undoStack.length = 0;
      flush();
      return data.guide || 'b0aty';
    },
    flush,
  };
}

// Re-attach ticks after the guide changed: ids that no longer exist are matched
// to the most similar unticked step nearby. Returns { moved, reworded, lost }.
export function reconcile(store, guide) {
  const { ticks, changed } = store.state;
  let moved = 0, reworded = 0, lost = 0;
  const orphans = [];
  for (const [id, tick] of Object.entries(ticks)) {
    const step = guide.byId.get(id);
    if (step) { tick.i = step.index; continue; }
    orphans.push([id, tick]);
  }
  for (const [id, tick] of orphans) {
    if (!tick.x) { lost++; continue; }
    const want = tokens(tick.x);
    let best = null, bestScore = 0;
    const from = Math.max(0, (tick.i ?? 0) - 250), to = Math.min(guide.steps.length, (tick.i ?? 0) + 250);
    for (let i = from; i < to; i++) {
      const s = guide.steps[i];
      if (ticks[s.id]) continue;
      const score = similarity(want, tokens(s.text)) - Math.abs(i - (tick.i ?? i)) / 5000;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best && bestScore >= 0.55) {
      delete ticks[id];
      ticks[best.id] = { ...tick, i: best.index, x: best.text };
      if (tokensKey(tick.x) !== tokensKey(best.text)) { changed[best.id] = tick.x; reworded++; }
      else moved++;
      if (changed[id]) { changed[best.id] = changed[id]; delete changed[id]; }
    } else lost++;
  }
  for (const id of Object.keys(changed)) if (!ticks[id]) delete changed[id];
  store.flush();
  return { moved, reworded, lost };
}

const tokens = s => new Set(s.toLowerCase().replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').match(/[a-z0-9]+/g) || []);
const tokensKey = s => [...tokens(s)].join(' ');
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return (2 * common) / (a.size + b.size);
}

export const guideCache = {
  get: () => read(GUIDE_KEY),
  set: g => write(GUIDE_KEY, g),
};
