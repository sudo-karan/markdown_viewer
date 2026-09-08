/*
 * app.js — Markdown Studio application controller.
 *
 * Ties together rendering (render.js), local persistence (storage.js) and
 * optional Google Drive sync (google.js). No framework, no build step — this is
 * plain ES modules so it can be served straight off GitHub Pages.
 */
// ?v= cache-buster: bump on every JS change (keep in sync with index.html's
// script tag) so a deploy never leaves the browser on a stale module.
import { renderMarkdown, enhance, extractOutline, slugify } from "./render.js?v=20260908b";
import { store, upsertDoc, removeDoc, uid, setAccount, getAccount } from "./storage.js?v=20260908b";
import * as google from "./google.js?v=20260908b";
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
  pendingDoc: null, // the doc the debounced autosave is holding, if any
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
let toastHideTimer = 0;
function toast(msg, kind = "") {
  toastEl.textContent = msg;
  toastEl.className = "toast show " + kind;
  toastEl.hidden = false;
  // Both timers must be cancelled: the nested one used to survive, so a message
  // arriving 2.6-2.8s after the previous one was wiped ~200ms later — long
  // enough to appear, too short to read. "Save failed" landing in that window
  // simply vanished.
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
    toastHideTimer = setTimeout(() => (toastEl.hidden = true), 200);
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
const isNarrow = () => window.matchMedia?.("(max-width: 720px)")?.matches === true;

function setView(view, { remember = true } = {}) {
  // There is no room for two panes on a phone — the stylesheet hides the editor
  // in split view — so "Split" stayed highlighted while only the preview showed,
  // in a mode the user couldn't type into. Call it what it is, but remember what
  // the user actually chose: persisting the coerced value meant one narrow
  // window (or a transient desktop resize) permanently lost their Split setting.
  const effective = view === "split" && isNarrow() ? "preview" : view;
  state.view = effective;
  app.setAttribute("data-view", effective);
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.view === effective);
  });
  if (remember) {
    state.settings.view = view;
    store.saveSettings(state.settings);
  }
}

/* ------------------------------------------------------------------ stats + cursor */
function updateStats() {
  // Count prose, not punctuation: every `#`, `-`, `>` and fence line used to be
  // counted as a word, so a 40-item list over-reported by 40 and skewed the
  // reading time with it.
  const prose = editor.value
    .replace(/^```[\s\S]*?^```/gm, "") // fenced code
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "") // block markers
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, " ")) // table pipes
    .replace(/^\s*[-*_]{3,}\s*$/gm, ""); // thematic breaks
  const words = (prose.trim().match(/\S+/g) || []).length;
  $("stat-words").textContent = `${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
  $("stat-read").textContent = words
    ? `${Math.max(1, Math.ceil(words / 200))} min read`
    : "0 min read";
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
  const doc = state.current;
  if (!doc?.driveId) {
    storageLoc.textContent = "Local";
    storageLoc.title = "Saved in this browser only";
    return;
  }
  // "Saved" + "Drive: notes.md" used to be shown while the Drive copy was still
  // the pre-edit one, because autosave was local-only. Now edits are pushed
  // (see scheduleDriveSync); this reports honestly whenever they haven't landed.
  const behind = (doc.updated || 0) > (doc.driveSyncedAt || 0);
  storageLoc.textContent = behind ? `Drive: ${doc.name} · syncing…` : `Drive: ${doc.name}`;
  storageLoc.title = behind
    ? "Saved in this browser; the Google Drive copy is being updated"
    : "In sync with Google Drive";
}

/* ------------------------------------------------------------------ documents */
/**
 * Write a document to this browser's library.
 *
 * @param {object} doc
 * @param {{markSaved?:boolean, rerender?:boolean, touch?:boolean}} opts
 *   touch — stamp `updated`. False for structural edits (rename, move): they are
 *   not content changes and should not reorder the Modified column.
 * @returns {boolean} whether the write actually reached storage.
 */
function persist(doc, { markSaved = true, rerender = true, touch = true } = {}) {
  // A write queued before the document was deleted must not resurrect it:
  // upsertDoc re-inserts any id it cannot find, so a pending autosave firing
  // after a delete put the document straight back into the library.
  if (deletedDocs.has(doc)) return true;
  if (touch) doc.updated = Date.now();
  state.library = upsertDoc(state.library, doc);
  const ok = store.saveLibrary(state.library);
  // Only the document on screen owns the "reopen this next time" pointer.
  // Renaming or moving a background document used to steal it, so the next
  // reload opened a file the user had not been editing.
  if (doc.id === state.current?.id) store.setCurrentId(doc.id);
  if (rerender) refreshViews();
  // A refused write (private mode, or a full quota — easy to reach, because
  // pasted images are embedded as base64 data URIs) must never be reported as
  // "Saved": the document would be gone on the next reload with no warning.
  if (!ok) {
    setSaveState("error");
    toast("Couldn't save to this browser — storage is full or blocked. Download a copy.", "error");
  } else if (markSaved) {
    setSaveState("saved");
  }
  return ok;
}

/**
 * Documents removed from the library. Held weakly and checked by persist() and
 * the Drive push, so no timer armed before the delete can bring one back.
 */
const deletedDocs = new WeakSet();

/** Forget a document: no queued write of any kind may touch it again. */
function forgetDoc(doc) {
  if (!doc) return;
  deletedDocs.add(doc);
  if (state.pendingDoc === doc) {
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    state.pendingDoc = null;
  }
  const t = driveSyncTimers.get(doc.id);
  if (t) {
    clearTimeout(t);
    driveSyncTimers.delete(doc.id);
  }
}

/** Commit a pending debounced autosave immediately. */
function flushSave() {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    if (state.pendingDoc) persist(state.pendingDoc, { rerender: false });
    state.pendingDoc = null;
  }
  flushDriveSyncs();
}

function loadDoc(doc) {
  // Switching documents must not strand the previous one's unsaved keystrokes.
  flushSave();
  state.current = doc;
  editor.value = doc.text || "";
  docTitle.value = doc.name || "Untitled.md";
  store.setCurrentId(doc.id);
  updateStorageLoc();
  updateStats();
  updateCursor();
  renderNow();
  refreshViews();
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

function clearDropHighlights() {
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  $("files-view")?.classList.remove("drop-active");
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
    // A drag cancelled with Esc, or dropped on nothing, fires dragend but never
    // dragleave/drop — the highlight used to stay stuck on the last folder
    // hovered until something unrelated re-rendered the tree.
    row.addEventListener("dragend", clearDropHighlights);
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

/**
 * Redraw everything that lists documents.
 *
 * The sidebar tree stays visible and interactive while the full-width Files view
 * is open, so any mutation has to reach both. Redrawing only the tree left the
 * table showing rows for documents that no longer existed — and clicking such a
 * row reopened the deleted document and the next keystroke wrote it back.
 * `renderFiles()` no-ops when the view is closed, so this is safe everywhere.
 */
function refreshViews() {
  renderTree();
  renderFiles();
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
    menu: state.driveRootId ? () => driveFolderMenu(state.driveRootId, null) : undefined,
  });
  if (isExpanded(DRIVE_ROOT_KEY)) {
    if (!google.isConfigured()) appendHint("Add a Google Client ID in Settings to use Drive.", 1);
    else if (state.driveRootId) renderDriveChildren(state.driveRootId, 1);
    else appendHint("Loading…", 1);
  }
}

/** Actions shared by the Drive root row and every Drive subfolder row. */
function driveFolderMenu(folderId, parentId, folder) {
  const items = [
    ["New file", () => newFileDrive(folderId)],
    ["New folder", () => newFolderDrive(folderId)],
    ["Refresh", () => loadDriveFolder(folderId, { force: true })],
    ["Open in Drive", () => window.open(google.drive.folderUrl(folderId), "_blank", "noopener")],
  ];
  if (folder) {
    items.push(["Rename", () => renameDriveFolder(folder)]);
    items.push(["Delete", () => deleteDriveFolder(folder, parentId), "danger"]);
  }
  return items;
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
      menu: () => driveFolderMenu(f.id, folderId, f),
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
  if (c.loaded && folders.length === 0 && files.length === 0) {
    // A bare "Empty" is actively misleading here: with the least-privilege
    // drive.file scope the app can only see what it created itself, so a folder
    // the user filled from the Drive website looks empty and the app looks
    // broken. Say why, and offer the way to check.
    appendHint("Empty — this app only sees files it created here.", depth);
    appendHint("Files added on drive.google.com won't show up; import or drag them in.", depth);
  }
}

/* ---- lazy Drive loading ---- */
async function ensureDriveReady() {
  if (!google.isConfigured()) {
    toast("Add your Google Client ID in Settings first.", "error");
    openModal("settings-modal");
    return false;
  }
  await ensureSignedIn();
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
async function loadDriveFolder(folderId, { force = false } = {}) {
  if (!folderId) return;
  const c = (state.driveCache[folderId] = state.driveCache[folderId] || {
    folders: [],
    files: [],
    loaded: false,
  });
  // A cached error must NOT auto-retry on every render. It used to, and since
  // this function's `finally` repaints the Files view, which re-enters
  // collectFileRows, which calls back in here — a single failing folder listing
  // span an unbounded fetch loop (measured: 632 Drive requests in 3 seconds).
  // Retrying is now explicit: the Refresh menu item, or re-expanding the row.
  if (c.loaded && !force) return;
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
    c.loaded = true; // stop rendering a "Loading…" hint that will never resolve
  } finally {
    c.loading = false;
    refreshViews();
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
    // Re-expanding is the user asking again, so a previous failure retries here.
    await loadDriveFolder(state.driveRootId, { force: !!state.driveCache[state.driveRootId]?.error });
  } catch (e) {
    toast(e.message || "Could not reach Google Drive.", "error");
  }
}
async function toggleDriveFolder(folderId, key) {
  const willExpand = !isExpanded(key);
  setExpanded(key, willExpand);
  renderTree();
  if (willExpand) await loadDriveFolder(folderId, { force: !!state.driveCache[folderId]?.error });
}

/* ---- local operations ---- */
function newFileLocal(folderPath) {
  setExpanded(LOCAL_ROOT_KEY, true);
  if (folderPath) setExpanded("L:" + folderPath, true);
  newDoc("Untitled.md", "", folderPath);
}
/**
 * Folder names can't contain "/" (it is the path separator), so slashes become
 * hyphens — but that has to happen BEFORE the emptiness check, or a name of
 * "///" turns into a folder literally called "---".
 */
function cleanFolderName(raw) {
  return String(raw ?? "").replace(/\//g, "-").replace(/^[-\s]+|[-\s]+$/g, "");
}
function newFolderLocal(parentPath) {
  const name = cleanFolderName(prompt("New folder name:"));
  if (!name) return;
  const path = parentPath ? parentPath + "/" + name : name;
  const lf = localFolders();
  if (lf.includes(path)) {
    toast(`A folder named “${name}” already exists here`, "error");
  } else {
    lf.push(path);
    store.saveSettings(state.settings);
  }
  setExpanded(LOCAL_ROOT_KEY, true);
  if (parentPath) setExpanded("L:" + parentPath, true);
  setExpanded("L:" + path, true);
  refreshViews();
}
function renameLocalDoc(doc) {
  const name = (prompt("Rename document:", doc.name) || "").trim();
  if (!name || name === doc.name) return;
  doc.name = name;
  if (doc.id === state.current?.id) docTitle.value = name;
  // touch:false — a rename is not a content edit and shouldn't reorder the
  // Modified column.
  persist(doc, { touch: false });
}
function renamePrefix(p, oldP, newP) {
  if (p === oldP) return newP;
  if (p.startsWith(oldP + "/")) return newP + p.slice(oldP.length);
  return p;
}
function renameLocalFolder(path) {
  const segs = path.split("/");
  const cur = segs[segs.length - 1];
  const name = cleanFolderName(prompt("Rename folder:", cur));
  if (!name || name === cur) return;
  const newPath = segs.slice(0, -1).concat(name).join("/");
  // Renaming onto an existing sibling merges the two folders. That may be what
  // the user wants, but it used to happen silently.
  if (localFolders().includes(newPath)) {
    if (!confirm(`A folder named “${name}” already exists here. Merge them?`)) return;
  }
  // Dedupe: the merge above used to leave the same path in the list twice, and
  // each later rename doubled it again.
  state.settings.localFolders = [
    ...new Set(localFolders().map((p) => renamePrefix(p, path, newPath))),
  ];
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
  refreshViews();
  toast("Folder renamed");
}
function deleteLocalFolder(path) {
  const docs = state.library.filter(
    (d) => !d.driveId && (d.folder === path || (d.folder || "").startsWith(path + "/")),
  );
  if (!confirm(`Delete folder "${path}" and its ${docs.length} document(s) from this browser?`)) return;
  const ids = new Set(docs.map((d) => d.id));
  for (const d of docs) forgetDoc(d);
  state.library = state.library.filter((d) => !ids.has(d.id));
  state.settings.localFolders = localFolders().filter((p) => p !== path && !p.startsWith(path + "/"));
  // Drop the folder's expand state too. Leaving it behind grew the settings blob
  // without bound and silently pre-expanded any later folder of the same name.
  const em = expandedMap();
  for (const k of Object.keys(em)) {
    if (k === "L:" + path || k.startsWith("L:" + path + "/")) delete em[k];
  }
  store.saveLibrary(state.library);
  store.saveSettings(state.settings);
  if (state.current && ids.has(state.current.id)) {
    const next = state.library[0];
    if (next) loadDoc(next);
    else newDoc();
  } else {
    refreshViews();
  }
  toast("Folder deleted");
}
function moveLocal(dragData, targetPath) {
  if (!dragData || dragData.source !== "local") return;
  const doc = state.library.find((d) => d.id === dragData.id);
  if (!doc || (doc.folder || "") === targetPath) return;
  doc.folder = targetPath;
  if (targetPath) setExpanded("L:" + targetPath, true);
  persist(doc, { touch: false }); // a move is not a content edit
  toast("Moved");
}

/* ---- crossing between "This browser" and Google Drive ----
 * Dragging between the two roots used to be a silent no-op. A drag from this
 * browser onto a Drive folder now uploads the document (a real move — it stops
 * being browser-only and becomes reachable from the user's other devices); the
 * reverse direction copies the file down without touching the Drive original,
 * so a drag can never destroy the only copy of something.
 */

/**
 * Resolve a Drive drop target, falling back to the app's root folder.
 *
 * This MUST go through ensureDriveReady rather than calling google.drive.root()
 * directly. The old shortcut returned the folder id without ever assigning
 * `state.driveRootId` or seeding its cache entry, so a drop onto a Drive row
 * that had not been expanded yet — the state after every page load, since init()
 * clears the Drive expand keys — uploaded the file correctly but then left the
 * tree stuck on a "Loading…" hint with no loader behind it, and the document
 * gone from "This browser". That is the "dragging to Drive doesn't work" bug.
 */
async function resolveDriveFolder(folderId) {
  if (folderId) return folderId;
  if (!state.driveRootId) await ensureDriveReady();
  return state.driveRootId;
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
    doc.driveSyncedAt = Date.now();
    cacheDriveFile(parent, res);
    revealDriveFolder(parent);
    persist(doc);
    updateStorageLoc();
    setSaveState("saved");
    toast(`Moved “${doc.name}” to Drive`, "success");
  } catch (e) {
    setSaveState("error");
    reportDriveError(e, "Could not move that file to Drive");
  }
}

/**
 * Open the Drive tree down to `folderId` and make sure its contents are on
 * screen. Without the explicit load, a file uploaded into a folder that had
 * never been expanded landed in an empty cache entry and simply wasn't shown.
 */
function revealDriveFolder(folderId) {
  setExpanded(DRIVE_ROOT_KEY, true);
  // Guard against `null`: comparing an unresolved root id used to write a bogus
  // `D:<rootId>` expand key for the root folder itself.
  if (folderId && state.driveRootId && folderId !== state.driveRootId) {
    setExpanded("D:" + folderId, true);
  }
  refreshViews();
  loadDriveFolder(folderId, { force: true });
}

/**
 * Surface a Drive failure. An expired Google session is not an error the user
 * can act on from a toast alone, so say what to click.
 */
function reportDriveError(e, fallback) {
  if (e?.signInRequired) {
    toast(e.message, "error");
    refreshGoogleUI();
    return;
  }
  toast(e?.message || fallback, "error");
}

/** "notes.md" → "notes (2).md" when that folder already holds a "notes.md". */
function uniqueLocalName(name, folder) {
  const taken = new Set(
    state.library.filter((d) => !d.driveId && (d.folder || "") === folder).map((d) => d.name),
  );
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return name;
}

/** Copy a Drive file into this browser. The Drive original is left alone. */
async function copyDriveFileToLocal(dragData, targetPath) {
  try {
    const text = await google.drive.read(dragData.id);
    const now = Date.now();
    // Repeat drags used to pile up indistinguishable rows with the same name.
    const name = uniqueLocalName(dragData.name || "Untitled.md", targetPath || "");
    const doc = {
      id: uid(), name, text, driveId: null,
      folder: targetPath || "", created: now, updated: now,
    };
    state.library = upsertDoc(state.library, doc);
    store.saveLibrary(state.library);
    setExpanded(LOCAL_ROOT_KEY, true);
    if (targetPath) setExpanded("L:" + targetPath, true);
    refreshViews();
    toast(`Copied “${name}” into this browser`, "success");
  } catch (e) {
    reportDriveError(e, "Could not copy that file from Drive");
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
 * @param {{openSingle?:boolean}} opts — openSingle switches the editor to a
 *   lone imported file. True only for a drop on the editor, where retargeting is
 *   the point; from the Files view it silently swapped the open document.
 */
async function importFilesInto(fileList, target, { openSingle = false } = {}) {
  const all = [...(fileList || [])];
  const files = all.filter((f) => IMPORTABLE.test(f.name));
  const skipped = all.length - files.length;
  if (!files.length) {
    toast(all.length ? "Only .md / .markdown / .txt / .mmd files can be imported" : "Nothing to import", "error");
    return;
  }
  let ok = 0;
  let failed = 0;
  let firstError = "";
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
        } catch (e) {
          // Keep importing the rest, but remember what went wrong: reporting
          // "Imported 2 files" in green when a third was rejected for quota
          // told the user their file had arrived when it hadn't.
          failed++;
          if (!firstError) firstError = e?.message || "";
        }
      }
      revealDriveFolder(parent);
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
    reportDriveError(e, "Import failed");
    return;
  }
  refreshViews();
  if (openSingle && ok === 1 && lastLocalDoc) loadDoc(lastLocalDoc);
  const where = target?.source === "drive" ? "Drive" : "this browser";
  const parts = [`Imported ${ok} of ${all.length} into ${where}`];
  if (skipped) parts.push(`skipped ${skipped} unsupported`);
  if (failed) parts.push(`${failed} failed${firstError ? ": " + firstError : ""}`);
  toast(parts.join(" · "), failed || !ok ? "error" : "success");
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
    reportDriveError(e, "Could not create file");
  }
}
async function newFolderDrive(parentId) {
  const name = (prompt("New folder name:") || "").trim().replace(/\//g, "-");
  if (!name) return;
  try {
    const res = await google.drive.createFolder(name, parentId);
    const c = state.driveCache[parentId];
    if (c && c.loaded) c.folders.push(res);
    state.driveCache[res.id] = { name: res.name, folders: [], files: [], loaded: true };
    refreshViews();
    toast("Folder created", "success");
  } catch (e) {
    reportDriveError(e, "Could not create folder");
  }
}
async function renameDriveFile(f, parentId) {
  // Check for a cancelled/blank prompt BEFORE normalising — see ensureMdName.
  const raw = prompt("Rename file:", f.name);
  if (raw === null) return;
  const name = ensureMdName(raw);
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
    refreshViews();
    toast("Renamed", "success");
  } catch (e) {
    reportDriveError(e, "Could not rename");
  }
}
async function renameDriveFolder(f) {
  const name = (prompt("Rename folder:", f.name) || "").trim().replace(/\//g, "-");
  if (!name || name === f.name) return;
  try {
    await google.drive.rename(f.id, name);
    f.name = name;
    if (state.driveCache[f.id]) state.driveCache[f.id].name = name;
    refreshViews();
    toast("Renamed", "success");
  } catch (e) {
    reportDriveError(e, "Could not rename");
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
      forgetDoc(doc); // a queued push would otherwise write into the trashed file
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
    refreshViews();
    toast("Moved to Drive trash");
  } catch (e) {
    reportDriveError(e, "Could not delete");
  }
}
/** Every Drive folder id cached beneath (and including) `rootId`. */
function cachedDriveSubtree(rootId) {
  const ids = [];
  const walk = (id) => {
    if (!id || ids.includes(id)) return;
    ids.push(id);
    for (const sub of state.driveCache[id]?.folders || []) walk(sub.id);
  };
  walk(rootId);
  return ids;
}

async function deleteDriveFolder(f, parentId) {
  if (!confirm(`Move folder "${f.name}" and its contents to the Google Drive trash?`)) return;
  try {
    await google.drive.trash(f.id);
    const c = state.driveCache[parentId];
    if (c) c.folders = c.folders.filter((x) => x.id !== f.id);
    // Documents that lived inside used to stay in the library — invisible in
    // both views (they have a driveId, so the local tree skips them, and their
    // Drive folder is gone), still open, still labelled "Drive: …", with Ctrl+S
    // writing into a trashed file. Keep them, as browser-only copies.
    const subtree = cachedDriveSubtree(f.id);
    for (const id of subtree) driveTombstones.add(id);
    const fileIds = new Set(subtree.flatMap((id) => (state.driveCache[id]?.files || []).map((x) => x.id)));
    let rescued = 0;
    for (const doc of state.library) {
      if (doc.driveId && fileIds.has(doc.driveId)) {
        doc.driveId = null;
        doc.driveName = null;
        doc.driveParentId = null;
        doc.folder = "";
        rescued++;
      }
    }
    if (rescued) store.saveLibrary(state.library);
    for (const id of subtree) delete state.driveCache[id];
    if (state.current?.driveId === null) updateStorageLoc();
    refreshViews();
    toast(
      rescued
        ? `Moved to Drive trash · kept ${rescued} document${rescued === 1 ? "" : "s"} in this browser`
        : "Moved to Drive trash",
    );
  } catch (e) {
    reportDriveError(e, "Could not delete");
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
    refreshViews();
    toast("Moved");
  } catch (e) {
    reportDriveError(e, "Could not move");
  }
}

function deleteDoc(doc) {
  if (!confirm(`Delete "${doc.name}"? This only removes it from this browser.`)) return;
  forgetDoc(doc);
  state.library = removeDoc(state.library, doc.id);
  store.saveLibrary(state.library);
  if (state.current?.id === doc.id) {
    const next = state.library[0];
    if (next) loadDoc(next);
    else newDoc();
  } else {
    refreshViews();
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
 * Drive folders this session actually deleted. The Files-view breadcrumb needs
 * to tell "deleted" apart from "not listed yet" — everything else is unknown,
 * not gone.
 */
const driveTombstones = new Set();

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
          ["Rename", () => renameLocalFolder(sub.path)],
          ["Delete", () => deleteLocalFolder(sub.path), "danger"],
        ],
      });
    }
    for (const doc of node.files) {
      rows.push({
        kind: "file", name: doc.name, icon: FILE_ICON, source: "local",
        size: docBytes(doc.text), created: doc.created, modified: doc.updated,
        // Re-resolve by id: a row captured before a delete would otherwise open
        // a detached object, and the next keystroke wrote it back into the
        // library — resurrecting the document the user had just removed.
        open: () => {
          const live = state.library.find((d) => d.id === doc.id);
          if (!live) {
            toast("That document was deleted", "error");
            refreshViews();
            return;
          }
          loadDoc(live);
          closeFiles();
        },
        menu: () => [
          ["Rename", () => renameLocalDoc(doc)],
          ["Delete", () => deleteDoc(doc), "danger"],
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
      menu: () => driveFolderMenu(f.id, folderId, f),
    });
  }
  for (const f of c.files) {
    rows.push({
      kind: "file", name: f.name, icon: FILE_ICON, source: "drive",
      size: f.size != null ? Number(f.size) : null,
      created: f.createdTime, modified: f.modifiedTime,
      open: async () => { await openDriveFile(f, folderId); closeFiles(); },
      menu: () => [
        ["Rename", () => renameDriveFile(f, folderId)],
        ["Delete", () => deleteDriveFile(f, folderId), "danger"],
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

/**
 * Drop trailing breadcrumb entries whose folder no longer exists, so deleting or
 * renaming the folder you are standing in takes you to the nearest surviving
 * ancestor instead of leaving you inside a phantom that reports "empty".
 * @returns {boolean} whether anything was pruned
 */
function pruneFilesTrail() {
  const before = filesState.trail.length;
  while (filesState.trail.length) {
    const here = filesState.trail[filesState.trail.length - 1];
    // A Drive folder is "gone" only when we actually deleted it. Treating an
    // absent cache entry as deletion made every Drive subfolder unreachable:
    // listing a parent stores its children in the parent's entry without
    // creating one of their own, and this runs before collectFileRows has had
    // the chance to load it — so navigating in popped the entry immediately.
    const gone =
      here.source === "local"
        ? !!here.path && !localNodeAt(here.path)
        : !!here.folderId && driveTombstones.has(here.folderId);
    if (!gone) break;
    filesState.trail.pop();
  }
  return filesState.trail.length !== before;
}

// A render started for one folder must not paint over a newer one. Any await in
// collectFileRows (a Drive listing can take seconds) opens a window in which the
// user clicks a crumb or another row; the slower request used to win and left
// the breadcrumb and the table describing different places.
let filesRenderSeq = 0;
let filesFocusFirstRow = false;

async function renderFiles() {
  if (!app.classList.contains("files-open")) return;
  const seq = ++filesRenderSeq;
  const pruned = pruneFilesTrail();
  renderFilesCrumbs();
  const body = $("files-rows");
  body.innerHTML = `<tr><td colspan="5" class="files-empty">Loading…</td></tr>`;
  let rows;
  try {
    rows = await collectFileRows();
  } catch (e) {
    if (seq !== filesRenderSeq) return;
    filesFocusFirstRow = false;
    body.innerHTML = "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="files-empty"></td>`;
    tr.querySelector("td").textContent = e.message || "Could not list this folder.";
    body.appendChild(tr);
    return;
  }
  if (seq !== filesRenderSeq) return; // superseded by a later navigation
  if (pruned) toast("That folder is gone — showing the folder above it");
  body.innerHTML = "";
  document.querySelectorAll(".files-table th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === filesState.sort;
    th.classList.toggle("sorted", active);
    th.dataset.dir = active ? (filesState.dir > 0 ? "asc" : "desc") : "";
    th.setAttribute("aria-sort", active ? (filesState.dir > 0 ? "ascending" : "descending") : "none");
  });
  if (!rows.length) {
    filesFocusFirstRow = false;
    body.innerHTML = `<tr><td colspan="5" class="files-empty">This folder is empty.</td></tr>`;
    return;
  }
  if (rows.length === 1 && (rows[0].kind === "note" || rows[0].kind === "error")) {
    filesFocusFirstRow = false;
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
          // Keep the keyboard in the table. The tbody is rebuilt from scratch,
          // which dropped focus onto <body> — so a keyboard user had to Tab past
          // the toolbar again for every level of nesting.
          filesFocusFirstRow = document.activeElement?.closest?.(".files-row") != null;
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
  if (filesFocusFirstRow) {
    filesFocusFirstRow = false;
    body.querySelector(".files-row[tabindex]")?.focus();
  }
}

function openFiles() {
  app.classList.add("files-open");
  $("files-view").hidden = false;
  renderFiles();
}
function closeFiles() {
  // A row menu belongs to the view that opened it: leaving it behind put a live
  // menu over the editor whose Rename item still worked.
  closeContextMenu();
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
  updateCursor();
  scheduleRender();
  clearTimeout(state.saveTimer);
  // Autosave content without rebuilding the tree (name/structure unchanged).
  // The document is captured now, not read at fire time: switching files inside
  // the debounce window used to stamp the *new* document as modified and leave
  // the edited one behind.
  const doc = state.current;
  state.pendingDoc = doc;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = 0;
    state.pendingDoc = null;
    persist(doc, { rerender: false });
  }, 500);
  scheduleDriveSync(doc);
  updateStorageLoc();
}

/**
 * Push a Drive-backed document's edits back to Drive.
 *
 * Autosave used to write only to localStorage while the status bar said
 * "Saved · Drive: notes.md" — so a user editing a Drive document on one machine
 * found none of it on another. Debounced well past the local save so a burst of
 * typing is one upload, and silent about an expired session (the status bar
 * already shows the document is behind).
 */
// One debounce PER DOCUMENT. A single shared timer meant that editing a second
// Drive document cancelled the first one's pending upload outright — its edits
// stayed in this browser while the status bar claimed they were syncing.
const driveSyncTimers = new Map();

function scheduleDriveSync(doc) {
  if (!doc?.driveId || !google.isConfigured() || !google.hasSession()) return;
  clearTimeout(driveSyncTimers.get(doc.id));
  driveSyncTimers.set(
    doc.id,
    setTimeout(() => {
      driveSyncTimers.delete(doc.id);
      pushToDrive(doc);
    }, 2500),
  );
}

/** Send a Drive-backed document's current text to Drive. */
async function pushToDrive(doc) {
  if (!doc?.driveId || deletedDocs.has(doc)) return;
  try {
    await google.drive.update(doc.driveId, doc.text || "");
    if (deletedDocs.has(doc)) return; // deleted while the request was in flight
    doc.driveSyncedAt = Date.now();
    // touch:false — this is the same content, not a new edit.
    persist(doc, { markSaved: false, rerender: false, touch: false });
    if (doc.id === state.current?.id) updateStorageLoc();
  } catch (e) {
    if (doc.id === state.current?.id) {
      storageLoc.textContent = `Drive: ${doc.name} · not synced`;
      storageLoc.title = e?.message || "The Google Drive copy could not be updated";
    }
  }
}

/** Send every pending Drive edit now — on doc switch, page hide, sign-out. */
function flushDriveSyncs() {
  if (!driveSyncTimers.size) return;
  const ids = [...driveSyncTimers.keys()];
  for (const id of ids) {
    clearTimeout(driveSyncTimers.get(id));
    driveSyncTimers.delete(id);
    const doc = state.library.find((d) => d.id === id);
    if (doc) pushToDrive(doc); // fire and forget: the local copy is already safe
  }
}

/* ------------------------------------------------------------------ Google Drive */
function ensureMdName(name) {
  const trimmed = String(name || "").trim();
  // Never invent a name from nothing: ensureMdName("") used to return ".md",
  // which is truthy, so a cancelled rename sailed past its `if (!name) return`
  // guard and renamed the user's Drive file to a hidden dotfile.
  if (!trimmed) return "";
  return /\.(md|markdown|txt|mmd)$/i.test(trimmed) ? trimmed : trimmed + ".md";
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
    // Must go through ensureSignedIn, not google.signIn: signing in here without
    // switching the storage namespace left every document in the shared
    // signed-out bucket while the header showed an account — and the next person
    // to sign in on this browser inherited them, Drive ids and all.
    await ensureSignedIn();
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
      // Binding a document to Drive takes it out of the local tree, so the row
      // has to appear on the Drive side in the same breath — otherwise saving
      // made the document vanish from both views until a reload.
      cacheDriveFile(state.current.driveParentId, res);
      revealDriveFolder(state.current.driveParentId);
    }
    state.current.driveSyncedAt = Date.now();
    persist(state.current);
    updateStorageLoc();
    refreshGoogleUI();
    toast("Saved to Google Drive", "success");
  } catch (e) {
    setSaveState("error");
    reportDriveError(e, "Google Drive save failed");
  }
}

async function openDriveFile(f, parentId) {
  try {
    const text = await google.drive.read(f.id);
    closeModals();
    // Reuse an existing local doc bound to this Drive file, if any.
    const existing = state.library.find((d) => d.driveId === f.id);
    if (existing) {
      // Re-reading Drive over unsynced local edits destroys them. If this copy
      // is ahead of Drive, let the user decide.
      const ahead = (existing.updated || 0) > (existing.driveSyncedAt || 0) && existing.text !== text;
      if (ahead && !confirm(
        `"${existing.name}" has changes in this browser that aren't in Drive yet.\n\n` +
          "Replace them with the Drive version? (Cancel keeps your local copy.)",
      )) {
        loadDoc(existing);
        return;
      }
      existing.text = text;
      existing.name = f.name;
      existing.driveName = f.name;
      existing.driveParentId = parentId || existing.driveParentId || null;
      existing.updated = Date.now();
      existing.driveSyncedAt = existing.updated; // just read from Drive: in sync
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
    reportDriveError(e, "Could not open the file");
  }
}

function refreshGoogleUI() {
  const p = google.getProfile();
  // Treat a valid token as "connected" even if the profile fetch failed, so the
  // user can still reach the Drive menu / Sign out.
  // A remembered account counts as connected even before a token is re-issued,
  // so a page reload doesn't look like a sign-out. `is-stale` distinguishes
  // "we know who you are but Drive needs a click" from a live session.
  if (p) {
    googleBtn.classList.add("is-connected");
    googleBtn.classList.toggle("is-stale", !google.isSignedIn());
    googleLabel.textContent = (p.given_name || p.name || "Account").split(" ")[0];
    if (p.picture) {
      googleAvatar.src = p.picture;
      googleAvatar.hidden = false;
    } else {
      googleAvatar.hidden = true;
    }
    setTip(
      googleBtn,
      google.isSignedIn()
        ? `${p.email || "Signed in"} — click for Drive actions`
        : `${p.email || "Signed in"} — reconnect to Google Drive`,
    );
  } else {
    googleBtn.classList.remove("is-stale");
    googleBtn.classList.remove("is-connected");
    googleLabel.textContent = "Sign in";
    googleAvatar.hidden = true;
    setTip(
      googleBtn,
      google.isConfigured()
        ? "Sign in with Google to sync to Drive"
        : "Add a Google Client ID in Settings to enable Drive",
    );
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
  refreshViews();
}

/**
 * Switch the app to `id`'s documents. Registered once with google.js, which
 * calls it for every identity change — sign-in, a silent refresh that first
 * learns the profile, sign-out. Routing it through google.js is what makes it
 * impossible to obtain a token without the namespace following: doing that by
 * hand at each call site meant "Save to Drive" quietly authenticated while
 * leaving every document in the shared signed-out bucket.
 *
 * @returns {string} a note to append to the caller's toast, if anything was
 * adopted.
 */
// Set by switchAccount, consumed by whichever toast reports the sign-in. The
// adoption message used to be its own toast and was overwritten milliseconds
// later by "Signed in as …", so nobody ever saw it.
let accountNote = "";

function switchAccount(id) {
  const target = id || "anon";
  // A pure token refresh must not touch documents: re-running the full reload
  // reset the editor from disk, discarding unsaved keystrokes and scrolling the
  // user back to the top mid-session.
  if (target === getAccount()) {
    refreshGoogleUI();
    return "";
  }
  flushSave();
  let note = "";
  if (id) {
    const anonLib = store.loadLibraryOf("anon");
    setAccount(id);
    const settings = store.loadSettings();
    // Adopt the signed-out library exactly once per account per browser. The old
    // "is the account library empty?" test re-harvested it every time — so
    // deleting everything and signing back in resurrected it.
    if (!settings.adoptedAnon && anonLib.length) {
      settings.adoptedAnon = true;
      store.saveSettings(settings);
      if (store.loadLibrary().length === 0) {
        store.saveLibrary(anonLib.map((d) => ({ ...d })));
        note = ` — added ${anonLib.length} document${anonLib.length === 1 ? "" : "s"} from this browser`;
      }
    }
  } else {
    setAccount(null);
  }
  reloadForAccount();
  refreshGoogleUI();
  accountNote = note;
  return note;
}
google.onAccountChange(switchAccount);

/** Sign in (if needed) and switch to that account's documents. */
async function ensureSignedIn() {
  if (google.isSignedIn() && google.getAccountId()) return true;
  // A known account only needs a token, and that can be had silently — no
  // popup, which matters because most callers run after the click that
  // triggered them (a drop, a retry) and a popup would be blocked.
  if (google.hasSession() && (await google.resumeSession())) return true;
  await google.signIn(); // fires switchAccount via google.onAccountChange
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
        doc.driveSyncedAt = Date.now();
        ok++;
      } catch {
        /* one bad file shouldn't abort the rest; the count reports the truth */
      }
    }
    store.saveLibrary(state.library);
    state.driveCache = {};
    refreshViews();
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
  const actions = [];
  // When the session has lapsed the only useful action is getting it back, and
  // it needs a real click — a silent refresh has already been tried and failed.
  if (!google.isSignedIn()) {
    actions.push(["Reconnect to Google Drive", reconnectGoogle]);
  }
  actions.push(
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
  );
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
  if (google.hasSession()) {
    toggleGoogleMenu();
    return;
  }
  await signInInteractively();
}

/** The one place an interactive sign-in is started, straight from a click. */
async function signInInteractively() {
  try {
    // switchAccount runs from google.onAccountChange, so the namespace has
    // already followed by the time this resolves; it returns any adoption note.
    await google.signIn();
    const p = google.getProfile();
    toast((p?.email ? `Signed in as ${p.email}` : "Signed in to Google") + accountNote, "success");
    accountNote = "";
    return true;
  } catch (e) {
    refreshGoogleUI();
    toast(e.message || "Google sign-in failed", "error");
    return false;
  }
}

async function reconnectGoogle() {
  if (await signInInteractively()) refreshGoogleUI();
}

function doSignOut() {
  google.signOut(); // fires switchAccount(null)
  toast("Signed out — showing this browser's documents");
}

/* ------------------------------------------------------------------ editor formatting
 * Every mutation goes through replaceRange(), which uses execCommand
 * ("insertText"). setRangeText() is the modern API but it writes outside the
 * textarea's own undo transaction, so a single toolbar click or Tab press wiped
 * the entire native undo stack — Ctrl+Z then did nothing, not even for the plain
 * typing that came before. execCommand is deprecated but remains the only way to
 * edit a textarea and keep undo working in Chrome, Safari and Firefox.
 */
function replaceRange(text, start, end, selStart, selEnd) {
  editor.focus();
  editor.setSelectionRange(start, end);
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (!inserted) editor.setRangeText(text, start, end, "end"); // fallback: no undo
  editor.setSelectionRange(selStart ?? start + text.length, selEnd ?? start + text.length);
  onEdit();
}

function surround(before, after = before, placeholder = "") {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const hadSelection = end > start;
  const sel = hadSelection ? value.slice(start, end) : placeholder;

  // A second press removes the markers instead of nesting them: pressing Bold
  // twice used to leave `**hello****bold text**`.
  if (after && hadSelection && sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    const inner = sel.slice(before.length, sel.length - after.length);
    return replaceRange(inner, start, end, start, start + inner.length);
  }
  if (
    after &&
    value.slice(Math.max(0, start - before.length), start) === before &&
    value.slice(end, end + after.length) === after
  ) {
    const s = start - before.length;
    return replaceRange(sel, s, end + after.length, s, s + sel.length);
  }

  const text = before + sel + after;
  // With no selection, leave the placeholder SELECTED so the next keystroke
  // overtypes it. It used to be left with a collapsed caret inside, so typing
  // produced `**bold texthello**`.
  const selStart = start + before.length;
  const selEnd = selStart + sel.length;
  replaceRange(text, start, end, hadSelection ? selStart : selStart, hadSelection ? selEnd : selEnd);
}

/**
 * Line-prefix buttons that belong to a family. `exact` means "this line already
 * IS this style" (press again to remove it); `family` is the whole marker to
 * strip or replace, so switching within a family converts rather than stacks.
 */
const LINE_PREFIX_RULES = {
  "# ": { family: /^#{1,6} /, exact: /^# (?!#)/ },
  "## ": { family: /^#{1,6} /, exact: /^## (?!#)/ },
  "> ": { family: /^> ?/, exact: /^> / },
  "- ": { family: /^[-*+] (?:\[[ xX]\] )?/, exact: /^[-*+] (?!\[[ xX]\] )/ },
  "- [ ] ": { family: /^[-*+] (?:\[[ xX]\] )?/, exact: /^[-*+] \[[ xX]\] / },
};

function prefixLines(prefix) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  // A selection that ends exactly at a line start does NOT include that line.
  // Slicing to `end` kept the trailing "\n", so the split produced an extra
  // empty entry that got prefixed and merged into the following line — which is
  // how "select two lines, make a numbered list" renumbered a third one.
  const blockEnd = end > lineStart && value[end - 1] === "\n" ? end - 1 : end;
  const block = value.slice(lineStart, blockEnd);
  const lines = block.split("\n");
  const rule = typeof prefix === "function" ? null : LINE_PREFIX_RULES[prefix];
  let replaced;
  if (rule && lines.every((l) => rule.exact.test(l))) {
    // Already exactly this — a second press turns it off ("# # heading" was the
    // old behaviour).
    replaced = lines.map((l) => l.replace(rule.family, "")).join("\n");
  } else if (rule && lines.every((l) => rule.family.test(l))) {
    // A different member of the same family — convert instead of stacking.
    // "- " is a prefix of "- [ ] ", so the naive version either destroyed a
    // checklist ("[ ] item") or doubled the marker ("- - [ ] item").
    replaced = lines.map((l) => l.replace(rule.family, prefix)).join("\n");
  } else {
    replaced = lines.map((l, i) => (typeof prefix === "function" ? prefix(l, i) : prefix + l)).join("\n");
  }
  // Keep the lines selected so actions can be chained (bullet, then quote).
  replaceRange(replaced, lineStart, blockEnd, lineStart, lineStart + replaced.length);
}

/**
 * @param {string} text
 * @param {number} [caret] offset within `text` to leave the caret at — used so
 *   the code-block template drops you between the fences rather than after them.
 */
function insertBlock(text, caret) {
  const start = editor.selectionStart;
  const before = editor.value.slice(0, start);
  const pad = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const full = pad + text;
  const at = caret == null ? start + full.length : start + pad.length + caret;
  replaceRange(full, start, editor.selectionEnd, at, at);
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
    insertBlock("| Column A | Column B |\n| -------- | -------- |\n| Cell 1   | Cell 2   |\n", 2),
  codeblock: () => insertBlock("```js\n\n```", 6),
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
  // The interpolation assumes line numbers rise with position on screen. Most
  // blocks satisfy that, but a renderer that moves content (footnote
  // definitions are relocated to the end while keeping their original map) can
  // emit an anchor that points backwards, which would yank the editor to the
  // top. Keep the sequence monotonic rather than trusting every stamp.
  let maxLine = -Infinity;
  for (const el of preview.querySelectorAll("[data-source-line]")) {
    const line = Number(el.getAttribute("data-source-line"));
    if (!Number.isFinite(line) || line < maxLine) continue;
    maxLine = line;
    out.push({ line, top: el.getBoundingClientRect().top - base });
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
  // openSingle: dropping one file on the editor is a request to edit it.
  importFilesInto(e.dataTransfer.files, { source: "local", path: "" }, { openSingle: true });
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

/**
 * The rendered markup depends on more than github-markdown-css: highlight.js
 * supplies the code colours, and this app's own stylesheet hides the heading
 * permalinks and styles alerts and diagrams. Without them the "self-contained
 * styled page" came out with no syntax highlighting, a stray blue `#` before
 * every heading, and `> [!NOTE]` callouts as grey blockquotes.
 */
function standaloneHtml(html) {
  const title = escapeHtml(state.current?.name || "Document");
  const theme = state.dark ? "dark" : "light";
  const hljsTheme = state.dark ? "github-dark" : "github";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.8.1/github-markdown-${theme}.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/${hljsTheme}.min.css">
<style>
body{margin:0;background:${state.dark ? "#0d1117" : "#fff"}}
.markdown-body{max-width:900px;margin:0 auto;padding:40px 24px}
.markdown-body .anchor-link{display:none}
.markdown-body .md-alert{border-left:.25em solid var(--al,#4493f8);padding:.5rem 1rem;margin:1rem 0}
.markdown-body .md-alert.tip{--al:#3fb950}.markdown-body .md-alert.important{--al:#ab7df8}
.markdown-body .md-alert.warning{--al:#d29922}.markdown-body .md-alert.caution{--al:#f85149}
.markdown-body .md-alert-title{margin:0 0 .25rem;font-weight:600;text-transform:capitalize;color:var(--al,#4493f8)}
.markdown-body .mermaid-figure{display:block;overflow-x:auto;text-align:center;margin:1rem 0}
.markdown-body .mermaid-figure svg{max-width:none;height:auto}
.markdown-body img{max-width:100%}
</style>
</head><body><article class="markdown-body">${html ?? preview.innerHTML}</article></body></html>`;
}

/**
 * The HTML to export. Renders straight from the source rather than scraping the
 * preview, so a pending 180ms render debounce can't ship the previous version —
 * and so a blank document doesn't export the app's own "This document is blank"
 * placeholder as if it were content.
 */
async function exportableHtml() {
  if (!editor.value.trim()) return "";
  // Render through the preview so the export gets the enhance() pass too:
  // rendering the Markdown alone shipped raw ```mermaid source and literal
  // [!NOTE] markers. Flushing the debounce also stops a click within 180ms of
  // a keystroke exporting the previous version.
  clearTimeout(state.renderTimer);
  await renderNow();
  return preview.innerHTML;
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
  // The Files view hides the preview and is itself not excluded from print, so
  // printing with it open produced a PDF of the file table.
  closeFiles();
  // Make sure the preview reflects the latest keystrokes before the dialog opens.
  clearTimeout(state.renderTimer);
  await renderNow();
  // Mermaid bakes its palette into the SVG, so swapping the <link> stylesheets
  // isn't enough: a dark-theme diagram printed as black boxes joined by
  // near-invisible pale arrows. Re-render it for paper, then put it back.
  // (A second enhance() alone can't do it: the mermaid source block has already
  // been replaced by its figure, so the whole preview has to be re-rendered.)
  const wasDark = state.dark;
  try {
    if (wasDark) {
      setPrintLight(true);
      state.dark = false;
      await renderNow();
    }
    window.print();
  } finally {
    // Without this, a throw anywhere above left the app in the print theme with
    // state.dark out of step, so the theme toggle appeared dead for one click.
    if (wasDark) {
      state.dark = true;
      setPrintLight(false);
      await renderNow();
    }
  }
}

async function doExport(kind) {
  closeModals();
  const name = docBaseName();
  if (kind === "print") return printPreview();
  const html = await exportableHtml();
  if (kind !== "md" && !html) {
    toast("This document is blank — nothing to export", "error");
    return;
  }
  if (kind === "md") downloadMd();
  else if (kind === "html") download(name + ".html", standaloneHtml(html), "text/html");
  else if (kind === "copy-html")
    navigator.clipboard.writeText(html).then(
      () => toast("Rendered HTML copied", "success"),
      () => toast("Could not copy to the clipboard", "error"),
    );
}

// Above this, a link is long enough to break in mail clients and chat apps —
// which is easy to reach, because a pasted image is embedded as a base64 data
// URI and LZString cannot compress base64.
const SHARE_URL_WARN = 30_000;

function shareLink() {
  try {
    const payload = LZString.compressToEncodedURIComponent(
      JSON.stringify({ n: state.current?.name || "Shared.md", t: editor.value }),
    );
    const url = `${location.origin}${location.pathname}#s=${payload}`;
    const huge = url.length > SHARE_URL_WARN;
    if (huge && !confirm(
      `This link is ${Math.round(url.length / 1024)} KB long (embedded images make it big) and many apps will ` +
        `truncate it. Copy it anyway?\n\nExporting HTML or saving to Drive is more reliable.`,
    )) return;
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
  // Keep the query string; only the hash is ours to clear.
  const clean = () => history.replaceState(null, "", location.pathname + location.search);
  try {
    const data = JSON.parse(LZString.decompressFromEncodedURIComponent(m[1]));
    clean();
    newDoc(data.n || "Shared.md", data.t || "");
    toast("Loaded a shared document", "success");
    return true;
  } catch {
    // A link truncated by a mail client used to fail in total silence, leaving
    // the broken hash in the URL so a reload failed the same way.
    clean();
    toast("That shared link is damaged or incomplete", "error");
    return false;
  }
}

/* ------------------------------------------------------------------ modals */
// These dialogs declare aria-modal, so the rest of the page must actually be
// unreachable while one is open — it wasn't: focus stayed on the trigger, one
// Tab moved behind the backdrop into invisible header buttons, and closing left
// focus wherever it had wandered.
let modalOpener = null;
function openModal(id) {
  modalOpener = document.activeElement;
  $("modal-backdrop").hidden = false;
  const modal = $(id);
  modal.hidden = false;
  if (id === "settings-modal") {
    // Show the ID actually in use. The field used to render empty whenever the
    // ID came from config.js, so pressing Save stored "" and switched Drive off
    // until the next reload.
    $("set-client-id").value = state.settings.googleClientId || CONFIG.googleClientId || "";
  }
  app.inert = true;
  const first =
    modal.querySelector("input, textarea, select, button:not([data-close])") ||
    modal.querySelector("button, [href], [tabindex]:not([tabindex='-1'])");
  if (first) {
    first.focus();
  } else {
    modal.tabIndex = -1;
    modal.focus();
  }
}
function closeModals() {
  $("modal-backdrop").hidden = true;
  document.querySelectorAll(".modal").forEach((m) => (m.hidden = true));
  closeGoogleMenu();
  app.inert = false;
  modalOpener?.focus?.();
  modalOpener = null;
}

function saveSettings() {
  const id = $("set-client-id").value.trim();
  // Store an override only when it differs from what the deployment ships, so
  // "save without editing" is a no-op and clearing the field means the same
  // thing before and after a reload.
  if (!id || id === (CONFIG.googleClientId || "")) delete state.settings.googleClientId;
  else state.settings.googleClientId = id;
  store.saveSettings(state.settings);
  const active = state.settings.googleClientId || CONFIG.googleClientId || "";
  google.configure(active, CONFIG.driveFolderName, CONFIG.legacyDriveFolderNames);
  google.preload();
  refreshGoogleUI();
  closeModals();
  toast(active ? "Settings saved" : "Settings saved — Google Drive is off", "success");
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
    // is open (the default). The 15/85% guard rails, however, have to be applied
    // to the space the two panes actually share: measured against the full
    // width they let the editor take 100% (collapsing the preview to zero, which
    // then persisted) while over-clamping the other end.
    const avail = Math.max(1, ws.width - sidebar);
    const w = e.clientX - ws.left - sidebar;
    const share = Math.min(0.85, Math.max(0.15, w / avail));
    const clamped = (share * avail) / ws.width;
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
    "#sidebar-toggle[title], .toolbar [title], .header-actions [title]," +
      " .side-actions [title], .statusbar .link-btn[title], .pane-divider[title]",
  );
  els.forEach((el) => {
    const t = el.getAttribute("title");
    if (!t) return;
    setTip(el, t);
    el.addEventListener("mouseenter", showTip);
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("mousedown", hideTip);
  });
  tipsReady = true;
}
let tipsReady = false;
/**
 * Point an element at the fast tooltip instead of the slow native one, keeping
 * its accessible name. Used for controls whose label changes at runtime (the
 * account button), which otherwise reverted to the native `title`.
 */
function setTip(el, text) {
  if (!el) return;
  el.dataset.tip = text;
  el.setAttribute("aria-label", text);
  el.removeAttribute("title");
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
  //
  // Capturing Tab unconditionally made the editor a keyboard trap (WCAG 2.1.2):
  // a keyboard-only user who reached the textarea could never leave it. Escape
  // now releases Tab for one press, which is the established pattern for
  // editors that consume it.
  let tabEscapes = false;
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      tabEscapes = true;
      return;
    }
    if (e.key !== "Tab") {
      tabEscapes = false;
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (tabEscapes) {
      tabEscapes = false;
      return; // let the browser move focus out
    }
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en, value } = editor;
    if (s === en && !e.shiftKey) {
      replaceRange("  ", s, en);
      return;
    }
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const blockEnd = en > lineStart && value[en - 1] === "\n" ? en - 1 : en;
    const block = value.slice(lineStart, blockEnd);
    const next = e.shiftKey
      ? block.split("\n").map((l) => l.replace(/^ {1,2}/, "")).join("\n")
      : block.split("\n").map((l) => "  " + l).join("\n");
    // Outdenting lines that have no indentation is a no-op — it used to mark the
    // document Unsaved and schedule a pointless write.
    if (next === block) return;
    if (s === en) {
      // Collapsed caret: keep it collapsed, shifted by what changed on its line.
      const delta = next.length - block.length;
      replaceRange(next, lineStart, blockEnd, Math.max(lineStart, s + delta), Math.max(lineStart, s + delta));
    } else {
      replaceRange(next, lineStart, blockEnd, lineStart, lineStart + next.length);
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
        // Keep the cached Drive listing in step. It used to keep the old name,
        // so the sidebar showed the stale row — and clicking it reopened the
        // file and wrote the old name back over the rename.
        const cached = state.driveCache[state.current.driveParentId]?.files?.find(
          (x) => x.id === state.current.driveId,
        );
        if (cached) cached.name = finalName;
        toast("Renamed on Drive", "success");
      } catch (e) {
        reportDriveError(e, "Could not rename on Drive");
      }
    }
    persist(state.current, { touch: false });
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
    // dragover bubbles from the rows, but the matching dragleave fires ON the
    // row — so an `e.target === filesView` test never cleared the highlight.
    if (!filesView.contains(e.relatedTarget)) filesView.classList.remove("drop-active");
  });
  filesView.addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    filesView.classList.remove("drop-active");
    await importFilesInto(e.dataTransfer.files, filesDropTarget());
  });
  document.addEventListener("dragend", clearDropHighlights);

  // A file dropped outside a drop zone would otherwise make the browser
  // navigate away from the app (losing unsaved work). Swallow those.
  for (const type of ["dragover", "drop"]) {
    document.addEventListener(type, (e) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    });
  }
  // The heading label is a real <button>, so sorting is reachable by keyboard
  // and announced; the click still lands anywhere in the cell.
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
  window.addEventListener("resize", () => {
    invalidateLineOffsets();
    // Re-apply the *saved* preference at the new width, so widening the window
    // brings Split back instead of leaving the coerced Preview behind.
    setView(state.settings.view || "split", { remember: false });
  });

  // Reloading or closing the tab within the 500ms autosave debounce used to
  // discard that edit outright. `pagehide` is the reliable signal (mobile
  // browsers throttle `beforeunload`); `visibilitychange` covers app-switching.
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });

  // Task-list checkboxes render as real, clickable inputs, but nothing was
  // listening: the tick reverted on the next render and the Markdown never
  // changed. Each list item now carries its own data-source-line, so the source
  // can be rewritten exactly.
  preview.addEventListener("change", (e) => {
    const box = e.target;
    if (!box.matches?.('input[type="checkbox"]')) return;
    const li = box.closest("[data-source-line]");
    const line = Number(li?.getAttribute("data-source-line"));
    if (!Number.isFinite(line)) return;
    const lines = editor.value.split("\n");
    const src = lines[line];
    // Ordered ("1. [ ]") and block-quoted ("> - [ ]") task items are task items
    // too; they used to tick and then silently revert on the next render.
    if (src == null || !/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(src)) return;
    // Rewrite through replaceRange so the change joins the textarea's own undo
    // history instead of wiping it.
    let start = 0;
    for (let i = 0; i < line; i++) start += lines[i].length + 1;
    const box0 = src.indexOf("[");
    replaceRange(box.checked ? "[x]" : "[ ]", start + box0, start + box0 + 3, editor.selectionStart, editor.selectionEnd);
  });
}

function onShortcut(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") {
    // Dismiss the topmost transient layer only. Escape used to close the whole
    // Files view while leaving an open row menu floating over the editor — still
    // live, so its Rename item still renamed things.
    if (ctxEl) return closeContextMenu();
    if (menuEl) return closeGoogleMenu();
    if (document.querySelector(".modal:not([hidden])")) return closeModals();
    if (app.classList.contains("files-open")) return closeFiles();
    return;
  }
  if (!mod) return;
  // Text-editing shortcuts must not reach the document while the user is typing
  // in a field: Ctrl+B during a rename injected "**bold text**" into the
  // document body and yanked focus to the editor mid-word.
  const t = e.target;
  const inField =
    t && t !== editor && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);
  const modalOpen = !!document.querySelector(".modal:not([hidden])");
  const k = e.key.toLowerCase();
  if ((inField || modalOpen) && k !== "s") return;
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
  const ok = state.current ? persist(state.current) : true;
  if (!ok) return; // persist() already said what went wrong
  // Only push to Drive when there is actually a session. Keying off the
  // document's driveId alone meant a plain Ctrl+S could throw up a Google
  // consent popup the user never asked for.
  if (google.isConfigured() && google.hasSession() && (state.current?.driveId || google.isSignedIn())) {
    saveToDrive();
  } else if (state.current?.driveId) {
    toast("Saved to this browser — sign in to update the Drive copy", "success");
  } else {
    toast("Saved to this browser (autosave is on)", "success");
  }
}

/* ------------------------------------------------------------------ init */
function init() {
  // Adopt the remembered Google account BEFORE reading any documents, so a
  // reload shows the right library on the first paint instead of flashing the
  // signed-out one — which used to read as "logged out again", and worse, put
  // anything typed afterwards into the shared signed-out bucket.
  const restoredAccount = google.restoreSession();
  if (restoredAccount) setAccount(restoredAccount);

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

  // view + sidebar. On a phone the sidebar overlays the document, so start it
  // closed unless this browser has an explicit preference saved.
  setView(state.settings.view || "split");
  const narrow = window.matchMedia?.("(max-width: 720px)")?.matches === true;
  const collapsed = state.settings.sidebarCollapsed ?? narrow;
  if (collapsed) {
    app.classList.add("sidebar-collapsed");
    $("sidebar-toggle").setAttribute("aria-expanded", "false");
  }

  // google. The Client ID override may have been typed while signed out, so fall
  // back to the signed-out namespace's settings before config.js.
  const clientId =
    state.settings.googleClientId ||
    store.loadSettingsOf("anon").googleClientId ||
    CONFIG.googleClientId ||
    "";
  google.configure(clientId, CONFIG.driveFolderName, CONFIG.legacyDriveFolderNames);
  refreshGoogleUI();
  // Fetch the Google library now, not during the click that needs it: an
  // interactive popup opened after a cross-origin script fetch is blocked by
  // Safari and unreliable in Chrome.
  google.preload();
  // Renew the token in the background. Nothing blocks on it — the documents are
  // already on screen — it just means Drive works without a click.
  google.resumeSession().then((ok) => {
    refreshGoogleUI();
    if (ok && isExpanded(DRIVE_ROOT_KEY)) loadDriveFolder(state.driveRootId, { force: true });
  });

  wireEvents();
  setupDivider();
  setupFastTooltips();

  // Signal the HTML fallback watchdog that the module graph loaded and the app
  // booted (see the inline script in index.html), and hand the editor over.
  window.__mdsReady = true;
  editor.disabled = false;

  // Choose the document to show: shared link → last open → newest → sample.
  if (tryLoadShared()) return;
  const currentId = store.getCurrentId();
  const existing = state.library.find((d) => d.id === currentId) || state.library[0];
  if (existing) loadDoc(existing);
  else newDoc("Welcome.md", SAMPLE);
}

init();
