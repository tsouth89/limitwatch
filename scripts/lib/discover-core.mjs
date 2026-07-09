// Pure parsing + quote-verification helpers for scripts/discover.mjs. Kept dependency- and
// side-effect-free (no fetch, no fs) so they can be unit-tested in isolation — discover.mjs itself
// runs network/fs at module load, so its logic can't be imported directly. quoteInSource() is the
// anti-hallucination guard: it is the single check that lets an auto-extracted event publish only
// when its quote appears verbatim in the cited source, so it must stay covered by tests.

export const decode = (s) => (s ?? "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
  .trim();

export const tag = (block, name) => decode(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "");

// Strip an HTML page down to readable text (drop script/style, tags -> spaces, decode entities).
export const stripHtml = (html) => decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export const MODEL_AVAILABILITY_GUIDANCE =
  "A model announcement qualifies as model_availability only when it explicitly changes access for named consumer/prosumer plans (Free, Plus, Pro, Max, Team, Enterprise, etc.) or a tracked subscriber surface (ChatGPT, Claude, Claude Code, Cursor, Cowork, etc.). Exclude generic API-only launches, developer-platform releases, capability/context-window announcements, benchmarks, and model news without a named subscriber access change.";

export const classifyModelAvailabilityText = (text) => {
  const s = String(text ?? "");
  const hasModel = /\b(model|available|access|default|included|selectable)\b/i.test(s);
  const hasPlan = /\b(free|plus|pro|pro\+|max|team|enterprise|business|ultra|subscriber|subscription)\b/i.test(s);
  const hasSurface = /\b(chatgpt|claude(?:\.ai)?|claude code|cursor|cowork|gemini)\b/i.test(s);
  const apiOnly = /\b(api|sdk|developer platform|benchmark|benchmarks)\b/i.test(s) && !hasPlan && !hasSurface;
  return hasModel && (hasPlan || hasSurface) && !apiOnly ? "model_availability" : null;
};

// Normalize for verbatim matching: lowercase, collapse every non-alphanumeric run to one space.
export const normForMatch = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// The anti-hallucination guard: a quote may publish ONLY if it appears (normalized) in the source
// page text. Requires a meaningful length so trivial fragments can't pass.
export const quoteInSource = (quote, pageText) => {
  const q = normForMatch(quote);
  if (q.split(" ").length < 6 || q.length < 30) return false;
  return normForMatch(pageText).includes(q);
};

// Minimal RSS/Atom item extraction — no deps. Handles <item> (RSS) and <entry> (Atom).
export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    // RSS uses <link>url</link>; Atom uses <link href="url"/>.
    const link = tag(b, "link") || (b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? "");
    const id = tag(b, "guid") || tag(b, "id") || link;
    const date = tag(b, "pubDate") || tag(b, "updated") || tag(b, "published") || "";
    if (title && link) items.push({ title, link, id, date });
  }
  return items;
}

// HTML source (providers without a feed, e.g. Anthropic): pull article links matching a pattern
// off a server-rendered index page, with the heading text as the title (humanized slug fallback).
export const humanize = (href) => (href.split(/[?#]/)[0].split("/").filter(Boolean).pop() || href).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export function parseHtml(html, base, pattern) {
  const re = new RegExp(`href=["'](${pattern})["']`, "gi");
  const seen = new Set(); const items = [];
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (seen.has(href)) continue; seen.add(href);
    const after = html.slice(m.index, m.index + 500);
    const h = after.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
    const title = (h ? decode(h[1]) : "") || humanize(href);
    const link = /^https?:/i.test(href) ? href : base.replace(/\/$/, "") + href;
    items.push({ title, link, id: link, date: "" });
  }
  return items;
}
