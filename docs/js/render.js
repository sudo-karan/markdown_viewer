/*
 * render.js — the Markdown rendering pipeline.
 *
 * Everything here runs 100% client-side (this is why the app can live on static
 * hosting). markdown-it produces GitHub-flavored HTML; highlight.js colors code;
 * KaTeX renders math; Mermaid renders diagrams; DOMPurify sanitizes the output
 * before it ever touches the DOM.
 */
import MarkdownIt from "https://esm.sh/markdown-it@14.1.0";
import taskLists from "https://esm.sh/markdown-it-task-lists@2.1.1";
import footnote from "https://esm.sh/markdown-it-footnote@4.0.0";
import anchor from "https://esm.sh/markdown-it-anchor@9.2.0";
import texmath from "https://esm.sh/markdown-it-texmath@1.0.0";
import katex from "https://esm.sh/katex@0.16.11";
import DOMPurify from "https://esm.sh/dompurify@3.2.4";

// highlight.js is loaded as a single-file global build (see index.html) rather
// than via esm.sh, which would pull hundreds of per-language submodules.
const hljs = window.hljs;
import mermaid from "https://esm.sh/mermaid@11.4.1";

/** Stable, GitHub-compatible heading slugs (used by the outline + anchor links). */
export function slugify(str) {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(code, lang) {
    if (lang && lang.toLowerCase() === "mermaid") {
      // Leave mermaid blocks untouched; enhance() renders them post-sanitize.
      return `<pre class="mermaid-src"><code class="language-mermaid">${md.utils.escapeHtml(
        code,
      )}</code></pre>`;
    }
    if (hljs && lang && hljs.getLanguage(lang)) {
      try {
        return `<pre><code class="hljs language-${lang}">${
          hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        }</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre><code class="hljs">${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

md.use(taskLists, { enabled: true });
md.use(footnote);
md.use(anchor, {
  slugify,
  permalink: anchor.permalink.ariaHidden({
    symbol: "#",
    placement: "before",
    class: "anchor-link",
  }),
});
md.use(texmath, {
  engine: katex,
  delimiters: ["dollars", "beg_end"],
  katexOptions: { throwOnError: false, output: "htmlAndMathml" },
});

/* Render <img> lazily and open external links safely. */
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") || "";
  if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const ALERT_TYPES = {
  NOTE: "note",
  TIP: "tip",
  IMPORTANT: "important",
  WARNING: "warning",
  CAUTION: "caution",
};

// --- Sanitizer hardening -------------------------------------------------
// Untrusted Markdown can arrive via #s= share links and Drive files, so scrub
// inline CSS that enables full-viewport phishing overlays or exfiltration,
// while preserving the inline styles KaTeX and Mermaid legitimately emit (which
// never set `position`/`z-index` or external `url()`). Also force rel=noopener
// on any target=_blank link, including ones authored as raw HTML.
function scrubStyle(value) {
  return value
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((decl) => {
      const m = decl.match(/^([\w-]+)\s*:\s*([\s\S]*)$/);
      if (!m) return false;
      const prop = m[1].toLowerCase();
      const val = m[2].toLowerCase();
      if (prop === "position" && /(fixed|absolute|sticky)/.test(val)) return false;
      if (prop === "z-index") return false;
      if (/expression\s*\(|behavior\s*:|-moz-binding|@import/.test(val)) return false;
      // Allow url(#fragment) (SVG gradient refs); block external/scheme url()s.
      if (/url\s*\(\s*['"]?\s*(?!#)/.test(val)) return false;
      return true;
    })
    .join("; ");
}

DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "style" && data.attrValue) {
    data.attrValue = scrubStyle(data.attrValue);
  }
});
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * Render Markdown source to a sanitized HTML string.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  const dirty = md.render(text || "");
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
    ADD_ATTR: ["target", "align", "start", "type", "checked", "disabled", "class", "style"],
    ADD_TAGS: ["details", "summary"],
    FORBID_TAGS: ["style"],
    ALLOW_DATA_ATTR: false,
  });
}

/** Convert GitHub-style `> [!NOTE]` blockquotes into styled alert callouts. */
function applyAlerts(container) {
  container.querySelectorAll("blockquote").forEach((bq) => {
    const first = bq.querySelector("p");
    if (!first) return;
    const m = first.textContent.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/);
    if (!m) return;
    const kind = ALERT_TYPES[m[1].toUpperCase()];
    bq.classList.add("md-alert", kind);
    // Strip the marker text from the first line.
    first.innerHTML = first.innerHTML.replace(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br>)?/i, "");
    const title = document.createElement("p");
    title.className = "md-alert-title";
    title.textContent = kind;
    bq.insertBefore(title, bq.firstChild);
    if (!first.textContent.trim()) first.remove();
  });
}

let mermaidReady = false;
function initMermaid(dark) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    fontFamily: "var(--font-sans)",
  });
  mermaidReady = true;
}

/**
 * Post-render enhancement that must run AFTER the sanitized HTML is in the DOM:
 * render Mermaid diagrams and apply alert styling. Safe to call repeatedly.
 * @param {HTMLElement} container
 * @param {{dark:boolean}} opts
 */
export async function enhance(container, { dark }) {
  applyAlerts(container);

  const blocks = [...container.querySelectorAll("code.language-mermaid")];
  if (blocks.length === 0) return;

  initMermaid(dark);
  await Promise.all(
    blocks.map(async (code, i) => {
      const pre = code.closest("pre") || code;
      const src = code.textContent || "";
      try {
        const { svg } = await mermaid.render(`mmd-${i}-${Math.floor(Math.random() * 1e9)}`, src);
        const fig = document.createElement("div");
        fig.className = "mermaid-figure";
        fig.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        pre.replaceWith(fig);
      } catch {
        // Leave the original code block on parse errors.
      }
    }),
  );
}

/** Extract the heading outline from already-rendered preview DOM. */
export function extractOutline(container) {
  const items = [];
  container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    if (!h.id) return;
    // Ignore the injected anchor "#" text.
    const text = h.textContent.replace(/^#\s*/, "").trim();
    items.push({ id: h.id, level: Number(h.tagName[1]), text });
  });
  return items;
}
