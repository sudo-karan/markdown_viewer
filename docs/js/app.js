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

/* ------------------------------------------------------------------ state */
const state = {
  settings: {},
  library: [],
  current: null, // {id,name,text,driveId,updated}
  view: "split",
  dark: true,
  renderTimer: 0,
  saveTimer: 0,
  syncingScroll: false,
};

/* ------------------------------------------------------------------ dom */
const $ = (id) => document.getElementById(id);
const app = $("app");
const editor = $("editor");
const preview = $("preview");
const docTitle = $("doc-title");
const saveState = $("save-state");
const storageLoc = $("storage-loc");
const libraryList = $("library-list");
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
function persist(doc, { markSaved = true } = {}) {
  doc.updated = Date.now();
  state.library = upsertDoc(state.library, doc);
  store.saveLibrary(state.library);
  store.setCurrentId(doc.id);
  renderLibrary();
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
  renderLibrary();
  setSaveState("saved");
  editor.scrollTop = 0;
}

function newDoc(name = "Untitled.md", text = "") {
  const doc = { id: uid(), name, text, driveId: null, updated: Date.now() };
  state.library = upsertDoc(state.library, doc);
  store.saveLibrary(state.library);
  loadDoc(doc);
  return doc;
}

function renderLibrary() {
  libraryList.innerHTML = "";
  if (state.library.length === 0) {
    libraryList.innerHTML = `<li style="color:var(--text-muted);font-size:12px;padding:8px">No documents yet.</li>`;
    return;
  }
  for (const doc of state.library) {
    const li = document.createElement("li");
    li.className = "library-item" + (doc.id === state.current?.id ? " is-active" : "");
    li.innerHTML = `
      <span class="library-name">${escapeHtml(doc.name)}</span>
      ${doc.driveId ? '<span class="library-badge">Drive</span>' : ""}
      <button class="lib-del" title="Delete">&times;</button>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".lib-del")) return;
      if (doc.id !== state.current?.id) loadDoc(doc);
    });
    li.querySelector(".lib-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDoc(doc);
    });
    libraryList.appendChild(li);
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
    renderLibrary();
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
  state.saveTimer = setTimeout(() => persist(state.current), 500);
}

/* ------------------------------------------------------------------ Google Drive */
function ensureMdName(name) {
  return /\.(md|markdown|txt|mmd)$/i.test(name) ? name : name.replace(/\s+$/, "") + ".md";
}

async function saveToDrive() {
  if (!google.isConfigured()) {
    toast("Add your Google Client ID in Settings to enable Drive.", "error");
    openModal("settings-modal");
    return;
  }
  setSaveState("saving");
  try {
    if (!google.isSignedIn()) await google.signIn();
    const name = ensureMdName(state.current.name);
    const res = state.current.driveId
      ? await google.drive.update(state.current.driveId, state.current.text)
      : await google.drive.create(name, state.current.text);
    state.current.driveId = res.id;
    if (res.name) {
      state.current.name = res.name;
      docTitle.value = res.name;
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

async function openDrivePicker() {
  if (!google.isConfigured()) {
    toast("Add your Google Client ID in Settings first.", "error");
    openModal("settings-modal");
    return;
  }
  openModal("drive-modal");
  const status = $("drive-status");
  const list = $("drive-list");
  list.innerHTML = "";
  status.hidden = false;
  status.textContent = "Loading your Markdown files…";
  try {
    if (!google.isSignedIn()) await google.signIn();
    refreshGoogleUI();
    const files = await google.drive.list();
    status.hidden = files.length > 0;
    if (files.length === 0) {
      status.textContent = "No Markdown files this app can access yet. Save one to Drive first.";
      return;
    }
    for (const f of files) {
      const li = document.createElement("li");
      li.className = "drive-item";
      const when = f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : "";
      li.innerHTML = `<span class="d-name">${escapeHtml(f.name)}</span><span class="d-time">${when}</span>`;
      li.addEventListener("click", () => openDriveFile(f));
      list.appendChild(li);
    }
  } catch (e) {
    status.hidden = false;
    status.textContent = e.message || "Could not reach Google Drive.";
  }
}

async function openDriveFile(f) {
  try {
    const text = await google.drive.read(f.id);
    closeModals();
    // Reuse an existing local doc bound to this Drive file, if any.
    const existing = state.library.find((d) => d.driveId === f.id);
    if (existing) {
      existing.text = text;
      existing.name = f.name;
      loadDoc(existing);
    } else {
      const doc = { id: uid(), name: f.name, text, driveId: f.id, updated: Date.now() };
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
  if (p) {
    googleBtn.classList.add("is-connected");
    googleLabel.textContent = (p.given_name || p.name || "Account").split(" ")[0];
    if (p.picture) {
      googleAvatar.src = p.picture;
      googleAvatar.hidden = false;
    }
    googleBtn.title = `${p.email || ""} — click for Drive actions`;
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
    ["Save to Drive", saveToDrive],
    ["Open from Drive", openDrivePicker],
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
  if (google.getProfile()) {
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
    const r = (e.clientX - ws.left - sidebar) / (ws.width - sidebar);
    const clamped = Math.min(0.8, Math.max(0.2, r));
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

  // Tab inserts two spaces (keeps flow inside the textarea).
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
      onEdit();
    }
  });

  docTitle.addEventListener("change", () => {
    if (!state.current) return;
    state.current.name = docTitle.value.trim() || "Untitled.md";
    persist(state.current);
    updateStorageLoc();
    renderLibrary();
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
  $("btn-open-drive").addEventListener("click", openDrivePicker);
  $("btn-share").addEventListener("click", shareLink);
  $("btn-export").addEventListener("click", () => openModal("export-modal"));
  $("btn-google").addEventListener("click", onGoogleButton);
  $("set-save").addEventListener("click", saveSettings);
  $("drive-refresh").addEventListener("click", openDrivePicker);

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

  // Choose the document to show: shared link → last open → newest → sample.
  if (tryLoadShared()) return;
  const currentId = store.getCurrentId();
  const existing = state.library.find((d) => d.id === currentId) || state.library[0];
  if (existing) loadDoc(existing);
  else newDoc("Welcome.md", SAMPLE);
}

init();
