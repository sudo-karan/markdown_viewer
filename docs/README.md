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
- **Local-first** — every document autosaves to your browser. Open files from
  disk, drag-and-drop, or paste an image to embed it as a data URI.
- **Google Drive sync** (optional) — sign in with Google and save/open documents
  in your own Drive.
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

## Enable Google Drive (optional, ~2 minutes)

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
6. Either paste it into the app's **Settings** dialog, or commit it to
   [`docs/config.js`](./config.js) as `googleClientId`.

> [!NOTE]
> The app requests the least-privilege **`drive.file`** scope: it can only see
> and manage files it creates or that you explicitly open with it — never your
> whole Drive.

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
