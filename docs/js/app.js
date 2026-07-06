/*
 * app.js — Markdown Studio application controller.
 *
 * Ties together rendering (render.js), local persistence (storage.js) and
 * optional Google Drive sync (google.js). No framework, no build step — this is
 * plain ES modules so it can be served straight off GitHub Pages.
 */
import { renderMarkdown, enhance, extractOutline, slugify } from "./render.js";
import { store, upsertDoc, removeDoc, uid } from "./storage.js";
import * as google from "./google.js";
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
async function renderNow() {
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
  const doc = { id: uid(), name, text, driveId: null, folder, updated: Date.now() };
  state.library = upsertDoc(state.library, doc);
  store.saveLibrary(state.library);
  loadDoc(doc);
  return doc;
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
  if (o.onDrop) {
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drop-target");
      try {
        o.onDrop(JSON.parse(e.dataTransfer.getData("text/plain")));
      } catch {
        /* ignore malformed drag */
      }
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
    onDrop: (d) => moveLocal(d, ""),
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
    onDrop: state.driveRootId ? (d) => moveDrive(d, state.driveRootId) : undefined,
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
      onDrop: (d) => moveLocal(d, sub.path),
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
      dragData: { source: "local", id: doc.id },
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
      onDrop: (d) => moveDrive(d, f.id),
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
      dragData: { source: "drive", id: f.id, parentId: folderId },
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
  if (!google.isSignedIn()) await google.signIn();
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

/* ------------------------------------------------------------------ autosave on edit */
function onEdit() {
  if (!state.current) return;
  state.current.text = editor.value;
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
  const actions = [
    ["Save current doc to Drive", () => saveToDrive()],
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
    refreshGoogleUI();
    toast("Signed in to Google", "success");
  } catch (e) {
    toast(e.message || "Google sign-in failed", "error");
  }
}

function doSignOut() {
  google.signOut();
  refreshGoogleUI();
  toast("Signed out");
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

/* ------------------------------------------------------------------ scroll sync */
function syncScroll(fromEl, toEl) {
  if (state.syncingScroll) return;
  state.syncingScroll = true;
  const ratio = fromEl.scrollTop / Math.max(1, fromEl.scrollHeight - fromEl.clientHeight);
  toEl.scrollTop = ratio * (toEl.scrollHeight - toEl.clientHeight);
  requestAnimationFrame(() => (state.syncingScroll = false));
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

function handleDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault();
  if (!/\.(md|markdown|txt|mmd)$/i.test(file.name)) {
    toast("Drop a .md / .markdown / .txt file", "error");
    return;
  }
  file.text().then((text) => {
    newDoc(file.name, text);
    toast(`Opened ${file.name}`, "success");
  });
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

function doExport(kind) {
  closeModals();
  const name = (state.current?.name || "document").replace(/\.(md|markdown|txt)$/i, "");
  if (kind === "md") download(name + ".md", editor.value);
  else if (kind === "html") download(name + ".html", standaloneHtml(), "text/html");
  else if (kind === "copy-html")
    navigator.clipboard.writeText(preview.innerHTML).then(() => toast("Rendered HTML copied", "success"));
  else if (kind === "print") {
    const w = window.open("", "_blank");
    if (!w) return toast("Popup blocked", "error");
    w.document.write(standaloneHtml());
    w.document.close();
    w.onload = () => w.print();
  }
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

/* ------------------------------------------------------------------ wiring */
function wireEvents() {
  editor.addEventListener("input", onEdit);
  editor.addEventListener("keyup", updateCursor);
  editor.addEventListener("click", updateCursor);
  editor.addEventListener("scroll", () => syncScroll(editor, preview));
  preview.addEventListener("scroll", () => syncScroll(preview, editor));
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
    app.classList.toggle("sidebar-collapsed");
    state.settings.sidebarCollapsed = app.classList.contains("sidebar-collapsed");
    store.saveSettings(state.settings);
  });

  window.addEventListener("keydown", onShortcut);
}

function onShortcut(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") return closeModals();
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
  if (state.settings.sidebarCollapsed) app.classList.add("sidebar-collapsed");

  // google
  const clientId = state.settings.googleClientId || CONFIG.googleClientId || "";
  google.configure(clientId, CONFIG.driveFolderName);
  refreshGoogleUI();

  wireEvents();
  setupDivider();

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
