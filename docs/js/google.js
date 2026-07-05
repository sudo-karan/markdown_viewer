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
 */

const GIS_SRC = "https://accounts.google.com/gsi/client";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

let clientId = null;
let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let profile = null;
let folderId = null;
let folderName = "Markdown Studio";

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

export function configure(id, driveFolderName) {
  clientId = id ? id.trim() : null;
  if (driveFolderName) folderName = driveFolderName;
  tokenClient = null; // force re-init if the id changed
}

export function isConfigured() {
  return !!clientId;
}
export function isSignedIn() {
  return !!accessToken && Date.now() < tokenExpiry;
}
export function getProfile() {
  return profile;
}

// The GIS token client's callback/error_callback are set once at init time and
// cannot be refreshed per request, so they must resolve the *current* pending
// request rather than close over one promise. We track it in `pending`.
let pending = null;
function onTokenResponse(resp) {
  const p = pending;
  pending = null;
  if (!p) return;
  if (resp.error) return p.reject(new Error(resp.error_description || resp.error));
  accessToken = resp.access_token;
  tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
  p.resolve(resp);
}
function onTokenError(err) {
  const p = pending;
  pending = null;
  if (p) p.reject(new Error(err?.message || err?.type || "Google authorization failed."));
}

/** Acquire (or silently refresh) an access token. */
function requestToken({ prompt } = {}) {
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
    pending = { resolve, reject };
    try {
      tokenClient.requestAccessToken(prompt !== undefined ? { prompt } : {});
    } catch (e) {
      pending = null;
      reject(e);
    }
  });
}

/** Interactive sign-in: gets a token and loads the user's basic profile. */
export async function signIn() {
  await loadGis();
  await requestToken({ prompt: profile ? "" : "consent" });
  await loadProfile();
  return profile;
}

export function signOut() {
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
}

async function loadProfile() {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (r.ok) profile = await r.json();
}

/** fetch() wrapper that ensures a valid token and retries once on 401. */
async function authFetch(url, opts = {}, retried = false) {
  if (!isSignedIn()) await signIn();
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + accessToken },
  });
  if (res.status === 401 && !retried) {
    accessToken = null;
    return authFetch(url, opts, true);
  }
  return res;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

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
async function ensureRootFolder() {
  if (folderId) return folderId;
  const q = encodeURIComponent(
    `mimeType='${FOLDER_MIME}' and name='${folderName.replace(/'/g, "\\'")}' and 'root' in parents and trashed=false`,
  );
  const found = await authFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`,
  );
  if (found.ok) {
    const data = await found.json();
    if (data.files?.length) {
      folderId = data.files[0].id;
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

  /**
   * List the immediate children of a folder, split into subfolders and files,
   * folders first. Only children the app can access (drive.file) are returned.
   */
  async listChildren(parentId) {
    const id = parentId || (await ensureRootFolder());
    const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
    const res = await authFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=folder,name&pageSize=1000`,
    );
    if (!res.ok) throw await driveError(res, "Could not list this folder.");
    const items = (await res.json()).files || [];
    return {
      folders: items.filter((f) => f.mimeType === FOLDER_MIME),
      files: items.filter((f) => f.mimeType !== FOLDER_MIME),
    };
  },

  /** Create a subfolder under parentId (default: the app root). */
  async createFolder(name, parentId) {
    const parent = parentId || (await ensureRootFolder());
    const res = await authFetch("https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType", {
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
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,parents",
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
      `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&fields=id,name,modifiedTime`,
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
