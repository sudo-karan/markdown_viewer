# Markdown Studio

A fast, **private**, browser-based Markdown editor & viewer that runs entirely
as static files — perfect for **GitHub Pages**. No backend, no database, no
tracking. It's a companion to the [`mo`](../README.md) CLI: `mo` views Markdown
on your own machine; **Markdown Studio** brings the same GitHub-flavored
rendering to the web and adds editing, a local document library, and optional
Google Drive sync.

## Features

- **Live split editor** — write on the left, styled preview on the right, with
  synced scrolling and a clickable outline.
- **GitHub-flavored Markdown** — tables, task lists, footnotes, and
  `> [!NOTE]`-style alerts.
- **Rich rendering** — syntax highlighting (highlight.js), **Mermaid** diagrams,
  and **KaTeX** math (`$…$` and `$$…$$`).
- **Folder tree sidebar** — one tree over two sources: **This browser** (local
  documents in virtual folders) and **Google Drive** (your `markdowns` folder,
  loaded on demand). Create folders, drag files between them, and rename — each
  change is written straight back to its source (localStorage or Drive).
- **Local-first** — every document autosaves to your browser. Import files from
  disk, drag-and-drop, or paste an image to embed it as a data URI.
- **Google Drive sync** (optional) — sign in with Google and keep documents in
  your own Drive under a single root folder (`markdowns` by default). By design
  the app can see *nothing else* in your Drive.
- **Export & share** — download `.md` or a self-contained `.html`, copy rendered
  HTML, print to PDF, or copy a link that encodes the whole document in the URL.
- **Themes** — GitHub light/dark, following your system preference.

## Host it on GitHub Pages

Everything here is static — there is **no build step**. Two ways to publish:

### Option 1 — GitHub Actions (recommended)

This repo ships `.github/workflows/pages.yml`, which uploads the `docs/` folder
to Pages on every push to `main`. Just enable it:

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (or run the workflow manually). Your site appears at
   `https://<user>.github.io/<repo>/`.

### Option 2 — Deploy from the `/docs` folder

1. Repo **Settings → Pages → Source: Deploy from a branch**.
2. Branch: `main`, folder: **`/docs`**. Save.

All asset paths in `docs/` are **relative**, so the app works from any subpath
(e.g. `/<repo>/`) with no configuration.

## Turn on accounts + Drive (~2 minutes, once per site)

Setting a Client ID does double duty: it enables Drive sync **and** turns
"Sign in with Google" into the app's account system.

- **You configure it once.** Put the Client ID in
  [`docs/config.js`](./config.js) and nobody else ever handles a key.
- **Everyone gets their own account.** Each visitor clicks *Sign in with
  Google*; their documents live in **their own** Drive and follow them to any
  device they sign in on.
- **A shared browser stays separated.** Each signed-in account gets its own
  local library, so two people on one laptop or tablet never see each other's
  files. (This is isolation, not a security boundary — anyone at the keyboard
  can read the browser's storage. The durable, private copy is each user's Drive.)
- **Signed out still works.** Without signing in, the app is a local,
  this-browser-only editor exactly as before.

There are no passwords to store: Google is the identity provider, and the app
never sees a credential.

A GitHub Pages site can't keep secrets, so Drive access uses Google's standard
browser OAuth flow. You only need a **Client ID** (which is public and safe to
share — it is *not* a secret):

1. Go to the [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create (or pick) a project. Configure the **OAuth consent screen** (External;
   add yourself as a test user while it's unverified).
3. **Create Credentials → OAuth client ID → Application type: Web application.**
4. Under **Authorized JavaScript origins**, add your Pages origin, e.g.
   `https://<user>.github.io`. (Origins are scheme + host only — no path.)
5. Copy the **Client ID**.
6. Commit it to [`docs/config.js`](./config.js) as `googleClientId` — that is
   what enables sign-in for everyone who visits the site. (Pasting it into the
   in-app **Settings** dialog also works, but only for that one browser.)
7. Add every person who should be able to sign in as a **test user** on the
   OAuth consent screen, until you publish/verify the app.

> [!NOTE]
> The app requests the least-privilege **`drive.file`** scope: it can only see
> and manage files it creates or that you explicitly open with it — never your
> whole Drive.

Also enable the **Google Drive API** for the project (APIs & Services →
Library → "Google Drive API" → Enable), otherwise Drive calls fail with a 403.

### The sidebar tree

The sidebar shows one tree with two roots:

- **This browser** — local documents, organized into virtual folders that live
  in your browser. Use **New file** / **New folder**, drag a file onto a folder
  to move it, or rename/delete from a row's **⋯** menu.
- **Google Drive** — expand it to load your **`markdowns`** root folder (created
  on first use; rename it in [`config.js`](./config.js) → `driveFolderName`).
  Create subfolders, drag files between them, rename, and delete (deletes move
  the item to the Drive trash). New files are created directly in Drive.

Renaming or saving writes straight back to wherever the file lives — localStorage
for local docs, the Drive API for Drive files.

### The Files view

The **Files** button in the toolbar opens a full-width browser over both
sources, with folder navigation (breadcrumbs) and sortable **Name / Size /
Created / Modified** columns — click a column heading to sort, click again to
reverse. Local folders roll their contents up, so a folder's size is the total
of everything inside it and its dates span its oldest and newest documents.
Clicking a file opens it; the **⋯** menu renames or deletes.

### Getting browser-only files onto your other devices

Documents created while signed out live only in that browser. Once signed in,
the account menu (click your name, top-right) offers **"Sync N browser-only
files to Drive"**, which uploads them so they're reachable from anywhere you
sign in. The first time you sign in on a browser that already has documents,
they're adopted into your account automatically so nothing appears to vanish.

Because the scope is `drive.file`, the app only ever sees the `markdowns`
subtree — specifically, the folders and files **it** creates or that you open
through it. Files you add to `markdowns` manually from the Drive website won't
appear here (that would require a broader, Google-verified scope, which this app
intentionally avoids).

## Security & privacy

- **No passwords are stored anywhere.** "Sign in" is Google OAuth; Google is the
  identity provider and the app never sees a credential.
- **No secrets in the site.** Only a public OAuth *Client ID* is used — never a
  client secret, API key, or service-account key (a static site can't protect
  those).
- **Your data stays yours.** Documents live in your browser's `localStorage` and,
  if you connect Drive, in *your own* Google Drive. Nothing is sent to any
  third-party server operated by this project.
- Rendered HTML is sanitized with DOMPurify before it touches the page.

## How it's built

Plain ES modules, no framework, no bundler. Third-party libraries load from
pinned CDN URLs (jsDelivr / esm.sh):

| Concern            | Library |
| ------------------ | ------- |
| Markdown parsing   | `markdown-it` (+ task-lists, footnote, anchor, texmath) |
| Math               | `katex` |
| Syntax highlighting| `highlight.js` |
| Diagrams           | `mermaid` |
| Sanitizing         | `dompurify` |
| Share-link codec   | `lz-string` |
| Base styles        | `github-markdown-css` |

Files:

- `index.html` — app shell
- `styles.css` — app chrome (the content itself is themed by `github-markdown-css`)
- `config.js` — public per-deployment config (Google Client ID, Drive folder name)
- `js/render.js` — the Markdown rendering pipeline
- `js/storage.js` — local library & settings (localStorage)
- `js/google.js` — Google Identity Services auth + Drive REST
- `js/app.js` — application controller
