/*
 * app.js — Markdown Studio application controller.
 *
 * Ties together rendering (render.js), local persistence (storage.js) and
 * optional Google Drive sync (google.js). No framework, no build step — this is
 * plain ES modules so it can be served straight off GitHub Pages.
 */
// ?v= cache-buster: bump on every JS change (keep in sync with index.html's
// script tag) so a deploy never leaves the browser on a stale module.
import { renderMarkdown, enhance, extractOutline, slugify } from "./render.js?v=20260906";
import { store, upsertDoc, removeDoc, uid, setAccount } from "./storage.js?v=20260906";
import * as google from "./google.js?v=20260906";
import LZString from "https://esm.sh/lz-string@1.5.0";

const CONFIG = window.MO_STUDIO_CONFIG || {};

const SAMPLE = `# Welcome to Markdown Studio 👋

A fast, **private** Markdown editor that runs entirely in your browser — no
server, no tracking. Edit on the left, see it live on the right.

> [!NOTE]
> Your work autosaves to this browser. Connect **Google Drive** (top-right) to
> sync documents to your own account.

## What it can do

- [x] GitHub-flavored Markdown — tables, task lists, footnotes
- [x] Syntax highlighting, **Mermaid** diagrams, and **KaTeX** math
- [x] Live preview with a clickable outline
- [ ] Your next great document

## Code

\`\`\`js
export function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

## Table

| Feature      | Local | Google Drive |
| ------------ | :---: | :----------: |
| Autosave     |  ✅   |      ✅      |
| Works offline|  ✅   |      —       |
| Sync devices |  —    |      ✅      |

## Math

The Gaussian integral: $\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$.

## Diagram

\`\`\`mermaid
flowchart LR
  Write[Write Markdown] --> Preview[Live preview]
  Preview --> Save{Save}
  Save -->|Local| Browser[(Browser)]
  Save -->|Sync| Drive[(Google Drive)]
\`\`\`

Happy writing! Press **Ctrl/Cmd + /** any time for shortcuts.
`;

const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"></path></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237V14.25A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8 4.25V1.5Z"></path></svg>';
const DEVICE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 12h-3.5l.5 2h1a.75.75 0 0 1 0 1.5H3.75a.75.75 0 0 1 0-1.5h1l.5-2h-3.5A1.75 1.75 0 0 1 0 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>';
const CLOUD_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M4.5 13a4 4 0 0 1-.5-7.97A4.5 4.5 0 0 1 13 6.5a3.5 3.5 0 0 1-.5 6.96V13H4.5Z"></path></svg>';

/* ------------------------------------------------------------------ state */
const state = {
  settings: {},
  library: [],
  current: null, // {id,name,text,driveId,driveName,driveParentId,updated}
  view: "split",
  dark: true,
  renderTimer: 0,
  saveTimer: 0,
  syncingScroll: false,
  driveRootId: null, // id of the "markdowns" root folder, once loaded
  driveCache: {}, // folderId -> {name,folders:[{id,name}],files:[{id,name,modifiedTime}],loaded,loading,error}
};

/* ------------------------------------------------------------------ dom */
const $ = (id) => document.getElementById(id);
const app = $("app");
const editor = $("editor");
const preview = $("preview");
const docTitle = $("doc-title");
const saveState = $("save-state");
const storageLoc = $("storage-loc");
const treeEl = $("tree");
const outlineEl = $("outline");
const toastEl = $("toast");
const googleBtn = $("btn-google");
const googleLabel = $("google-btn-label");
const googleAvatar = $("google-avatar");

/* ------------------------------------------------------------------ toast */
let toastTimer = 0;
function toast(msg, kind = "") {
  toastEl.textContent = msg;
  toastEl.className = "toast show " + kind;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
    setTimeout(() => (toastEl.hidden = true), 200);
  }, 2600);
}

/* ------------------------------------------------------------------ theme */
function applyTheme(dark) {
  state.dark = dark;
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  // Enable/disable the right CDN stylesheets. Note: toggling a <link> via CSS
  // `display:none` does NOT work — we must set the `disabled` property.
  const set = (id, off) => {
    const el = document.getElementById(id);
    if (el) el.disabled = off;
  };
  set("gh-md-dark", !dark);
  set("gh-md-light", dark);
  set("hljs-dark", !dark);
  set("hljs-light", dark);
  state.settings.theme = dark ? "dark" : "light";
  store.saveSettings(state.settings);
  scheduleRender(0); // re-render so Mermaid picks up the theme
}

/* ------------------------------------------------------------------ view mode */
function setView(view) {
  state.view = view;
  app.setAttribute("data-view", view);
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.view === view);
  });
  state.settings.view = view;
  store.saveSettings(state.settings);
}

/* ------------------------------------------------------------------ stats + cursor */
function updateStats() {
  const text = editor.value;
  const words = (text.trim().match(/\S+/g) || []).length;
  $("stat-words").textContent = `${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
  $("stat-read").textContent = `${Math.max(1, Math.ceil(words / 200))} min read`;
}
function updateCursor() {
  const upto = editor.value.slice(0, editor.selectionStart);
  const line = upto.split("\n").length;
  const col = upto.length - upto.lastIndexOf("\n");
  $("cursor-pos").textContent = `Ln ${line}, Col ${col}`;
}

/* ------------------------------------------------------------------ rendering */
const BLANK_PREVIEW_HTML = `
  <div class="preview-empty">
    <div class="preview-empty-icon" aria-hidden="true">📝</div>
    <p class="preview-empty-title">This document is blank</p>
    <p class="preview-empty-sub">
      Switch to <button type="button" class="preview-empty-cta">Edit</button>
      and start writing — your Markdown renders here as you type.
    </p>
  </div>`;

async function renderNow() {
  // An empty document would otherwise render as a blank pane, which reads as
  // "still loading". Show an explicit placeholder that also points at Edit mode.
  if (!editor.value.trim()) {
    preview.innerHTML = BLANK_PREVIEW_HTML;
    preview.querySelector(".preview-empty-cta")?.addEventListener("click", () => {
      setView("edit");
      editor.focus();
    });
    buildOutline();
    return;
  }
  const html = renderMarkdown(editor.value);
  preview.innerHTML = html;
  await enhance(preview, { dark: state.dark });
  buildOutline();
}
function scheduleRender(delay = 180) {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(renderNow, delay);
}

function buildOutline() {
  const items = extractOutline(preview);
  outlineEl.innerHTML = "";
  if (items.length === 0) {
    outlineEl.innerHTML = `<p style="color:var(--text-muted);font-size:12px;padding:6px">No headings yet.</p>`;
    return;
  }
  for (const it of items) {
    const a = document.createElement("a");
    a.href = "#" + it.id;
    a.className = "lvl-" + it.level;
    a.textContent = it.text;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      preview.querySelector("#" + CSS.escape(it.id))?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    outlineEl.appendChild(a);
  }
}

/* ------------------------------------------------------------------ save state */
function setSaveState(s) {
  const labels = { saved: "Saved", dirty: "Unsaved", saving: "Saving…", error: "Save failed" };
  saveState.dataset.state = s;
  saveState.textContent = labels[s] || s;
}

function updateStorageLoc() {
  if (state.current?.driveId) storageLoc.textContent = "Drive: " + state.current.name;
  else storageLoc.textContent = "Local";
}

/* ------------------------------------------------------------------ documents */
function persist(doc, { markSaved = true, rerender = true } = {}) {
  doc.updated = Date.now();
  state.library = upsertDoc(state.library, doc);
  store.saveLibrary(state.library);
  store.setCurrentId(doc.id);
  if (rerender) renderTree();
  if (markSaved) setSaveState("saved");
}

function loadDoc(doc) {
  state.current = doc;
  editor.value = doc.text || "";
  docTitle.value = doc.name || "Untitled.md";
  store.setCurrentId(doc.id);
  updateStorageLoc();
  updateStats();
  updateCursor();
  renderNow();
  renderTree();
  setSaveState("saved");
  editor.scrollTop = 0;
}

function newDoc(name = "Untitled.md", text = "", folder = "") {
  const now = Date.now();
  const doc = { id: uid(), name, text, driveId: null, folder, created: now, updated: now };
  state.library = upsertDoc(state.library, doc);
  store.saveLibrary(state.library);
  loadDoc(doc);
  return doc;
}

/* ------------------------------------------------------------------ file metadata */
/** UTF-8 byte length of a document's text (what it costs on disk / in Drive). */
function docBytes(text) {
  return new TextEncoder().encode(text || "").length;
}
function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDate(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return (
    d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}
/** Documents created before metadata was tracked have no `created` stamp. */
function backfillDocMeta(lib) {
  let changed = false;
  for (const d of lib) {
    if (!d.created) {
      d.created = d.updated || Date.now();
      changed = true;
    }
  }
  return changed;
}

/* ============================ Unified file tree ============================
 * One sidebar tree over two sources: local docs (organized into virtual
 * folders via doc.folder) and the Google Drive "markdowns" subtree (lazy).
 * Every structural op writes straight back to its source.
 * ======================================================================== */
const LOCAL_ROOT_KEY = "ROOT:local";
const DRIVE_ROOT_KEY = "ROOT:drive";
const TWISTY_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M6 4l4 4-4 4z"></path></svg>';

function expandedMap() {
  return state.settings.expanded || (state.settings.expanded = {});
}
function isExpanded(key) {
  return expandedMap()[key] === true;
}
function setExpanded(key, on) {
  if (on) expandedMap()[key] = true;
  else delete expandedMap()[key];
  store.saveSettings(state.settings);
}
function toggleExpand(key) {
  setExpanded(key, !isExpanded(key));
  renderTree();
}
function localFolders() {
  return state.settings.localFolders || (state.settings.localFolders = []);
}

/* ---- context menu ---- */
let ctxEl = null;
function closeContextMenu() {
  ctxEl?.remove();
  ctxEl = null;
  document.removeEventListener("click", onCtxOutside, true);
}
function onCtxOutside(e) {
  if (ctxEl && !ctxEl.contains(e.target)) closeContextMenu();
}
function openContextMenu(x, y, items) {
  closeContextMenu();
  ctxEl = document.createElement("div");
  ctxEl.className = "ctx-menu";
  for (const [label, fn, danger] of items) {
    const b = document.createElement("button");
    if (danger) b.className = "danger";
    b.textContent = label;
    b.addEventListener("click", () => {
      closeContextMenu();
      fn();
    });
    ctxEl.appendChild(b);
  }
  ctxEl.style.left = Math.min(x, window.innerWidth - 170) + "px";
  ctxEl.style.top = Math.min(y, window.innerHeight - 40 - items.length * 30) + "px";
  document.body.appendChild(ctxEl);
  setTimeout(() => document.addEventListener("click", onCtxOutside, true), 0);
}

/* ---- one tree row ---- */
function makeRow(o) {
  const row = document.createElement("div");
  row.className = "tree-row " + (o.cls || "");
  if (o.active) row.classList.add("is-active");
  if (o.expandedFlag) row.classList.add("expanded");
  row.style.paddingLeft = 6 + o.depth * 13 + "px";
  row.setAttribute("role", "treeitem");

  const tw = document.createElement("span");
  tw.className = "tree-twisty" + (o.twisty ? "" : " spacer");
  if (o.twisty) tw.innerHTML = TWISTY_SVG;
  row.appendChild(tw);

  const ic = document.createElement("span");
  ic.className = "tree-icon";
  ic.innerHTML = o.icon;
  row.appendChild(ic);

  const lb = document.createElement("span");
  lb.className = "tree-label";
  lb.textContent = o.name;
  lb.title = o.name;
  row.appendChild(lb);

  if (o.badge) {
    const bd = document.createElement("span");
    bd.className = "tree-badge";
    bd.textContent = o.badge;
    row.appendChild(bd);
  }

  if (o.menu) {
    const kb = document.createElement("button");
    kb.className = "tree-kebab";
    kb.title = "Actions";
    kb.textContent = "⋯";
    kb.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = kb.getBoundingClientRect();
      openContextMenu(r.left, r.bottom + 2, o.menu());
    });
    row.appendChild(kb);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, o.menu());
    });
  }

  row.addEventListener("click", (e) => {
    if (e.target.closest(".tree-kebab")) return;
    if (o.onActivate) o.onActivate();
    else if (o.onToggle) o.onToggle();
  });

  if (o.dragData) {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", JSON.stringify(o.dragData));
      e.dataTransfer.effectAllowed = "move";
    });
  }
  // Folder rows accept both an in-app drag (a row, possibly from the *other*
  // source) and files dragged in from the computer.
  if (o.dropTarget) {
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.dataTransfer.types?.includes("Files") ? "copy" : "move";
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't also hit the window-level import handler
      row.classList.remove("drop-target");
      if (e.dataTransfer?.files?.length) {
        await importFilesInto(e.dataTransfer.files, o.dropTarget);
        return;
      }
      let dragData;
      try {
        dragData = JSON.parse(e.dataTransfer.getData("text/plain"));
      } catch {
        return; // not one of ours
      }
      await dropOnto(dragData, o.dropTarget);
    });
  }

  treeEl.appendChild(row);
  return row;
}
function appendHint(text, depth) {
  const d = document.createElement("div");
  d.className = "tree-hint";
  d.style.paddingLeft = 6 + depth * 13 + "px";
  d.textContent = text;
  treeEl.appendChild(d);
}

/* ---- build the local virtual-folder tree ---- */
function buildLocalTree() {
  const root = { name: "", path: "", folders: new Map(), files: [] };
  const ensurePath = (path) => {
    if (!path) return root;
    let node = root;
    let acc = "";
    for (const seg of path.split("/").filter(Boolean)) {
      acc = acc ? acc + "/" + seg : seg;
      if (!node.folders.has(seg)) {
        node.folders.set(seg, { name: seg, path: acc, folders: new Map(), files: [] });
      }
      node = node.folders.get(seg);
    }
    return node;
  };
  for (const p of localFolders()) ensurePath(p);
  for (const doc of state.library) {
    if (doc.driveId) continue; // Drive-backed docs render under the Drive tree
    ensurePath(doc.folder || "").files.push(doc);
  }
  return root;
}

/* ---- render ---- */
function renderTree() {
  closeContextMenu(); // an open menu's anchor row is about to be removed
  treeEl.innerHTML = "";

  makeRow({
    depth: 0,
    twisty: true,
    expandedFlag: isExpanded(LOCAL_ROOT_KEY),
    cls: "root folder",
    icon: DEVICE_ICON,
    name: "This browser",
    onToggle: () => toggleExpand(LOCAL_ROOT_KEY),
    dropTarget: { source: "local", path: "" },
    menu: () => [
      ["New file", () => newFileLocal("")],
      ["New folder", () => newFolderLocal("")],
    ],
  });
  if (isExpanded(LOCAL_ROOT_KEY)) renderLocalFolder(buildLocalTree(), 1);

  makeRow({
    depth: 0,
    twisty: true,
    expandedFlag: isExpanded(DRIVE_ROOT_KEY),
    cls: "root folder",
    icon: CLOUD_ICON,
    name: "Google Drive",
    onToggle: toggleDriveRoot,
    // Always droppable: the root folder is resolved (and created) on drop.
    dropTarget: { source: "drive", folderId: state.driveRootId },
    menu: state.driveRootId
      ? () => [
          ["New file", () => newFileDrive(state.driveRootId)],
          ["New folder", () => newFolderDrive(state.driveRootId)],
        ]
      : undefined,
  });
  if (isExpanded(DRIVE_ROOT_KEY)) {
    if (!google.isConfigured()) appendHint("Add a Google Client ID in Settings to use Drive.", 1);
    else if (state.driveRootId) renderDriveChildren(state.driveRootId, 1);
    else appendHint("Loading…", 1);
  }
}

function renderLocalFolder(node, depth) {
  const subs = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const sub of subs) {
    const key = "L:" + sub.path;
    makeRow({
      depth,
      twisty: true,
      expandedFlag: isExpanded(key),
      cls: "folder",
      icon: FOLDER_ICON,
      name: sub.name,
      onToggle: () => toggleExpand(key),
      dropTarget: { source: "local", path: sub.path },
      menu: () => [
        ["New file", () => newFileLocal(sub.path)],
        ["New folder", () => newFolderLocal(sub.path)],
        ["Rename", () => renameLocalFolder(sub.path)],
        ["Delete", () => deleteLocalFolder(sub.path), "danger"],
      ],
    });
    if (isExpanded(key)) renderLocalFolder(sub, depth + 1);
  }
  const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const doc of files) {
    makeRow({
      depth,
      twisty: false,
      cls: "file",
      icon: FILE_ICON,
      name: doc.name,
      active: doc.id === state.current?.id,
      onActivate: () => {
        if (doc.id !== state.current?.id) loadDoc(doc);
      },
      dragData: { source: "local", id: doc.id, name: doc.name },
      menu: () => [
        ["Rename", () => renameLocalDoc(doc)],
        ["Delete", () => deleteDoc(doc), "danger"],
      ],
    });
  }
  if (subs.length === 0 && files.length === 0) appendHint("Empty", depth);
}

function renderDriveChildren(folderId, depth) {
  const c = state.driveCache[folderId];
  if (!c) return;
  if (c.loading) return appendHint("Loading…", depth);
  if (c.error) return appendHint(c.error, depth);
  const folders = c.folders.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const f of folders) {
    const key = "D:" + f.id;
    makeRow({
      depth,
      twisty: true,
      expandedFlag: isExpanded(key),
      cls: "folder",
      icon: FOLDER_ICON,
      name: f.name,
      onToggle: () => toggleDriveFolder(f.id, key),
      dropTarget: { source: "drive", folderId: f.id },
      menu: () => [
        ["New file", () => newFileDrive(f.id)],
        ["New folder", () => newFolderDrive(f.id)],
        ["Rename", () => renameDriveFolder(f)],
        ["Delete", () => deleteDriveFolder(f, folderId), "danger"],
      ],
    });
    if (isExpanded(key)) renderDriveChildren(f.id, depth + 1);
  }
  const files = c.files.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const f of files) {
    makeRow({
      depth,
      twisty: false,
      cls: "file",
      icon: FILE_ICON,
      name: f.name,
      active: !!state.current?.driveId && state.current.driveId === f.id,
      onActivate: () => openDriveFile(f, folderId),
      dragData: { source: "drive", id: f.id, parentId: folderId, name: f.name },
      menu: () => [
        ["Rename", () => renameDriveFile(f, folderId)],
        ["Delete", () => deleteDriveFile(f, folderId), "danger"],
      ],
    });
  }
  if (c.loaded && folders.length === 0 && files.length === 0) appendHint("Empty", depth);
}

/* ---- lazy Drive loading ---- */
async function ensureDriveReady() {
  if (!google.isConfigured()) {
    toast("Add your Google Client ID in Settings first.", "error");
    openModal("settings-modal");
    return false;
  }
  if (!google.isSignedIn() || !google.getAccountId()) {
    await google.signIn();
    await onSignedIn(); // signing in here also switches accounts
  }
  refreshGoogleUI();
  if (!state.driveRootId) {
    const root = await google.drive.root();
    state.driveRootId = root.id;
    state.driveCache[root.id] = state.driveCache[root.id] || {
      name: root.name,
      folders: [],
      files: [],
      loaded: false,
    };
  }
  return true;
}
async function loadDriveFolder(folderId) {
  const c = (state.driveCache[folderId] = state.driveCache[folderId] || {
    folders: [],
    files: [],
    loaded: false,
  });
  if (c.loaded && !c.error) return;
  c.loading = true;
  renderTree();
  try {
    const { folders, files } = await google.drive.listChildren(folderId);
    c.folders = folders;
    c.files = files;
    c.loaded = true;
    c.error = null;
  } catch (e) {
    c.error = e.message || "Could not list this folder.";
  } finally {
    c.loading = false;
    renderTree();
  }
}
async function toggleDriveRoot() {
  if (isExpanded(DRIVE_ROOT_KEY)) {
    setExpanded(DRIVE_ROOT_KEY, false);
    renderTree();
    return;
  }
  try {
    if (!(await ensureDriveReady())) return;
    setExpanded(DRIVE_ROOT_KEY, true);
    renderTree();
    await loadDriveFolder(state.driveRootId);
  } catch (e) {
    toast(e.message || "Could not reach Google Drive.", "error");
  }
}
async function toggleDriveFolder(folderId, key) {
  const willExpand = !isExpanded(key);
  setExpanded(key, willExpand);
  renderTree();
  if (willExpand) await loadDriveFolder(folderId);
}

/* ---- local operations ---- */
function newFileLocal(folderPath) {
  setExpanded(LOCAL_ROOT_KEY, true);
  if (folderPath) setExpanded("L:" + folderPath, true);
  newDoc("Untitled.md", "", folderPath);
}
function newFolderLocal(parentPath) {
  const name = (prompt("New folder name:") || "").trim().replace(/\//g, "-");
  if (!name) return;
  const path = parentPath ? parentPath + "/" + name : name;
  const lf = localFolders();
  if (!lf.includes(path)) lf.push(path);
  store.saveSettings(state.settings);
  setExpanded(LOCAL_ROOT_KEY, true);
  if (parentPath) setExpanded("L:" + parentPath, true);
  setExpanded("L:" + path, true);
  renderTree();
}
function renameLocalDoc(doc) {
  const name = (prompt("Rename document:", doc.name) || "").trim();
  if (!name || name === doc.name) return;
  doc.name = name;
  if (doc.id === state.current?.id) docTitle.value = name;
  persist(doc);
}
function renamePrefix(p, oldP, newP) {
  if (p === oldP) return newP;
  if (p.startsWith(oldP + "/")) return newP + p.slice(oldP.length);
  return p;
}
function renameLocalFolder(path) {
  const segs = path.split("/");
  const cur = segs[segs.length - 1];
  const name = (prompt("Rename folder:", cur) || "").trim().replace(/\//g, "-");
  if (!name || name === cur) return;
  const newPath = segs.slice(0, -1).concat(name).join("/");
  state.settings.localFolders = localFolders().map((p) => renamePrefix(p, path, newPath));
  for (const d of state.library) {
    if (!d.driveId && d.folder) d.folder = renamePrefix(d.folder, path, newPath);
  }
  const em = expandedMap();
  for (const k of Object.keys(em)) {
    if (k === "L:" + path || k.startsWith("L:" + path + "/")) {
      em["L:" + renamePrefix(k.slice(2), path, newPath)] = true;
      delete em[k];
    }
  }
  store.saveLibrary(state.library);
  store.saveSettings(state.settings);
  renderTree();
  toast("Folder renamed");
}
function deleteLocalFolder(path) {
  const docs = state.library.filter(
    (d) => !d.driveId && (d.folder === path || (d.folder || "").startsWith(path + "/")),
  );
  if (!confirm(`Delete folder "${path}" and its ${docs.length} document(s) from this browser?`)) return;
  const ids = new Set(docs.map((d) => d.id));
  state.library = state.library.filter((d) => !ids.has(d.id));
  state.settings.localFolders = localFolders().filter((p) => p !== path && !p.startsWith(path + "/"));
  store.saveLibrary(state.library);
  store.saveSettings(state.settings);
  if (state.current && ids.has(state.current.id)) {
    const next = state.library[0];
    if (next) loadDoc(next);
    else newDoc();
  } else {
    renderTree();
  }
  toast("Folder deleted");
}
function moveLocal(dragData, targetPath) {
  if (!dragData || dragData.source !== "local") return;
  const doc = state.library.find((d) => d.id === dragData.id);
  if (!doc || (doc.folder || "") === targetPath) return;
  doc.folder = targetPath;
  if (targetPath) setExpanded("L:" + targetPath, true);
  persist(doc);
  toast("Moved");
}

/* ---- crossing between "This browser" and Google Drive ----
 * Dragging between the two roots used to be a silent no-op. A drag from this
 * browser onto a Drive folder now uploads the document (a real move — it stops
 * being browser-only and becomes reachable from the user's other devices); the
 * reverse direction copies the file down without touching the Drive original,
 * so a drag can never destroy the only copy of something.
 */

/** Resolve a Drive drop target, falling back to the app's root folder. */
async function resolveDriveFolder(folderId) {
  if (folderId) return folderId;
  if (state.driveRootId) return state.driveRootId;
  return (await google.drive.root()).id;
}

/** Remember a newly created Drive file in the cache so the UI shows it at once. */
function cacheDriveFile(parentId, res) {
  const c = state.driveCache[parentId];
  if (c && c.loaded) {
    c.files.push({
      id: res.id,
      name: res.name,
      size: res.size,
      createdTime: res.createdTime,
      modifiedTime: res.modifiedTime,
    });
  }
}

/** Move a browser-only document into a Drive folder (upload + rebind). */
async function moveLocalDocToDrive(dragData, targetFolderId) {
  const existing = state.library.find((d) => d.id === dragData.id);
  if (!existing) return;
  if (existing.driveId) {
    toast("That document is already in Drive");
    return;
  }
  setSaveState("saving");
  try {
    await ensureSignedIn();
    // Signing in can switch accounts, which reloads state.library into fresh
    // objects — re-resolve rather than writing through a stale reference.
    const doc = state.library.find((d) => d.id === dragData.id);
    if (!doc) {
      setSaveState("saved");
      toast("That document isn't in the signed-in account", "error");
      return;
    }
    const parent = await resolveDriveFolder(targetFolderId);
    const res = await google.drive.create(ensureMdName(doc.name), doc.text || "", parent);
    doc.driveId = res.id;
    doc.driveName = res.name || doc.name;
    doc.driveParentId = (res.parents && res.parents[0]) || parent;
    doc.folder = ""; // it lives in Drive now, not in a local virtual folder
    cacheDriveFile(parent, res);
    setExpanded(DRIVE_ROOT_KEY, true);
    if (parent !== state.driveRootId) setExpanded("D:" + parent, true);
    persist(doc);
    updateStorageLoc();
    setSaveState("saved");
    toast(`Moved “${doc.name}” to Drive`, "success");
  } catch (e) {
    setSaveState("error");
    toast(e.message || "Could not move that file to Drive", "error");
  }
}

/** Copy a Drive file into this browser. The Drive original is left alone. */
async function copyDriveFileToLocal(dragData, targetPath) {
  try {
    const text = await google.drive.read(dragData.id);
    const name = dragData.name || "Untitled.md";
    const now = Date.now();
    const doc = {
      id: uid(), name, text, driveId: null,
      folder: targetPath || "", created: now, updated: now,
    };
    state.library = upsertDoc(state.library, doc);
    store.saveLibrary(state.library);
    setExpanded(LOCAL_ROOT_KEY, true);
    if (targetPath) setExpanded("L:" + targetPath, true);
    renderTree();
    renderFiles();
    toast(`Copied “${name}” into this browser`, "success");
  } catch (e) {
    toast(e.message || "Could not copy that file from Drive", "error");
  }
}

/** Route an in-app drag to the right handler, including across sources. */
async function dropOnto(dragData, target) {
  if (!dragData || !target) return;
  const from = dragData.source;
  if (from === "local" && target.source === "local") return moveLocal(dragData, target.path || "");
  if (from === "drive" && target.source === "drive") {
    return moveDrive(dragData, await resolveDriveFolder(target.folderId));
  }
  if (from === "local" && target.source === "drive") {
    return moveLocalDocToDrive(dragData, target.folderId);
  }
  if (from === "drive" && target.source === "local") {
    return copyDriveFileToLocal(dragData, target.path || "");
  }
}

/* ---- importing files from the computer ---- */
const IMPORTABLE = /\.(md|markdown|txt|mmd)$/i;

/**
 * Import dropped/picked files into a specific place — a local folder or a Drive
 * folder. This is what makes "drag a file from my computer onto Google Drive"
 * work; previously only the editor accepted a drop, and it always landed in the
 * browser's local library.
 * @param {FileList|File[]} fileList
 * @param {{source:"local",path?:string}|{source:"drive",folderId?:string}} target
 */
async function importFilesInto(fileList, target) {
  const all = [...(fileList || [])];
  const files = all.filter((f) => IMPORTABLE.test(f.name));
  const skipped = all.length - files.length;
  if (!files.length) {
    toast(all.length ? "Only .md / .markdown / .txt / .mmd files can be imported" : "Nothing to import", "error");
    return;
  }
  let ok = 0;
  let lastLocalDoc = null;
  try {
    if (target?.source === "drive") {
      await ensureSignedIn();
      const parent = await resolveDriveFolder(target.folderId);
      for (const f of files) {
        try {
          const res = await google.drive.create(ensureMdName(f.name), await f.text(), parent);
          cacheDriveFile(parent, res);
          ok++;
        } catch {
          /* keep importing the rest; the count reports the truth */
        }
      }
      setExpanded(DRIVE_ROOT_KEY, true);
      if (parent !== state.driveRootId) setExpanded("D:" + parent, true);
    } else {
      const folder = target?.path || "";
      for (const f of files) {
        const now = Date.now();
        lastLocalDoc = {
          id: uid(), name: f.name, text: await f.text(), driveId: null,
          folder, created: now, updated: now,
        };
        state.library = upsertDoc(state.library, lastLocalDoc);
        ok++;
      }
      store.saveLibrary(state.library);
      setExpanded(LOCAL_ROOT_KEY, true);
      if (folder) setExpanded("L:" + folder, true);
    }
  } catch (e) {
    toast(e.message || "Import failed", "error");
    return;
  }
  renderTree();
  renderFiles();
  // Opening a single imported local file matches what the editor drop used to do.
  if (ok === 1 && lastLocalDoc) loadDoc(lastLocalDoc);
  const where = target?.source === "drive" ? "Drive" : "this browser";
  toast(
    `Imported ${ok} file${ok === 1 ? "" : "s"} into ${where}` + (skipped ? ` · skipped ${skipped}` : ""),
    ok ? "success" : "error",
  );
}

/* ---- Drive operations ---- */
async function newFileDrive(parentId) {
  const raw = (prompt("New file name:", "Untitled.md") || "").trim();
  if (!raw) return;
  const name = ensureMdName(raw);
  try {
    const res = await google.drive.create(name, "", parentId);
    const c = state.driveCache[parentId];
    if (c && c.loaded) c.files.push(res);
    const doc = {
      id: uid(),
      name: res.name || name,
      text: "",
      driveId: res.id,
      driveName: res.name || name,
      driveParentId: parentId,
      updated: Date.now(),
    };
    state.library = upsertDoc(state.library, doc);
    store.saveLibrary(state.library);
    loadDoc(doc);
    toast("Created in Drive", "success");
  } catch (e) {
    toast(e.message || "Could not create file", "error");
  }
}
async function newFolderDrive(parentId) {
  const name = (prompt("New folder name:") || "").trim().replace(/\//g, "-");
  if (!name) return;
  try {
    const res = await google.drive.createFolder(name, parentId);
    const c = state.driveCache[parentId];
    if (c && c.loaded) c.folders.push({ id: res.id, name: res.name });
    state.driveCache[res.id] = { name: res.name, folders: [], files: [], loaded: true };
    renderTree();
    toast("Folder created", "success");
  } catch (e) {
    toast(e.message || "Could not create folder", "error");
  }
}
async function renameDriveFile(f, parentId) {
  const name = ensureMdName((prompt("Rename file:", f.name) || "").trim());
  if (!name || name === f.name) return;
  try {
    await google.drive.rename(f.id, name);
    f.name = name;
    const doc = state.library.find((d) => d.driveId === f.id);
    if (doc) {
      doc.name = name;
      doc.driveName = name;
      if (doc.id === state.current?.id) docTitle.value = name;
      store.saveLibrary(state.library);
    }
    void parentId;
    renderTree();
    toast("Renamed", "success");
  } catch (e) {
    toast(e.message || "Could not rename", "error");
  }
}
async function renameDriveFolder(f) {
  const name = (prompt("Rename folder:", f.name) || "").trim().replace(/\//g, "-");
  if (!name || name === f.name) return;
  try {
    await google.drive.rename(f.id, name);
    f.name = name;
    if (state.driveCache[f.id]) state.driveCache[f.id].name = name;
    renderTree();
    toast("Renamed", "success");
  } catch (e) {
    toast(e.message || "Could not rename", "error");
  }
}
async function deleteDriveFile(f, parentId) {
  if (!confirm(`Move "${f.name}" to the Google Drive trash?`)) return;
  try {
    await google.drive.trash(f.id);
    const c = state.driveCache[parentId];
    if (c) c.files = c.files.filter((x) => x.id !== f.id);
    const doc = state.library.find((d) => d.driveId === f.id);
    if (doc) {
      state.library = removeDoc(state.library, doc.id);
      store.saveLibrary(state.library);
      if (state.current?.id === doc.id) {
        const next = state.library[0];
        if (next) loadDoc(next);
        else newDoc();
        toast("Moved to Drive trash");
        return;
      }
    }
    renderTree();
    toast("Moved to Drive trash");
  } catch (e) {
    toast(e.message || "Could not delete", "error");
  }
}
async function deleteDriveFolder(f, parentId) {
  if (!confirm(`Move folder "${f.name}" and its contents to the Google Drive trash?`)) return;
  try {
    await google.drive.trash(f.id);
    const c = state.driveCache[parentId];
    if (c) c.folders = c.folders.filter((x) => x.id !== f.id);
    delete state.driveCache[f.id];
    renderTree();
    toast("Moved to Drive trash");
  } catch (e) {
    toast(e.message || "Could not delete", "error");
  }
}
async function moveDrive(dragData, targetId) {
  if (!dragData || dragData.source !== "drive" || dragData.parentId === targetId) return;
  try {
    await google.drive.move(dragData.id, targetId, dragData.parentId);
    const from = state.driveCache[dragData.parentId];
    let moved;
    if (from) {
      moved = from.files.find((x) => x.id === dragData.id);
      from.files = from.files.filter((x) => x.id !== dragData.id);
    }
    const to = state.driveCache[targetId];
    if (to && to.loaded && moved) to.files.push(moved);
    const doc = state.library.find((d) => d.driveId === dragData.id);
    if (doc) {
      doc.driveParentId = targetId;
      store.saveLibrary(state.library);
    }
    renderTree();
    toast("Moved");
  } catch (e) {
    toast(e.message || "Could not move", "error");
  }
}

function deleteDoc(doc) {
  if (!confirm(`Delete "${doc.name}"? This only removes it from this browser.`)) return;
  state.library = removeDoc(state.library, doc.id);
  store.saveLibrary(state.library);
  if (state.current?.id === doc.id) {
    const next = state.library[0];
    if (next) loadDoc(next);
    else newDoc();
  } else {
    renderTree();
  }
  toast("Document deleted");
}

/* ============================ File browser ============================
 * A full-width "details" view over the same two sources as the sidebar tree,
 * with real folder navigation and sortable Name / Size / Created / Modified
 * columns. The tree stays for quick switching; this is for actually managing
 * files. Local sizes are computed from the document text; Drive supplies its
 * own size/createdTime/modifiedTime.
 * ==================================================================== */
const filesState = {
  trail: [], // breadcrumb: [{ name, source, path, folderId }]
  sort: "name",
  dir: 1,
};
const filesHere = () => filesState.trail[filesState.trail.length - 1] || null;

/**
 * Roll a local folder's contents up into the numbers the details table shows:
 * total bytes, earliest creation and latest edit across everything inside it.
 * Virtual folders have no timestamps of their own, so this is what makes the
 * Created/Modified columns meaningful for them.
 */
function aggregateLocalFolder(node) {
  let bytes = 0;
  let created = Infinity;
  let modified = 0;
  const walk = (n) => {
    for (const d of n.files) {
      bytes += docBytes(d.text);
      if (d.created) created = Math.min(created, d.created);
      if (d.updated) modified = Math.max(modified, d.updated);
    }
    for (const sub of n.folders.values()) walk(sub);
  };
  walk(node);
  return { bytes, created: created === Infinity ? null : created, modified: modified || null };
}

/** Walk the local virtual-folder tree down to `path`. */
function localNodeAt(path) {
  let node = buildLocalTree();
  for (const seg of (path || "").split("/").filter(Boolean)) {
    node = node.folders.get(seg);
    if (!node) return null;
  }
  return node;
}

/** Rows for the current location, as a source-agnostic shape. */
async function collectFileRows() {
  const here = filesHere();

  // Root: the two sources themselves.
  if (!here) {
    return [
      { kind: "folder", name: "This browser", icon: DEVICE_ICON, nav: { name: "This browser", source: "local", path: "" } },
      { kind: "folder", name: "Google Drive", icon: CLOUD_ICON, nav: { name: "Google Drive", source: "drive", folderId: null } },
    ];
  }

  if (here.source === "local") {
    const node = localNodeAt(here.path);
    if (!node) return [];
    const rows = [];
    for (const sub of node.folders.values()) {
      const agg = aggregateLocalFolder(sub);
      rows.push({
        kind: "folder", name: sub.name, icon: FOLDER_ICON, source: "local", path: sub.path,
        size: agg.bytes, created: agg.created, modified: agg.modified,
        nav: { name: sub.name, source: "local", path: sub.path },
        menu: () => [
          ["Rename", () => { renameLocalFolder(sub.path); renderFiles(); }],
          ["Delete", () => { deleteLocalFolder(sub.path); renderFiles(); }, "danger"],
        ],
      });
    }
    for (const doc of node.files) {
      rows.push({
        kind: "file", name: doc.name, icon: FILE_ICON, source: "local",
        size: docBytes(doc.text), created: doc.created, modified: doc.updated,
        open: () => { loadDoc(doc); closeFiles(); },
        menu: () => [
          ["Rename", () => { renameLocalDoc(doc); renderFiles(); }],
          ["Delete", () => { deleteDoc(doc); renderFiles(); }, "danger"],
        ],
      });
    }
    return rows;
  }

  // Drive: make sure this folder is loaded, then read the cache.
  if (!google.isConfigured()) {
    return [{ kind: "note", name: "Google isn't set up for this site yet — add a Client ID in Settings." }];
  }
  if (!(await ensureDriveReady())) return [];
  const folderId = here.folderId || state.driveRootId;
  if (!here.folderId) here.folderId = folderId;
  await loadDriveFolder(folderId);
  const c = state.driveCache[folderId];
  if (!c) return [];
  if (c.error) return [{ kind: "error", name: c.error }];
  const rows = [];
  for (const f of c.folders) {
    rows.push({
      kind: "folder", name: f.name, icon: FOLDER_ICON, source: "drive",
      created: f.createdTime, modified: f.modifiedTime,
      nav: { name: f.name, source: "drive", folderId: f.id },
      menu: () => [
        ["Rename", async () => { await renameDriveFolder(f); renderFiles(); }],
        ["Delete", async () => { await deleteDriveFolder(f, folderId); renderFiles(); }, "danger"],
      ],
    });
  }
  for (const f of c.files) {
    rows.push({
      kind: "file", name: f.name, icon: FILE_ICON, source: "drive",
      size: f.size != null ? Number(f.size) : null,
      created: f.createdTime, modified: f.modifiedTime,
      open: async () => { await openDriveFile(f, folderId); closeFiles(); },
      menu: () => [
        ["Rename", async () => { await renameDriveFile(f, folderId); renderFiles(); }],
        ["Delete", async () => { await deleteDriveFile(f, folderId); renderFiles(); }, "danger"],
      ],
    });
  }
  return rows;
}

function sortFileRows(rows) {
  const { sort, dir } = filesState;
  const val = (r) => {
    if (sort === "size") return r.size ?? -1;
    if (sort === "created") return r.created ? new Date(r.created).getTime() : 0;
    if (sort === "modified") return r.modified ? new Date(r.modified).getTime() : 0;
    return String(r.name || "").toLowerCase();
  };
  return rows.slice().sort((a, b) => {
    // Folders always lead, regardless of the active column.
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const x = val(a);
    const y = val(b);
    if (typeof x === "string") return dir * x.localeCompare(y);
    return dir * (x - y);
  });
}

function renderFilesCrumbs() {
  const nav = $("files-crumbs");
  nav.innerHTML = "";
  const add = (label, index) => {
    const b = document.createElement("button");
    b.className = "crumb";
    b.textContent = label;
    b.addEventListener("click", () => {
      filesState.trail = filesState.trail.slice(0, index);
      renderFiles();
    });
    nav.appendChild(b);
  };
  add("All files", 0);
  filesState.trail.forEach((t, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "›";
    nav.appendChild(sep);
    add(t.name, i + 1);
  });
}

async function renderFiles() {
  if (!app.classList.contains("files-open")) return;
  renderFilesCrumbs();
  const body = $("files-rows");
  body.innerHTML = `<tr><td colspan="5" class="files-empty">Loading…</td></tr>`;
  let rows;
  try {
    rows = await collectFileRows();
  } catch (e) {
    body.innerHTML = "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="files-empty"></td>`;
    tr.querySelector("td").textContent = e.message || "Could not list this folder.";
    body.appendChild(tr);
    return;
  }
  body.innerHTML = "";
  document.querySelectorAll(".files-table th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === filesState.sort);
    th.dataset.dir = th.dataset.sort === filesState.sort ? (filesState.dir > 0 ? "asc" : "desc") : "";
  });
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="files-empty">This folder is empty.</td></tr>`;
    return;
  }
  if (rows.length === 1 && (rows[0].kind === "note" || rows[0].kind === "error")) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "files-empty";
    td.textContent = rows[0].name;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  // At the root the two sources keep their natural order (This browser first,
  // matching the sidebar); inside a folder the chosen column sorts.
  const ordered = filesHere() ? sortFileRows(rows) : rows;
  for (const r of ordered) {
    const tr = document.createElement("tr");
    tr.className = "files-row " + r.kind;

    const nameCell = document.createElement("td");
    nameCell.className = "files-name";
    const ic = document.createElement("span");
    ic.className = "files-icon";
    ic.innerHTML = r.icon || FILE_ICON;
    const label = document.createElement("span");
    label.className = "files-label";
    label.textContent = r.name;
    nameCell.append(ic, label);
    tr.appendChild(nameCell);

    const cell = (text, cls) => {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    };
    // Drive folders report no size; local folders roll their contents up.
    cell(r.size != null ? fmtBytes(r.size) : "—", "files-size");
    cell(fmtDate(r.created), "files-date");
    cell(fmtDate(r.modified), "files-date");

    const actions = document.createElement("td");
    actions.className = "files-actions-cell";
    if (r.menu) {
      const kb = document.createElement("button");
      kb.className = "tree-kebab";
      kb.textContent = "⋯";
      kb.title = "Actions";
      kb.addEventListener("click", (e) => {
        e.stopPropagation();
        const box = kb.getBoundingClientRect();
        openContextMenu(box.left, box.bottom + 2, r.menu());
      });
      actions.appendChild(kb);
    }
    tr.appendChild(actions);

    if (r.nav || r.open) {
      tr.tabIndex = 0;
      const go = () => {
        if (r.nav) {
          filesState.trail = [...filesState.trail, r.nav];
          renderFiles();
        } else r.open();
      };
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".tree-kebab")) return;
        go();
      });
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
    }
    body.appendChild(tr);
  }
}

function openFiles() {
  app.classList.add("files-open");
  $("files-view").hidden = false;
  renderFiles();
}
function closeFiles() {
  app.classList.remove("files-open");
  $("files-view").hidden = true;
}
function toggleFiles() {
  if (app.classList.contains("files-open")) closeFiles();
  else openFiles();
}

/**
 * Where an import lands when it happens in the Files view: whichever folder is
 * on screen. At the very root (the two sources) we default to this browser,
 * and the toast says where the files went.
 */
function filesDropTarget() {
  const here = filesHere();
  if (!here) return { source: "local", path: "" };
  return here.source === "drive"
    ? { source: "drive", folderId: here.folderId }
    : { source: "local", path: here.path };
}

/** Import… button in the Files view — picks files for the current folder. */
function filesImport() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".md,.markdown,.txt,.mmd,text/markdown,text/plain";
  input.addEventListener("change", () => importFilesInto(input.files, filesDropTarget()));
  input.click();
}

/** "New folder" inside whatever location the browser is showing. */
async function filesNewFolder() {
  const here = filesHere();
  if (!here) return toast("Open This browser or Google Drive first");
  if (here.source === "local") {
    newFolderLocal(here.path);
    renderFiles();
  } else {
    await newFolderDrive(here.folderId || state.driveRootId);
    renderFiles();
  }
}

/* ------------------------------------------------------------------ autosave on edit */
function onEdit() {
  if (!state.current) return;
  state.current.text = editor.value;
  invalidateLineOffsets(); // wrapped-line layout changed
  setSaveState("dirty");
  updateStats();
  scheduleRender();
  clearTimeout(state.saveTimer);
  // Autosave content without rebuilding the tree (name/structure unchanged).
  state.saveTimer = setTimeout(() => persist(state.current, { rerender: false }), 500);
}

/* ------------------------------------------------------------------ Google Drive */
function ensureMdName(name) {
  return /\.(md|markdown|txt|mmd)$/i.test(name) ? name : name.replace(/\s+$/, "") + ".md";
}

// Save the current doc to Drive. targetFolderId (optional) places a NEW file in,
// or MOVES an existing file to, that folder; omitted → keep current location
// (root for new files).
async function saveToDrive(targetFolderId) {
  if (!google.isConfigured()) {
    toast("Add your Google Client ID in Settings to enable Drive.", "error");
    openModal("settings-modal");
    return;
  }
  setSaveState("saving");
  try {
    if (!google.isSignedIn()) await google.signIn();
    const name = ensureMdName(state.current.name);
    if (state.current.driveId) {
      // update() only writes content; title/location changes go separately.
      await google.drive.update(state.current.driveId, state.current.text);
      if (name !== state.current.driveName) {
        const renamed = await google.drive.rename(state.current.driveId, name);
        state.current.name = renamed.name || name;
        state.current.driveName = renamed.name || name;
        docTitle.value = state.current.name;
      }
      if (targetFolderId && targetFolderId !== state.current.driveParentId) {
        await google.drive.move(state.current.driveId, targetFolderId, state.current.driveParentId);
        state.current.driveParentId = targetFolderId;
      }
    } else {
      const res = await google.drive.create(name, state.current.text, targetFolderId);
      state.current.driveId = res.id;
      state.current.driveParentId = (res.parents && res.parents[0]) || targetFolderId || null;
      state.current.name = res.name || name;
      state.current.driveName = res.name || name;
      docTitle.value = state.current.name;
    }
    persist(state.current);
    updateStorageLoc();
    refreshGoogleUI();
    toast("Saved to Google Drive", "success");
  } catch (e) {
    setSaveState("error");
    toast(e.message || "Google Drive save failed", "error");
  }
}

async function openDriveFile(f, parentId) {
  try {
    const text = await google.drive.read(f.id);
    closeModals();
    // Reuse an existing local doc bound to this Drive file, if any.
    const existing = state.library.find((d) => d.driveId === f.id);
    if (existing) {
      existing.text = text;
      existing.name = f.name;
      existing.driveName = f.name;
      existing.driveParentId = parentId || existing.driveParentId || null;
      existing.updated = Date.now();
      store.saveLibrary(state.library); // persist refreshed content immediately
      loadDoc(existing);
    } else {
      const doc = {
        id: uid(),
        name: f.name,
        text,
        driveId: f.id,
        driveName: f.name,
        driveParentId: parentId || null,
        updated: Date.now(),
      };
      state.library = upsertDoc(state.library, doc);
      store.saveLibrary(state.library);
      loadDoc(doc);
    }
    toast("Opened from Drive", "success");
  } catch (e) {
    toast(e.message || "Could not open the file", "error");
  }
}

function refreshGoogleUI() {
  const p = google.getProfile();
  // Treat a valid token as "connected" even if the profile fetch failed, so the
  // user can still reach the Drive menu / Sign out.
  if (p || google.isSignedIn()) {
    googleBtn.classList.add("is-connected");
    googleLabel.textContent = p ? (p.given_name || p.name || "Account").split(" ")[0] : "Account";
    if (p?.picture) {
      googleAvatar.src = p.picture;
      googleAvatar.hidden = false;
    } else {
      googleAvatar.hidden = true;
    }
    googleBtn.title = `${p?.email || "Signed in"} — click for Drive actions`;
  } else {
    googleBtn.classList.remove("is-connected");
    googleLabel.textContent = "Sign in";
    googleAvatar.hidden = true;
    googleBtn.title = google.isConfigured()
      ? "Sign in with Google to sync to Drive"
      : "Add a Google Client ID in Settings to enable Drive";
  }
}

/* ============================ Accounts ============================
 * Signing in with Google IS the account system: there is no backend, no
 * password to store and no key for the user to paste. The deployment ships one
 * public OAuth Client ID (config.js) and each person signs in with their own
 * Google account, which gives them:
 *   - their own documents, in their own Drive, on every device they sign in on;
 *   - isolation from anyone else sharing this browser, because the account id
 *     namespaces local storage (see storage.js setAccount).
 * ================================================================== */

/** Re-point the app at the current storage namespace and rebuild the UI. */
function reloadForAccount() {
  state.settings = store.loadSettings();
  state.library = store.loadLibrary();
  if (backfillDocMeta(state.library)) store.saveLibrary(state.library);

  // Drive ids belong to whoever was signed in before — never reuse them.
  state.driveRootId = null;
  state.driveCache = {};

  if (!state.settings.expanded) state.settings.expanded = { [LOCAL_ROOT_KEY]: true };
  for (const k of Object.keys(state.settings.expanded)) {
    if (k === DRIVE_ROOT_KEY || k.startsWith("D:")) delete state.settings.expanded[k];
  }

  if (state.settings.theme) applyTheme(state.settings.theme === "dark");
  setView(state.settings.view || state.view);
  const collapsed = !!state.settings.sidebarCollapsed;
  app.classList.toggle("sidebar-collapsed", collapsed);
  $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));

  const currentId = store.getCurrentId();
  const doc = state.library.find((d) => d.id === currentId) || state.library[0];
  if (doc) loadDoc(doc);
  else newDoc("Welcome.md", SAMPLE);
  renderTree();
}

/** Runs after every successful Google sign-in. */
async function onSignedIn() {
  const id = google.getAccountId();
  refreshGoogleUI();
  if (!id) return; // token but no profile — stay in the signed-out namespace
  const anonLib = store.loadLibraryOf("anon");
  setAccount(id);
  if (store.loadLibrary().length === 0 && anonLib.length) {
    // First sign-in on this browser: adopt the signed-out library so existing
    // work follows the user into their account instead of seeming to vanish.
    store.saveLibrary(anonLib.map((d) => ({ ...d })));
    toast(`Added ${anonLib.length} document${anonLib.length === 1 ? "" : "s"} from this browser to your account`);
  }
  reloadForAccount();
  refreshGoogleUI();
}

/** Sign in (if needed) and switch to that account's documents. */
async function ensureSignedIn() {
  if (google.isSignedIn() && google.getAccountId()) return true;
  await google.signIn();
  await onSignedIn();
  return true;
}

/**
 * Upload every document that currently exists only in this browser to the
 * signed-in user's Drive — this is what makes "saved locally" reachable from
 * their other devices.
 */
async function syncLocalDocsToDrive() {
  if (!google.isConfigured()) {
    toast("Google isn't configured for this site yet.", "error");
    openModal("settings-modal");
    return;
  }
  const pending = state.library.filter((d) => !d.driveId);
  if (!pending.length) {
    toast("Every document is already in your Drive", "success");
    return;
  }
  setSaveState("saving");
  let ok = 0;
  try {
    await ensureSignedIn();
    const root = await google.drive.root();
    for (const doc of pending) {
      try {
        const res = await google.drive.create(ensureMdName(doc.name), doc.text || "", root.id);
        doc.driveId = res.id;
        doc.driveName = res.name || doc.name;
        doc.driveParentId = (res.parents && res.parents[0]) || root.id;
        ok++;
      } catch {
        /* one bad file shouldn't abort the rest; the count reports the truth */
      }
    }
    store.saveLibrary(state.library);
    state.driveCache = {};
    renderTree();
    setSaveState(ok === pending.length ? "saved" : "error");
    toast(
      `Synced ${ok} of ${pending.length} document${pending.length === 1 ? "" : "s"} to Drive`,
      ok === pending.length ? "success" : "error",
    );
  } catch (e) {
    setSaveState("error");
    toast(e.message || "Could not sync to Drive", "error");
  }
}

/* Small popover menu for signed-in Google actions. */
let menuEl = null;
function toggleGoogleMenu() {
  if (menuEl) return closeGoogleMenu();
  menuEl = document.createElement("div");
  menuEl.className = "modal";
  Object.assign(menuEl.style, {
    position: "fixed",
    width: "200px",
    padding: "6px",
    borderRadius: "10px",
  });
  const rect = googleBtn.getBoundingClientRect();
  menuEl.style.top = rect.bottom + 6 + "px";
  menuEl.style.left = Math.max(8, rect.right - 200) + "px";
  const localOnly = state.library.filter((d) => !d.driveId).length;
  const actions = [
    ["Save current doc to Drive", () => saveToDrive()],
    [
      localOnly
        ? `Sync ${localOnly} browser-only file${localOnly === 1 ? "" : "s"} to Drive`
        : "All files are synced to Drive",
      () => (localOnly ? syncLocalDocsToDrive() : toast("Every document is already in your Drive", "success")),
    ],
    ["Show Drive files", () => {
      if (!isExpanded(DRIVE_ROOT_KEY)) toggleDriveRoot();
    }],
    ["Sign out", doSignOut],
  ];
  for (const [label, fn] of actions) {
    const b = document.createElement("button");
    b.className = "ghost-btn";
    b.style.width = "100%";
    b.style.margin = "2px 0";
    b.style.textAlign = "left";
    b.textContent = label;
    b.addEventListener("click", () => {
      closeGoogleMenu();
      fn();
    });
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
  setTimeout(() => document.addEventListener("click", onMenuOutside), 0);
}
function onMenuOutside(e) {
  if (menuEl && !menuEl.contains(e.target) && e.target !== googleBtn) closeGoogleMenu();
}
function closeGoogleMenu() {
  document.removeEventListener("click", onMenuOutside);
  menuEl?.remove();
  menuEl = null;
}

async function onGoogleButton() {
  if (!google.isConfigured()) {
    openModal("settings-modal");
    toast("Add your Google Client ID to enable Drive.");
    return;
  }
  if (google.getProfile() || google.isSignedIn()) {
    toggleGoogleMenu();
    return;
  }
  try {
    await google.signIn();
    await onSignedIn(); // switch to this account's documents
    const p = google.getProfile();
    toast(p?.email ? `Signed in as ${p.email}` : "Signed in to Google", "success");
  } catch (e) {
    toast(e.message || "Google sign-in failed", "error");
  }
}

function doSignOut() {
  google.signOut();
  setAccount(null); // back to this browser's signed-out library
  reloadForAccount();
  refreshGoogleUI();
  toast("Signed out — showing this browser's documents");
}

/* ------------------------------------------------------------------ editor formatting */
function surround(before, after = before, placeholder = "") {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const sel = editor.value.slice(start, end) || placeholder;
  const text = before + sel + after;
  editor.setRangeText(text, start, end, "end");
  if (!editor.value.slice(start, end)) {
    // reposition inside for empty selection
    editor.selectionStart = editor.selectionEnd = start + before.length + sel.length;
  }
  editor.focus();
  onEdit();
}

function prefixLines(prefix) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const block = value.slice(lineStart, end);
  const replaced = block
    .split("\n")
    .map((l, i) => (typeof prefix === "function" ? prefix(l, i) : prefix + l))
    .join("\n");
  editor.setRangeText(replaced, lineStart, end, "end");
  editor.focus();
  onEdit();
}

function insertBlock(text) {
  const start = editor.selectionStart;
  const before = editor.value.slice(0, start);
  const pad = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  editor.setRangeText(pad + text, start, editor.selectionEnd, "end");
  editor.focus();
  onEdit();
}

const FORMATTERS = {
  bold: () => surround("**", "**", "bold text"),
  italic: () => surround("_", "_", "italic text"),
  strike: () => surround("~~", "~~", "struck text"),
  code: () => surround("`", "`", "code"),
  h1: () => prefixLines("# "),
  h2: () => prefixLines("## "),
  quote: () => prefixLines("> "),
  ul: () => prefixLines("- "),
  ol: () => prefixLines((l, i) => `${i + 1}. ${l}`),
  task: () => prefixLines("- [ ] "),
  link: () => surround("[", "](https://)", "link text"),
  image: () => insertBlock("![alt text](https://)"),
  table: () =>
    insertBlock("| Column A | Column B |\n| -------- | -------- |\n| Cell 1   | Cell 2   |\n"),
  codeblock: () => insertBlock("```js\n\n```"),
  hr: () => insertBlock("---\n"),
};

/* ------------------------------------------------------------------ scroll sync
 * The preview's scroll container is `.preview-pane` (the .pane wrapper), NOT the
 * inner #preview article — setting scrollTop on #preview is a no-op. We align the
 * two panes by the `data-source-line` anchors render.js stamps on block elements:
 * the source line at the top of the editor maps to the matching preview element,
 * and vice-versa. Falls back to a proportional map when no anchors are present.
 */
const previewPane = $("preview-pane");

// Wrap-aware mapping between the editor's scroll position and its source line.
// A textarea wraps long lines, so scrollTop / lineHeight is NOT the source line
// (the error grows as you scroll past wrapped lines). A hidden mirror div
// reproduces the wrapped layout to get each line's true pixel offset; rebuilt
// lazily whenever the text or the editor width changes.
let editorMirror = null;
let lineOffsets = null;
let lineOffsetsKey = "";
function buildLineOffsets() {
  const cs = getComputedStyle(editor);
  if (!editorMirror) {
    editorMirror = document.createElement("div");
    editorMirror.setAttribute("aria-hidden", "true");
    Object.assign(editorMirror.style, {
      position: "absolute",
      visibility: "hidden",
      left: "-9999px",
      top: "0",
      boxSizing: "border-box",
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      wordBreak: "break-word",
    });
    document.body.appendChild(editorMirror);
  }
  const m = editorMirror;
  m.style.width = editor.clientWidth + "px";
  m.style.font = cs.font;
  m.style.lineHeight = cs.lineHeight;
  m.style.letterSpacing = cs.letterSpacing;
  m.style.padding = cs.padding;
  m.style.tabSize = cs.tabSize;
  m.textContent = "";
  const divs = editor.value.split("\n").map((ln) => {
    const d = document.createElement("div");
    d.textContent = ln === "" ? "​" : ln; // keep empty lines one row tall
    m.appendChild(d);
    return d;
  });
  const padTop = parseFloat(cs.paddingTop) || 0;
  lineOffsets = divs.map((d) => d.offsetTop - padTop);
  lineOffsetsKey = editor.value.length + ":" + editor.clientWidth;
}
function lineOffs() {
  if (!lineOffsets || lineOffsetsKey !== editor.value.length + ":" + editor.clientWidth) buildLineOffsets();
  return lineOffsets;
}
function invalidateLineOffsets() {
  lineOffsets = null;
}
// Fractional source line at the top of the editor viewport.
function editorTopLine() {
  const offs = lineOffs();
  const y = editor.scrollTop;
  let lo = 0,
    hi = offs.length - 1,
    i = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offs[mid] <= y) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const top = offs[i];
  const next = i + 1 < offs.length ? offs[i + 1] : top + 1;
  return i + (next > top ? Math.max(0, Math.min(1, (y - top) / (next - top))) : 0);
}
// Editor scrollTop that places a (fractional) source line at the viewport top.
function lineToEditorTop(line) {
  const offs = lineOffs();
  const i = Math.max(0, Math.min(offs.length - 1, Math.floor(line)));
  const top = offs[i];
  const next = i + 1 < offs.length ? offs[i + 1] : top;
  return top + (line - i) * (next - top);
}

// Preview anchors as {line, top}, where `top` is the element's offset from the
// top of the scrollable content (independent of the current scroll position).
function previewAnchors() {
  const base = previewPane.getBoundingClientRect().top - previewPane.scrollTop;
  const out = [];
  for (const el of preview.querySelectorAll("[data-source-line]")) {
    const line = Number(el.getAttribute("data-source-line"));
    if (Number.isFinite(line)) out.push({ line, top: el.getBoundingClientRect().top - base });
  }
  return out;
}
function lerp(x, x0, x1, y0, y1) {
  return x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}
function withScrollGuard(fn) {
  if (state.syncingScroll) return;
  state.syncingScroll = true;
  fn();
  requestAnimationFrame(() => (state.syncingScroll = false));
}

// Editor scrolled → move the preview so the same source line sits at the top.
function syncPreviewToEditor() {
  if (state.syncingScroll || state.view !== "split") return;
  const topLine = editorTopLine();
  const anchors = previewAnchors();
  let target;
  if (anchors.length) {
    let a = anchors[0];
    let b = anchors[anchors.length - 1];
    for (const p of anchors) {
      if (p.line <= topLine) a = p;
      if (p.line >= topLine) { b = p; break; }
    }
    target = lerp(topLine, a.line, b.line, a.top, b.top);
  } else {
    const ratio = editor.scrollTop / Math.max(1, editor.scrollHeight - editor.clientHeight);
    target = ratio * (previewPane.scrollHeight - previewPane.clientHeight);
  }
  withScrollGuard(() => (previewPane.scrollTop = target));
}

// Preview scrolled → move the editor to the matching source line.
function syncEditorToPreview() {
  if (state.syncingScroll || state.view !== "split") return;
  const y = previewPane.scrollTop; // viewport top in content coordinates
  const anchors = previewAnchors();
  let line;
  if (anchors.length) {
    let a = anchors[0];
    let b = anchors[anchors.length - 1];
    for (const p of anchors) {
      if (p.top <= y) a = p;
      if (p.top >= y) { b = p; break; }
    }
    line = lerp(y, a.top, b.top, a.line, b.line);
  } else {
    const ratio = previewPane.scrollTop / Math.max(1, previewPane.scrollHeight - previewPane.clientHeight);
    line = ratio * editor.value.split("\n").length;
  }
  withScrollGuard(() => (editor.scrollTop = lineToEditorTop(line)));
}

// Clicking a preview block selects and reveals its source line in the editor.
function jumpToSource(e) {
  if (state.view !== "split") return;
  if (e.target.closest("a, input, button, .anchor-link")) return;
  const el = e.target.closest("[data-source-line]");
  if (!el) return;
  const line = Number(el.getAttribute("data-source-line"));
  if (!Number.isFinite(line)) return;
  const lines = editor.value.split("\n");
  let start = 0;
  for (let i = 0; i < line && i < lines.length; i++) start += lines[i].length + 1;
  const end = start + (lines[line] ? lines[line].length : 0);
  editor.focus();
  editor.setSelectionRange(start, end);
  withScrollGuard(() => {
    editor.scrollTop = Math.max(0, lineToEditorTop(line) - editor.clientHeight / 3);
  });
  updateCursor();
  const pane = $("editor-pane");
  pane.classList.remove("flash");
  void pane.offsetWidth; // restart the animation
  pane.classList.add("flash");
}

/* ------------------------------------------------------------------ files: open / drop / paste */
function openLocalFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.markdown,.txt,.mmd,text/markdown,text/plain";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    newDoc(file.name, text);
    toast(`Opened ${file.name}`, "success");
  });
  input.click();
}

/** Files dropped on the editor land in this browser (multiple are accepted). */
function handleDrop(e) {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  e.stopPropagation();
  importFilesInto(e.dataTransfer.files, { source: "local", path: "" });
}

async function handlePaste(e) {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  const dataUrl = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
  surround(`![pasted image](${dataUrl})`, "", "");
  toast("Image embedded as data URI");
}

/* ------------------------------------------------------------------ export + share */
function download(filename, text, type = "text/markdown") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function standaloneHtml() {
  const title = escapeHtml(state.current?.name || "Document");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.8.1/github-markdown-${
    state.dark ? "dark" : "light"
  }.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>body{margin:0;background:${state.dark ? "#0d1117" : "#fff"}}.markdown-body{max-width:900px;margin:0 auto;padding:40px 24px}</style>
</head><body><article class="markdown-body">${preview.innerHTML}</article></body></html>`;
}

function docBaseName() {
  return (state.current?.name || "document").replace(/\.(md|markdown|txt|mmd)$/i, "");
}

// Download the current document as a .md file to the browser's downloads folder.
function downloadMd() {
  const name = docBaseName() + ".md";
  download(name, editor.value);
  toast(`Downloaded ${name}`, "success");
}

// Export to PDF via the browser's print dialog (where paper size, margins, and
// "Save as PDF" live). The `@media print` stylesheet isolates the rendered
// preview, so no popup window is needed.
// While printing, force the light GitHub/hljs stylesheets so dark-theme docs
// (tables, code) don't come out dark-on-dark; restore the real theme afterward.
// Wired to before/afterprint, so it also covers the browser's own Ctrl/Cmd+P.
function setPrintLight(on) {
  const set = (id, off) => {
    const el = document.getElementById(id);
    if (el) el.disabled = off;
  };
  set("gh-md-dark", on ? true : !state.dark);
  set("gh-md-light", on ? false : state.dark);
  set("hljs-dark", on ? true : !state.dark);
  set("hljs-light", on ? false : state.dark);
}

async function printPreview() {
  closeModals();
  // Make sure the preview reflects the latest keystrokes before the dialog opens.
  clearTimeout(state.renderTimer);
  await renderNow();
  window.print();
}

function doExport(kind) {
  closeModals();
  const name = docBaseName();
  if (kind === "md") downloadMd();
  else if (kind === "html") download(name + ".html", standaloneHtml(), "text/html");
  else if (kind === "copy-html")
    navigator.clipboard.writeText(preview.innerHTML).then(() => toast("Rendered HTML copied", "success"));
  else if (kind === "print") printPreview();
}

function shareLink() {
  try {
    const payload = LZString.compressToEncodedURIComponent(
      JSON.stringify({ n: state.current?.name || "Shared.md", t: editor.value }),
    );
    const url = `${location.origin}${location.pathname}#s=${payload}`;
    navigator.clipboard.writeText(url).then(
      () => toast("Shareable link copied to clipboard", "success"),
      () => prompt("Copy this link:", url),
    );
  } catch {
    toast("Could not build share link", "error");
  }
}

function tryLoadShared() {
  const m = location.hash.match(/[#&]s=([^&]+)/);
  if (!m) return false;
  try {
    const data = JSON.parse(LZString.decompressFromEncodedURIComponent(m[1]));
    history.replaceState(null, "", location.pathname);
    newDoc(data.n || "Shared.md", data.t || "");
    toast("Loaded a shared document", "success");
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ modals */
function openModal(id) {
  $("modal-backdrop").hidden = false;
  $(id).hidden = false;
  if (id === "settings-modal") {
    $("set-client-id").value = state.settings.googleClientId || "";
  }
}
function closeModals() {
  $("modal-backdrop").hidden = true;
  document.querySelectorAll(".modal").forEach((m) => (m.hidden = true));
  closeGoogleMenu();
}

function saveSettings() {
  const id = $("set-client-id").value.trim();
  state.settings.googleClientId = id;
  store.saveSettings(state.settings);
  google.configure(id, CONFIG.driveFolderName);
  refreshGoogleUI();
  closeModals();
  toast("Settings saved", "success");
}

/* ------------------------------------------------------------------ divider resize */
function setupDivider() {
  const divider = $("pane-divider");
  const editorPane = $("editor-pane");
  const applyRatio = (r) => {
    editorPane.style.flex = `0 0 ${r * 100}%`;
  };
  if (state.settings.splitRatio) applyRatio(state.settings.splitRatio);
  let dragging = false;
  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const ws = $("workspace").getBoundingClientRect();
    const sidebar = app.classList.contains("sidebar-collapsed") ? 0 : $("sidebar").offsetWidth;
    // flex-basis % is relative to the full workspace width, so the ratio must be
    // too — otherwise the divider drifts ahead of the cursor when the sidebar
    // is open (the default).
    const w = e.clientX - ws.left - sidebar;
    const clamped = Math.min(0.85, Math.max(0.15, w / ws.width));
    applyRatio(clamped);
    state.settings.splitRatio = clamped;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    store.saveSettings(state.settings);
  });
}

/* ------------------------------------------------------------------ helpers */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------ tooltips
 * The native `title` tooltip only appears after a long browser delay. Replace it
 * on the chrome buttons with a lightweight custom tooltip that shows instantly.
 * Rendered into <body> (position: fixed) so it escapes the toolbar's overflow
 * clipping; `aria-label` preserves the accessible name we take off `title`.
 */
let tipEl = null;
function showTip(e) {
  const el = e.currentTarget;
  const text = el.dataset.tip;
  if (!text || !tipEl) return;
  tipEl.textContent = text;
  tipEl.classList.add("show");
  const r = el.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
  // Prefer below the control, but flip above when there's no room (status bar).
  const below = r.bottom + 6;
  const top = below + th > window.innerHeight - 4 ? r.top - th - 6 : below;
  tipEl.style.left = left + "px";
  tipEl.style.top = Math.max(4, top) + "px";
}
function hideTip() {
  tipEl?.classList.remove("show");
}
function setupFastTooltips() {
  tipEl = document.createElement("div");
  tipEl.className = "tip";
  tipEl.setAttribute("role", "tooltip");
  document.body.appendChild(tipEl);
  const els = document.querySelectorAll(
    "#sidebar-toggle[title], .toolbar [title], .header-actions .icon-btn[title]," +
      " .side-actions [title], .statusbar .link-btn[title]",
  );
  els.forEach((el) => {
    const t = el.getAttribute("title");
    if (!t) return;
    el.dataset.tip = t;
    if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", t);
    el.removeAttribute("title"); // suppress the slow native tooltip
    el.addEventListener("mouseenter", showTip);
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("mousedown", hideTip);
  });
}

/* ------------------------------------------------------------------ wiring */
function wireEvents() {
  editor.addEventListener("input", onEdit);
  editor.addEventListener("keyup", updateCursor);
  editor.addEventListener("click", updateCursor);
  editor.addEventListener("scroll", syncPreviewToEditor);
  previewPane.addEventListener("scroll", syncEditorToPreview);
  preview.addEventListener("click", jumpToSource);
  editor.addEventListener("paste", handlePaste);
  editor.addEventListener("dragover", (e) => e.preventDefault());
  editor.addEventListener("drop", handleDrop);

  // Tab: insert two spaces at a caret; indent/outdent whole lines for a
  // selection (Shift+Tab outdents).
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = editor;
      if (s === en && !e.shiftKey) {
        editor.setRangeText("  ", s, en, "end");
      } else {
        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
        const block = value.slice(lineStart, en);
        const next = e.shiftKey
          ? block.split("\n").map((l) => l.replace(/^ {1,2}/, "")).join("\n")
          : block.split("\n").map((l) => "  " + l).join("\n");
        editor.setRangeText(next, lineStart, en, "select");
      }
      onEdit();
    }
  });

  docTitle.addEventListener("change", async () => {
    if (!state.current) return;
    const name = docTitle.value.trim() || "Untitled.md";
    if (name === state.current.name) return;
    state.current.name = name;
    // Rename in place at the source: Drive files rename via API immediately.
    if (state.current.driveId) {
      const finalName = ensureMdName(name);
      try {
        await google.drive.rename(state.current.driveId, finalName);
        state.current.name = finalName;
        state.current.driveName = finalName;
        docTitle.value = finalName;
        toast("Renamed on Drive", "success");
      } catch (e) {
        toast(e.message || "Could not rename on Drive", "error");
      }
    }
    persist(state.current);
    updateStorageLoc();
  });

  document.querySelectorAll("[data-fmt]").forEach((b) =>
    b.addEventListener("click", () => FORMATTERS[b.dataset.fmt]?.()),
  );
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view)),
  );

  $("btn-theme").addEventListener("click", () => applyTheme(!state.dark));
  $("btn-new").addEventListener("click", () => newDoc());
  $("btn-help").addEventListener("click", () => openModal("help-modal"));
  $("btn-settings").addEventListener("click", () => openModal("settings-modal"));
  $("btn-open-local").addEventListener("click", openLocalFile);
  $("btn-new-file").addEventListener("click", () => newFileLocal(""));
  $("btn-new-folder").addEventListener("click", () => newFolderLocal(""));
  $("btn-download").addEventListener("click", downloadMd);
  $("btn-pdf").addEventListener("click", printPreview);
  $("btn-files").addEventListener("click", toggleFiles);
  $("files-close").addEventListener("click", closeFiles);
  $("files-new-folder").addEventListener("click", filesNewFolder);
  $("files-import").addEventListener("click", filesImport);

  // Drop files from the computer anywhere in the Files view → current folder
  // (including a Google Drive folder, which uploads them).
  const filesView = $("files-view");
  filesView.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    filesView.classList.add("drop-active");
  });
  filesView.addEventListener("dragleave", (e) => {
    if (e.target === filesView) filesView.classList.remove("drop-active");
  });
  filesView.addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    filesView.classList.remove("drop-active");
    await importFilesInto(e.dataTransfer.files, filesDropTarget());
  });

  // A file dropped outside a drop zone would otherwise make the browser
  // navigate away from the app (losing unsaved work). Swallow those.
  for (const type of ["dragover", "drop"]) {
    document.addEventListener(type, (e) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    });
  }
  document.querySelectorAll(".files-table th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      // Same column toggles direction; a new column starts ascending.
      filesState.dir = filesState.sort === col ? -filesState.dir : 1;
      filesState.sort = col;
      renderFiles();
    }),
  );
  window.addEventListener("beforeprint", () => setPrintLight(true));
  window.addEventListener("afterprint", () => setPrintLight(false));
  $("btn-share").addEventListener("click", shareLink);
  $("btn-export").addEventListener("click", () => openModal("export-modal"));
  $("btn-google").addEventListener("click", onGoogleButton);
  $("set-save").addEventListener("click", saveSettings);

  document.querySelectorAll("[data-export]").forEach((b) =>
    b.addEventListener("click", () => doExport(b.dataset.export)),
  );
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModals));
  $("modal-backdrop").addEventListener("click", closeModals);

  // Sidebar tabs + toggle
  document.querySelectorAll(".side-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".side-tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      document.querySelectorAll(".side-panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    }),
  );
  $("sidebar-toggle").addEventListener("click", () => {
    const collapsed = app.classList.toggle("sidebar-collapsed");
    $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
    state.settings.sidebarCollapsed = collapsed;
    store.saveSettings(state.settings);
  });

  window.addEventListener("keydown", onShortcut);
  // Editor width changes (window resize, divider drag) change line wrapping,
  // so the cached per-line offsets used for scroll sync must be rebuilt.
  window.addEventListener("resize", invalidateLineOffsets);
}

function onShortcut(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") {
    if (app.classList.contains("files-open")) closeFiles();
    return closeModals();
  }
  if (!mod) return;
  const k = e.key.toLowerCase();
  const map = {
    s: () => (e.shiftKey ? saveToDrive() : quickSave()),
    b: () => FORMATTERS.bold(),
    i: () => FORMATTERS.italic(),
    k: () => FORMATTERS.link(),
    "/": () => openModal("help-modal"),
    "1": () => setView("edit"),
    "2": () => setView("split"),
    "3": () => setView("preview"),
  };
  if (k === "n" && e.shiftKey) {
    e.preventDefault();
    return newDoc();
  }
  if (map[k]) {
    e.preventDefault();
    map[k]();
  }
}

function quickSave() {
  if (state.current) persist(state.current);
  if (google.isConfigured() && (state.current?.driveId || google.isSignedIn())) saveToDrive();
  else toast("Saved to this browser (autosave is on)", "success");
}

/* ------------------------------------------------------------------ init */
function init() {
  state.settings = store.loadSettings();
  state.library = store.loadLibrary();
  // Documents predating size/date tracking get a created stamp so the file
  // browser can sort them.
  if (backfillDocMeta(state.library)) store.saveLibrary(state.library);

  // Expand the local root by default on first run.
  if (!state.settings.expanded) state.settings.expanded = { [LOCAL_ROOT_KEY]: true };
  // Drive is remote + lazy: reset its expand state each session so we never get
  // stuck on "Loading…" or force a sign-in popup on page load.
  for (const k of Object.keys(state.settings.expanded)) {
    if (k === DRIVE_ROOT_KEY || k.startsWith("D:")) delete state.settings.expanded[k];
  }

  // theme
  const prefersDark =
    state.settings.theme === "dark" ||
    (!state.settings.theme && window.matchMedia?.("(prefers-color-scheme: dark)").matches !== false);
  applyTheme(state.settings.theme ? state.settings.theme === "dark" : prefersDark);

  // view + sidebar
  setView(state.settings.view || "split");
  if (state.settings.sidebarCollapsed) {
    app.classList.add("sidebar-collapsed");
    $("sidebar-toggle").setAttribute("aria-expanded", "false");
  }

  // google
  const clientId = state.settings.googleClientId || CONFIG.googleClientId || "";
  google.configure(clientId, CONFIG.driveFolderName);
  refreshGoogleUI();

  wireEvents();
  setupDivider();
  setupFastTooltips();

  // Signal the HTML fallback watchdog that the module graph loaded and the app
  // booted (see the inline script in index.html).
  window.__mdsReady = true;

  // Choose the document to show: shared link → last open → newest → sample.
  if (tryLoadShared()) return;
  const currentId = store.getCurrentId();
  const existing = state.library.find((d) => d.id === currentId) || state.library[0];
  if (existing) loadDoc(existing);
  else newDoc("Welcome.md", SAMPLE);
}

init();
