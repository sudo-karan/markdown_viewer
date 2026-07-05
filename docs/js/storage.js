/*
 * storage.js — local-first persistence in the browser (localStorage).
 *
 * The app works fully offline with no account: every document lives in a local
 * "library". Connecting Google Drive is purely additive — a Drive file id is
 * stored alongside a document so saves can round-trip.
 */
const LIB_KEY = "mds:library:v2";
const SETTINGS_KEY = "mds:settings:v1";
const CURRENT_KEY = "mds:current:v1";

// Every localStorage access is guarded: in private mode or when storage is
// blocked/full, reads fall back and writes no-op instead of throwing (which
// would otherwise kill init()).
function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn("localStorage write failed (private mode or quota?)", e);
    return false;
  }
}
function lsRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function safeParse(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** @returns {string} a short unique id for a local document. */
export function uid() {
  return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export const store = {
  /** @returns {Array<{id,name,text,driveId,updated}>} */
  loadLibrary() {
    return safeParse(lsGet(LIB_KEY), []);
  },
  saveLibrary(lib) {
    lsSet(LIB_KEY, JSON.stringify(lib));
  },

  loadSettings() {
    return safeParse(lsGet(SETTINGS_KEY), {});
  },
  saveSettings(s) {
    lsSet(SETTINGS_KEY, JSON.stringify(s));
  },

  getCurrentId() {
    return lsGet(CURRENT_KEY) || null;
  },
  setCurrentId(id) {
    if (id) lsSet(CURRENT_KEY, id);
    else lsRemove(CURRENT_KEY);
  },
};

/** Upsert a document into a library array (mutating a copy). */
export function upsertDoc(lib, doc) {
  const next = lib.slice();
  const i = next.findIndex((d) => d.id === doc.id);
  if (i === -1) next.unshift(doc);
  else next[i] = doc;
  return next;
}

export function removeDoc(lib, id) {
  return lib.filter((d) => d.id !== id);
}
