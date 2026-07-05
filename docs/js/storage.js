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
    return safeParse(localStorage.getItem(LIB_KEY), []);
  },
  saveLibrary(lib) {
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify(lib));
    } catch (e) {
      console.warn("Failed to persist library (quota?)", e);
    }
  },

  loadSettings() {
    return safeParse(localStorage.getItem(SETTINGS_KEY), {});
  },
  saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  },

  getCurrentId() {
    return localStorage.getItem(CURRENT_KEY) || null;
  },
  setCurrentId(id) {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
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
