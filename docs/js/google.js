/*
 * google.js — Google sign-in + Google Drive, entirely from the browser.
 *
 * Design & security notes:
 *  - Auth uses Google Identity Services (GIS) OAuth 2.0 "token model" for SPAs.
 *    There are NO passwords and NO backend: Google is the identity provider and
 *    the app never sees or stores a credential.
 *  - A Client ID is public by design and safe to ship in a static site. We never
 *    use a client secret, API key, or service-account key (a static site cannot
 *    keep secrets).
 *  - Scope is least-privilege `drive.file`: the app can only see/manage files it
 *    creates or that the user explicitly opens with it — not the whole Drive.
 *
 * Staying signed in
 * -----------------
 * The token model hands out short-lived access tokens (~1h) and NO refresh
 * token — by design, a browser app can't hold one. Keeping the token only in a
 * module variable therefore signed the user out on every page reload and again
 * an hour into a session. Three things fix that:
 *   1. the token is cached in sessionStorage, so a reload keeps working without
 *      a round-trip;
 *   2. the account is remembered in localStorage, so the app knows whose
 *      documents to show on the very first paint;
 *   3. a token that is missing or nearly expired is renewed *silently*
 *      (`prompt: ""`) — on a timer, and before any Drive call — so no popup and
 *      no re-consent as long as the Google session is alive.
 * The cached token is short-lived, scoped to drive.file, and cleared on sign-out.
 *
 * One account, one namespace
 * --------------------------
 * Acquiring a token is the ONLY event that establishes who the user is, so this
 * module owns it: every successful token+profile fires `onAccountChange`. That
 * makes it impossible for a caller (e.g. "Save to Drive") to authenticate
 * without the rest of the app switching to that account's documents — a hole
 * that previously let one user's files be adopted, and overwritten, by the next.
 */

const GIS_SRC = "https://accounts.google.com/gsi/client";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

// sessionStorage: per-tab, dies with the tab. localStorage: which account this
// browser was last signed in as (a profile, never a token).
const TOKEN_KEY = "mds:google:token:v1";
const ACCOUNT_KEY = "mds:google:account:v1";
// Renew this long before the token actually expires.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// A token request that never calls back (popup killed by the OS, tab suspended)
// must not wedge sign-in for the life of the page.
const REQUEST_TIMEOUT_MS = 120_000;

let clientId = null;
let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let profile = null;
let folderId = null;
let folderName = "Markdown Studio";
let legacyFolderNames = [];
let refreshTimer = 0;
let accountListener = null;

/** Thrown when only an interactive, user-initiated sign-in can recover. */
export class SignInRequiredError extends Error {
  constructor(msg = "Your Google session expired. Click your account (top right) to sign in again.") {
    super(msg);
    this.name = "SignInRequiredError";
    this.signInRequired = true;
  }
}

/**
 * Register the single callback fired whenever the signed-in identity changes
 * (sign-in, silent refresh that first learns the profile, sign-out → null).
 */
export function onAccountChange(fn) {
  accountListener = fn;
}
let lastAnnounced = null;
function announceAccount() {
  const id = getAccountId();
  if (id === lastAnnounced) return;
  lastAnnounced = id;
  try {
    accountListener?.(id);
  } catch (e) {
    console.warn("account change handler failed", e);
  }
}

/* ---------------------------------------------------------------- storage */
// Guarded: private mode or blocked storage must degrade, never throw.
function readStore(store, key) {
  try {
    const raw = window[store].getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeStore(store, key, value) {
  try {
    window[store].setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
function dropStore(store, key) {
  try {
    window[store].removeItem(key);
  } catch {
    /* ignore */
  }
}
function persistToken() {
  if (accessToken) writeStore("sessionStorage", TOKEN_KEY, { t: accessToken, e: tokenExpiry });
  else dropStore("sessionStorage", TOKEN_KEY);
}
function persistAccount() {
  if (profile) writeStore("localStorage", ACCOUNT_KEY, profile);
  else dropStore("localStorage", ACCOUNT_KEY);
}

let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Google Identity Services."));
    document.head.appendChild(s);
  });
  return gisPromise;
}
/**
 * Fetch the GIS library ahead of time. An interactive sign-in must open its
 * popup inside the user's click; if the library still has to be downloaded at
 * that moment the popup arrives too late and browsers block it (Safari always,
 * Chrome once the activation window lapses). Called once at boot.
 */
export function preload() {
  if (clientId) loadGis().catch(() => {});
}

export function configure(id, driveFolderName, previousFolderNames) {
  clientId = id ? id.trim() : null;
  if (driveFolderName) folderName = driveFolderName;
  legacyFolderNames = Array.isArray(previousFolderNames) ? previousFolderNames : [];
  tokenClient = null; // force re-init if the id changed
}

export function isConfigured() {
  return !!clientId;
}
export function isSignedIn() {
  return !!accessToken && Date.now() < tokenExpiry;
}
/**
 * Whether this browser knows who the user is — true immediately after a reload,
 * before (or even without) a fresh token. The UI and the storage namespace key
 * off this so a reload doesn't look like a sign-out.
 */
export function hasSession() {
  return !!profile;
}
export function getProfile() {
  return profile;
}
/**
 * Stable per-account id (the OpenID `sub` claim). Used to namespace this
 * browser's local storage so several people can share a device and each see
 * only their own documents. Falls back to the email if `sub` is absent.
 */
export function getAccountId() {
  return profile ? profile.sub || profile.email || null : null;
}

/**
 * Synchronous half of "stay signed in": adopt the remembered account (and a
 * still-valid cached token) *before* the app loads any documents, so the right
 * library is on screen at the first paint instead of the signed-out one.
 * @returns {string|null} the restored account id
 */
export function restoreSession() {
  if (!profile) profile = readStore("localStorage", ACCOUNT_KEY);
  const cached = readStore("sessionStorage", TOKEN_KEY);
  if (cached?.t && Date.now() < Number(cached.e || 0)) {
    accessToken = cached.t;
    tokenExpiry = Number(cached.e);
    scheduleRefresh();
  } else if (cached) {
    dropStore("sessionStorage", TOKEN_KEY);
  }
  lastAnnounced = getAccountId();
  return lastAnnounced;
}

/**
 * Async half: make sure a usable token exists, silently. Safe to call on every
 * page load — it never shows UI. Returns false when the user must click.
 */
export async function resumeSession() {
  if (!clientId || !profile) return false;
  if (isSignedIn()) return true;
  try {
    await silentToken();
    return true;
  } catch {
    return false;
  }
}

// The GIS token client's callback/error_callback are set once at init time and
// cannot be refreshed per request, so they must resolve the *current* pending
// request rather than close over one promise. We track it in `pending`.
let pending = null;
function settlePending(fn) {
  const p = pending;
  pending = null;
  if (!p) return;
  clearTimeout(p.timer);
  fn(p);
}
function onTokenResponse(resp) {
  settlePending((p) => {
    if (resp.error) return p.reject(new Error(resp.error_description || resp.error));
    accessToken = resp.access_token;
    tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
    persistToken();
    scheduleRefresh();
    p.resolve(resp);
  });
}
function onTokenError(err) {
  settlePending((p) =>
    p.reject(new Error(err?.message || err?.type || "Google authorization failed.")),
  );
}

/** Acquire (or silently refresh) an access token. */
function requestToken({ prompt, hint } = {}) {
  return new Promise((resolve, reject) => {
    if (!clientId) return reject(new Error("Google Client ID is not set. Open Settings to add it."));
    if (pending) return reject(new Error("A Google sign-in is already in progress."));
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: onTokenResponse,
        error_callback: onTokenError,
      });
    }
    // Some failures (a popup killed by the OS, a suspended tab) never call back
    // at all. Without this the `pending` guard above would reject every later
    // attempt until the page was reloaded.
    const timer = setTimeout(
      () => settlePending((p) => p.reject(new Error("Google sign-in timed out. Please try again."))),
      REQUEST_TIMEOUT_MS,
    );
    pending = { resolve, reject, timer };
    const opts = {};
    if (prompt !== undefined) opts.prompt = prompt;
    if (hint) opts.hint = hint;
    try {
      tokenClient.requestAccessToken(opts);
    } catch (e) {
      settlePending((p) => p.reject(e));
    }
  });
}

/**
 * Renew without any UI. Google grants this whenever the user is still signed in
 * to Google in this browser and has already consented — i.e. almost always.
 * A single in-flight refresh is shared so concurrent Drive calls don't race.
 */
let silentPromise = null;
function silentToken() {
  if (silentPromise) return silentPromise;
  silentPromise = (async () => {
    await loadGis();
    await requestToken({ prompt: "", hint: profile?.email });
    await loadProfile();
    persistAccount();
    announceAccount();
    return accessToken;
  })().finally(() => {
    silentPromise = null;
  });
  return silentPromise;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!tokenExpiry) return;
  const wait = Math.max(30_000, tokenExpiry - Date.now() - REFRESH_MARGIN_MS);
  refreshTimer = setTimeout(() => {
    if (profile && clientId) silentToken().catch(() => {});
  }, wait);
}

/**
 * Interactive sign-in. Tries the silent path first for a known account (no
 * popup, no re-consent); falls back to the real dialog. If even that fails the
 * remembered account is dropped so the UI can honestly say "signed out" instead
 * of retrying silently forever.
 */
export async function signIn() {
  await loadGis();
  if (profile) {
    try {
      await requestToken({ prompt: "", hint: profile.email });
      await loadProfile();
      persistAccount();
      announceAccount();
      return profile;
    } catch {
      /* the Google session is gone — fall through to the interactive dialog */
    }
  }
  try {
    await requestToken({ prompt: "consent" });
    await loadProfile();
  } catch (e) {
    profile = null;
    accessToken = null;
    tokenExpiry = 0;
    persistToken();
    persistAccount();
    announceAccount();
    throw e;
  }
  persistAccount();
  announceAccount();
  return profile;
}

export function signOut() {
  clearTimeout(refreshTimer);
  if (accessToken && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(accessToken, () => {});
    } catch {
      /* ignore */
    }
  }
  accessToken = null;
  tokenExpiry = 0;
  profile = null;
  folderId = null;
  dropStore("sessionStorage", TOKEN_KEY);
  dropStore("localStorage", ACCOUNT_KEY);
  announceAccount();
}

/**
 * A token whose owner we can't identify is useless to us: documents would land
 * in the signed-out namespace while the UI claimed an account, and would then be
 * adopted by whoever signs in next. So a failed profile fetch is a failed
 * sign-in.
 */
async function loadProfile() {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!r.ok) throw new Error("Signed in to Google, but your account details could not be read.");
  profile = await r.json();
  return profile;
}

/**
 * Guarantee a usable token WITHOUT opening a popup. Drive work usually runs long
 * after the click that started it (a drop, an autosave, a retry), by which point
 * the browser has forgotten the user gesture and a popup would simply be
 * blocked — which is what used to make those actions fail silently or hang. If
 * the silent path can't recover the session we say so, and the caller asks the
 * user to click.
 */
async function ensureToken() {
  if (isSignedIn()) return;
  if (!clientId) throw new Error("Google Client ID is not set. Open Settings to add it.");
  if (!profile) throw new SignInRequiredError("Sign in with Google first (top right).");
  try {
    await silentToken();
  } catch {
    throw new SignInRequiredError();
  }
}

/** fetch() wrapper that ensures a valid token and retries once on 401. */
async function authFetch(url, opts = {}, retried = false) {
  await ensureToken();
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + accessToken },
  });
  if (res.status === 401 && !retried) {
    accessToken = null;
    tokenExpiry = 0;
    persistToken();
    return authFetch(url, opts, true);
  }
  return res;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
// Everything the UI shows about a file. Asking for these up front means a file
// the app just created renders with its real size and dates instead of "—".
const FILE_FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,parents";

/** Turn a failed Drive response into an Error carrying Google's real message. */
async function driveError(res, fallback) {
  let msg = fallback;
  try {
    const body = await res.json();
    if (body?.error?.message) msg = body.error.message;
  } catch {
    /* keep fallback */
  }
  const e = new Error(msg);
  e.status = res.status;
  return e;
}

/**
 * Find (or create) the app's root folder — the ONLY part of Drive this app
 * touches. Everything the app creates lives under this subtree, so with the
 * drive.file scope the app can never see the rest of the user's Drive.
 */
/** Look for a folder with this exact name directly in My Drive. */
async function findRootFolderNamed(name) {
  const q = encodeURIComponent(
    `mimeType='${FOLDER_MIME}' and name='${name.replace(/'/g, "\\'")}' and 'root' in parents and trashed=false`,
  );
  const res = await authFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`,
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.files?.length ? data.files[0] : null;
}

async function ensureRootFolder() {
  if (folderId) return folderId;
  const found = await findRootFolderNamed(folderName);
  if (found) {
    folderId = found.id;
    return folderId;
  }
  // The deployment's folder name can change (config.js driveFolderName). Adopt
  // and rename a folder created under a previous name instead of silently
  // starting an empty one and stranding the user's existing documents.
  for (const legacy of legacyFolderNames) {
    if (legacy === folderName) continue;
    const old = await findRootFolderNamed(legacy);
    if (old) {
      folderId = old.id;
      try {
        await drive.rename(old.id, folderName);
      } catch {
        /* keep using the folder even if the rename is refused */
      }
      return folderId;
    }
  }
  const created = await authFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME, parents: ["root"] }),
  });
  if (!created.ok) throw await driveError(created, "Could not create the Drive folder.");
  folderId = (await created.json()).id;
  return folderId;
}

export const drive = {
  /** Id + display name of the app's root folder (creating it if needed). */
  async root() {
    const id = await ensureRootFolder();
    return { id, name: folderName };
  },

  /** Direct link to a folder on the Drive website. */
  folderUrl(id) {
    return `https://drive.google.com/drive/folders/${id}`;
  },

  /**
   * List the immediate children of a folder, split into subfolders and files,
   * folders first. Only children the app can access (drive.file) are returned.
   * Pages through the whole folder — a big folder used to silently stop at the
   * first 1000 items.
   */
  async listChildren(parentId) {
    const id = parentId || (await ensureRootFolder());
    const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
    const items = [];
    let pageToken = "";
    do {
      const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const res = await authFetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})` +
          `&orderBy=folder,name&pageSize=200${page}`,
      );
      if (!res.ok) throw await driveError(res, "Could not list this folder.");
      const data = await res.json();
      items.push(...(data.files || []));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return {
      folders: items.filter((f) => f.mimeType === FOLDER_MIME),
      files: items.filter((f) => f.mimeType !== FOLDER_MIME),
    };
  },

  /** Create a subfolder under parentId (default: the app root). */
  async createFolder(name, parentId) {
    const parent = parentId || (await ensureRootFolder());
    const res = await authFetch(`https://www.googleapis.com/drive/v3/files?fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    });
    if (!res.ok) throw await driveError(res, "Could not create the folder.");
    return await res.json();
  },

  async read(id) {
    const res = await authFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    if (!res.ok) throw await driveError(res, "Could not read the Drive file.");
    return await res.text();
  },

  /** Create a markdown file under parentId (default: the app root). */
  async create(name, text, parentId) {
    const parent = parentId || (await ensureRootFolder());
    const boundary = "mds" + Math.random().toString(16).slice(2);
    const meta = { name, mimeType: "text/markdown", parents: [parent] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: text/markdown\r\n\r\n` +
      `${text}\r\n--${boundary}--`;
    const res = await authFetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    if (!res.ok) throw await driveError(res, "Could not save to Drive.");
    return await res.json();
  },

  /** Overwrite an existing file's contents. */
  async update(id, text) {
    const res = await authFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&fields=id,name,size,modifiedTime`,
      { method: "PATCH", headers: { "Content-Type": "text/markdown" }, body: text },
    );
    if (!res.ok) throw await driveError(res, "Could not update the Drive file.");
    return await res.json();
  },

  /** Rename an existing file. */
  async rename(id, name) {
    const res = await authFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await driveError(res, "Could not rename the Drive file.");
    return await res.json();
  },

  /** Move a file/folder to the Drive trash. */
  async trash(id) {
    const res = await authFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    if (!res.ok) throw await driveError(res, "Could not delete from Drive.");
    return await res.json();
  },

  /** Move a file into addParent (optionally out of removeParent). */
  async move(id, addParent, removeParent) {
    const params = new URLSearchParams({ addParents: addParent, fields: "id,parents" });
    if (removeParent) params.set("removeParents", removeParent);
    const res = await authFetch(`https://www.googleapis.com/drive/v3/files/${id}?${params}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw await driveError(res, "Could not move the file.");
    return await res.json();
  },
};
