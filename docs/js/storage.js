/*
 * storage.js — local-first persistence in the browser (localStorage).
 *
 * The app works fully offline with no account: every document lives in a local
 * "library". Connecting Google Drive is purely additive — a Drive file id is
 * stored alongside a document so saves can round-trip.
 */
/*
 * Per-account namespacing
 * ----------------------
 * Several people may share one browser (a family tablet, a shared laptop), and
 * each signs in with their own Google account. Every key is therefore suffixed
 * with an account namespace so one user's library is never visible to another:
 *   signed out -> "anon"      signed in -> the Google account's stable `sub` id
 * Nothing here is a security boundary (localStorage is readable by anyone at the
 * keyboard) — it is isolation so accounts don't clobber or leak into each other.
 * The real cross-device store is the user's own Google Drive.
 */
const BASE_LIB = "mds:library:v2";
const BASE_SETTINGS = "mds:settings:v1";
const BASE_CURRENT = "mds:current:v1";

const ANON = "anon";
let ns = ANON;

/** Switch the active account namespace (null/empty → signed-out). */
export function setAccount(accountId) {
  ns = accountId ? String(accountId) : ANON;
}
export function getAccount() {
  return ns;
}
const key = (base, forNs = ns) => `${base}:${forNs}`;

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

/*
 * One-time migration: documents saved before per-account namespacing existed
 * live under the un-suffixed keys. Adopt them into the signed-out namespace on
 * first run so nobody's existing work disappears when they update the app.
 */
function migrateLegacyKeys() {
  for (const base of [BASE_LIB, BASE_SETTINGS, BASE_CURRENT]) {
    const legacy = lsGet(base);
    if (legacy !== null && lsGet(key(base, ANON)) === null) lsSet(key(base, ANON), legacy);
  }
}
migrateLegacyKeys();

export const store = {
  /** @returns {Array<{id,name,text,driveId,created,updated}>} */
  loadLibrary() {
    return safeParse(lsGet(key(BASE_LIB)), []);
  },
  saveLibrary(lib) {
    lsSet(key(BASE_LIB), JSON.stringify(lib));
  },

  loadSettings() {
    return safeParse(lsGet(key(BASE_SETTINGS)), {});
  },
  saveSettings(s) {
    lsSet(key(BASE_SETTINGS), JSON.stringify(s));
  },

  getCurrentId() {
    return lsGet(key(BASE_CURRENT)) || null;
  },
  setCurrentId(id) {
    if (id) lsSet(key(BASE_CURRENT), id);
    else lsRemove(key(BASE_CURRENT));
  },

  /** Read another namespace's library without switching to it. */
  loadLibraryOf(accountId) {
    return safeParse(lsGet(key(BASE_LIB, accountId || ANON)), []);
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
