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

/**
 * Stable, GitHub-compatible heading slugs (used by the outline + anchor links).
 *
 * Unicode-aware on purpose: `\w` is ASCII-only, so a `[^\w\- ]` filter deleted
 * every character of a Japanese, Chinese, Korean or Cyrillic heading, leaving it
 * with an empty id — which dropped it from the outline entirely and broke any
 * in-document link to it. GitHub keeps Unicode letters, and so do we.
 */
export function slugify(str) {
  return String(str)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- ]+/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * YAML front matter is metadata, not content. Left alone it renders as a
 * horizontal rule plus a setext heading built out of the keys, which then leads
 * the outline. Blank it out rather than deleting it so every following line
 * keeps its original number and `data-source-line` stays truthful.
 */
function blankFrontMatter(text) {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text || "");
  if (!m) return text || "";
  const newlines = (m[0].match(/\n/g) || []).length;
  return "\n".repeat(newlines) + text.slice(m[0].length);
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
      if (t.map) t.attrSet("data-source-line", String(t.map[0]));
      return prev(tokens, idx, options, env, self);
    };
  }
}
// Nested blocks are stamped too (the old `level === 0` restriction meant every
// bullet of a 40-item list and every row of a table reported the line of the
// list/table itself, so "click the preview to find the source" always landed on
// the first line). Document order still gives monotonically increasing lines,
// which is all the scroll-sync interpolation needs.
stampSourceLines([
  "paragraph_open",
  "heading_open",
  "blockquote_open",
  "bullet_list_open",
  "ordered_list_open",
  "list_item_open",
  "table_open",
  "tr_open",
  "code_block", // indented code — renders via renderAttrs, so attrSet works
  "hr",
]);

// Raw HTML blocks are emitted verbatim from token.content, so the generic
// stamper can't reach them: without this a document that is mostly raw HTML has
// no anchors at all and scroll sync silently falls back to a proportional map.
const defaultHtmlBlock =
  md.renderer.rules.html_block || ((tokens, idx) => tokens[idx].content);
md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
  const out = defaultHtmlBlock(tokens, idx, options, env, self);
  const t = tokens[idx];
  if (t.map) return out.replace(/^(\s*<[a-zA-Z][\w-]*)\b/, `$1 data-source-line="${t.map[0]}"`);
  return out;
};

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
// Pattern-matching the raw declaration text is not enough: CSS identifiers
// accept `\XX ` hex escapes, so `position:\66 ixed` and
// `background-image:\75 rl(https://…)` sail straight past a text filter and are
// then resolved by the CSS parser — giving a full-viewport overlay and a working
// exfiltration beacon respectively. Parse the declaration with the browser's own
// parser first (which normalises escapes), then inspect the result.
const styleProbe = document.createElement("span");
function scrubStyle(value) {
  styleProbe.style.cssText = "";
  try {
    styleProbe.style.cssText = value;
  } catch {
    return "";
  }
  for (const prop of [...styleProbe.style]) {
    const val = styleProbe.style.getPropertyValue(prop).toLowerCase();
    const drop =
      (prop === "position" && /fixed|absolute|sticky/.test(val)) ||
      prop === "z-index" ||
      /expression\s*\(|behavior|-moz-binding|@import/.test(val) ||
      // Allow url(#fragment) (SVG gradient/marker refs); block everything that
      // reaches the network.
      /url\(\s*["']?\s*(?!#)/.test(val);
    if (drop) styleProbe.style.removeProperty(prop);
  }
  return styleProbe.style.cssText;
}

// Interactive form controls have no place in rendered Markdown, and DOMPurify's
// default HTML profile allows them. A document arriving through a #s= share link
// or a Drive file could therefore render a convincing full-page "Sign in with
// Google" form ON THE APP'S OWN ORIGIN and POST the password anywhere. The one
// exception is the task-list checkbox, which is stripped down to nothing that
// can be submitted.
const FORM_TAGS = [
  "form", "button", "select", "option", "optgroup", "textarea", "label",
  "fieldset", "legend", "output", "progress", "meter", "dialog", "datalist",
];
const CHECKBOX_ATTRS = ["type", "checked", "disabled", "class", "id"];

// Ids written by the document must not be able to shadow the application's own
// elements: `document.getElementById("files-view")` would otherwise find a
// heading in the preview (a plain `## Files view` is enough — its slug collides),
// and clicking Files would show a blank workspace. GitHub prefixes for exactly
// this reason. Only applied to Markdown output; the Mermaid SVG pass needs its
// internal `url(#id)` marker references left intact.
const ID_PREFIX = "user-content-";
let namespaceIds = false;

DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  if (!namespaceIds || data.tagName !== "input") return;
  const type = (node.getAttribute?.("type") || "").toLowerCase();
  if (type !== "checkbox") {
    node.parentNode?.removeChild(node);
    return;
  }
  for (const attr of [...(node.attributes || [])]) {
    if (!CHECKBOX_ATTRS.includes(attr.name.toLowerCase())) node.removeAttribute(attr.name);
  }
});
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "style" && data.attrValue) {
    data.attrValue = scrubStyle(data.attrValue);
  }
});
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (!namespaceIds || !node.getAttribute) return;
  const id = node.getAttribute("id");
  if (id && !id.startsWith(ID_PREFIX)) node.setAttribute("id", ID_PREFIX + id);
  if (node.tagName === "A") {
    const href = node.getAttribute("href") || "";
    // Keep in-document links working now that their targets are prefixed.
    if (href.length > 1 && href[0] === "#" && !href.startsWith("#" + ID_PREFIX)) {
      node.setAttribute("href", "#" + ID_PREFIX + href.slice(1));
    }
  }
});

/**
 * Render Markdown source to a sanitized HTML string.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  const dirty = md.render(blankFrontMatter(text));
  namespaceIds = true;
  try {
    return DOMPurify.sanitize(dirty, {
      USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
      ADD_ATTR: ["target", "align", "start", "type", "checked", "disabled", "class", "style", "encoding", "data-source-line"],
      // `semantics`/`annotation` carry KaTeX's original TeX. Dropping them left
      // the raw source as a loose text node inside <math>, which then leaked
      // into Export HTML, Copy HTML and any text selection.
      ADD_TAGS: ["details", "summary", "semantics", "annotation"],
      FORBID_TAGS: ["style", ...FORM_TAGS],
      FORBID_ATTR: ["action", "formaction", "form", "method", "enctype", "autofocus", "name"],
      ALLOW_DATA_ATTR: false,
    });
  } finally {
    namespaceIds = false;
  }
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
  container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h, i) => {
    // A heading with no id (raw HTML, or one whose text slugs to nothing) used
    // to be dropped from the outline entirely. Give it one instead.
    if (!h.id) h.id = `user-content-heading-${i}`;
    // Ignore the injected anchor "#" text.
    const text = h.textContent.replace(/^#\s*/, "").trim();
    items.push({ id: h.id, level: Number(h.tagName[1]), text });
  });
  return items;
}
