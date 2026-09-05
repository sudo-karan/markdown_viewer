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
// Mermaid comes from jsDelivr's *official npm dist*, not esm.sh. esm.sh rebuilds
// packages and resolves their dependencies at caret ranges (dompurify@^3.2.1,
// marked@^13.0.2, lodash-es@^4.17.21 …), so the module it serves is a different
// artifact whose behaviour can drift underneath us — in practice it ignored our
// htmlLabels:false and emitted <foreignObject> labels, which the SVG sanitizer
// then stripped, leaving correctly-sized but completely empty nodes.
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";

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

/*
 * Source-line mapping: stamp each top-level block element with the 0-based line
 * of the Markdown source it came from (token.map). The editor and preview use
 * these `data-source-line` anchors to scroll in lock-step and to jump from a
 * clicked preview element back to its source in the editor. Only rules that
 * render via renderToken (and therefore emit token attributes) are wrapped —
 * notably NOT `fence`, whose custom highlight()/Mermaid handling builds its own
 * markup and would drop the attribute anyway.
 */
function stampSourceLines(rules) {
  for (const rule of rules) {
    const prev =
      md.renderer.rules[rule] ||
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
      const t = tokens[idx];
      if (t.level === 0 && t.map) t.attrSet("data-source-line", String(t.map[0]));
      return prev(tokens, idx, options, env, self);
    };
  }
}
stampSourceLines([
  "paragraph_open",
  "heading_open",
  "blockquote_open",
  "bullet_list_open",
  "ordered_list_open",
  "table_open",
  "hr",
]);

// Code fences (including Mermaid) build their own markup via highlight(), so the
// generic stamper can't reach them. Wrap the fence renderer to inject the source
// line onto its <pre>, so clicking a code block or diagram jumps to its source
// and scroll-sync has an anchor at large code blocks.
const defaultFence =
  md.renderer.rules.fence ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const out = defaultFence(tokens, idx, options, env, self);
  const t = tokens[idx];
  if (t.map) return out.replace(/^(\s*<pre\b)/i, `$1 data-source-line="${t.map[0]}"`);
  return out;
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
    ADD_ATTR: ["target", "align", "start", "type", "checked", "disabled", "class", "style", "data-source-line"],
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

/*
 * Label safety net.
 *
 * Mermaid can render node labels either as SVG <text> or as HTML inside an
 * <foreignObject>. Only the first survives the SVG sanitizer — foreignObject
 * content lives in the XHTML namespace and DOMPurify drops it in every
 * configuration (verified in a real browser), which is what produced diagrams
 * with correctly-sized but completely empty boxes.
 *
 * We ask for text mode (htmlLabels:false), but we do not *depend* on Mermaid
 * honouring it: any foreignObject that still shows up is rewritten into real
 * <text>/<tspan> here, before sanitizing. That makes visible labels a property
 * of this pipeline rather than of whichever Mermaid build happens to load.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_LINE_HEIGHT = 17;

function convertForeignObjectLabels(root) {
  for (const fo of [...root.querySelectorAll("foreignObject")]) {
    // <br> is the line separator Mermaid uses inside HTML labels.
    const lines = fo.innerHTML
      .split(/<br\s*\/?>/i)
      .map((chunk) => {
        const tmp = document.createElement("div");
        tmp.innerHTML = chunk;
        return (tmp.textContent || "").replace(/\s+/g, " ").trim();
      })
      .filter(Boolean);
    if (!lines.length) {
      fo.remove();
      continue;
    }
    const x = parseFloat(fo.getAttribute("x") || "0");
    const y = parseFloat(fo.getAttribute("y") || "0");
    const w = parseFloat(fo.getAttribute("width") || "0");
    const h = parseFloat(fo.getAttribute("height") || "0");
    const cx = x + w / 2;
    // Vertically centre the block of lines inside the label box.
    const top = y + (h - (lines.length - 1) * LABEL_LINE_HEIGHT) / 2;

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("class", "nodeLabel");
    text.setAttribute("x", String(cx));
    text.setAttribute("y", String(top));
    lines.forEach((line, i) => {
      const tspan = document.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("x", String(cx));
      if (i) tspan.setAttribute("dy", String(LABEL_LINE_HEIGHT));
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    fo.replaceWith(text);
  }
}

/**
 * Clean up a freshly rendered Mermaid SVG before it is sanitized.
 * @param {string} svgString
 * @returns {string}
 */
function normalizeMermaidSvg(svgString) {
  // With htmlLabels off Mermaid double-escapes `&` in subgraph titles, so
  // "A & B" would render as the literal text "A &amp; B".
  const fixed = svgString.replace(/&amp;amp;/g, "&amp;");
  if (!/foreignObject/i.test(fixed)) return fixed;
  const holder = document.createElement("div");
  holder.innerHTML = fixed;
  convertForeignObjectLabels(holder);
  return holder.innerHTML;
}

/** Parse a computed "rgb(r, g, b)" / "rgba(...)" colour into [r,g,b]. */
function parseRgb(value) {
  const m = String(value).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
/** WCAG relative luminance, 0 (black) → 1 (white). */
function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/**
 * Mermaid colours label text for its own theme, not for per-node colours. A node
 * given a light custom fill (`style X fill:#ffe0b2`) while the dark theme is
 * active therefore gets near-invisible light-grey text. Repaint every label so it
 * contrasts with the shape it actually sits on. Must run with the figure already
 * in the document so getComputedStyle resolves the real fill.
 * @param {HTMLElement} fig
 */
function fixDiagramContrast(fig) {
  for (const group of fig.querySelectorAll("g.node, g.cluster")) {
    const shape = group.querySelector("rect, polygon, circle, ellipse, path");
    if (!shape) continue;
    const rgb = parseRgb(getComputedStyle(shape).fill);
    if (!rgb) continue; // fill:none / gradient → leave Mermaid's colour alone
    const ink = luminance(rgb) > 0.45 ? "#1f2328" : "#e6edf3";
    for (const t of group.querySelectorAll("text, tspan")) t.style.fill = ink;
  }
}

let mermaidReady = false;
function initMermaid(dark) {
  mermaid.initialize({
    startOnLoad: false,
    // 'strict' keeps click-handlers/scripts out of untrusted diagrams.
    securityLevel: "strict",
    // Render labels as real SVG <text>/<tspan> instead of HTML in a
    // <foreignObject>. foreignObject label text is stripped by the SVG
    // sanitizer below (it lives in the XHTML namespace), which is why diagrams
    // previously rendered as empty shapes. Text mode survives sanitization and
    // still honours <br/> line breaks in multi-line labels.
    htmlLabels: false,
    // Extra room above/below a subgraph title: in text mode a long title wraps
    // to two lines and would otherwise be clipped by the subgraph border.
    flowchart: { htmlLabels: false, subGraphTitleMargin: { top: 8, bottom: 8 } },
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
        const rendered = await mermaid.render(`mmd-${i}-${Math.floor(Math.random() * 1e9)}`, src);
        const svg = normalizeMermaidSvg(rendered.svg);
        const fig = document.createElement("div");
        fig.className = "mermaid-figure";
        // Carry the fence's source line onto the figure so clicking the diagram
        // jumps back to its Markdown source.
        const srcLine = pre.getAttribute && pre.getAttribute("data-source-line");
        if (srcLine) fig.setAttribute("data-source-line", srcLine);
        // Defense-in-depth second pass (Mermaid already sanitizes in strict mode).
        // The SVG profile keeps <text>/<tspan> label text and the embedded <style>
        // that colours the diagram; with htmlLabels off there is no foreignObject
        // content left to lose here.
        fig.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        pre.replaceWith(fig);
        fixDiagramContrast(fig); // after insertion, so computed fills resolve
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
