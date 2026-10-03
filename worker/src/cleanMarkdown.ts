// Turn a rendered page's Markdown into the part a reader actually came for:
// drop front matter, site navigation before the article, and link-dense blocks
// (menus, footers, "related" lists), while keeping code blocks intact.

export interface Block {
  text: string;
  code: boolean;
}

export interface CleanPage {
  title: string;
  markdown: string;
  blocks: Block[];
}

/** Share of a block's visible text that is link text, above which it counts as navigation. */
const MAX_LINK_DENSITY = 0.6;

export function cleanMarkdown(raw: string, fallbackTitle = ""): CleanPage {
  let { title, body } = splitFrontMatter(raw);
  title ||= fallbackTitle;

  const blocks = splitBlocks(skipToArticle(body, title)).filter(
    (b) => b.code || (visibleText(b.text).length > 0 && linkDensity(b.text) <= MAX_LINK_DENSITY),
  );
  return { title, markdown: blocks.map((b) => b.text).join("\n\n"), blocks };
}

const MIN_PASSAGE_WEIGHT = 80;
/** When no paragraph reaches MIN_PASSAGE_WEIGHT, the longest one may still qualify above this. */
const MIN_FALLBACK_WEIGHT = 20;

/** Readable paragraph candidates for "show the key passage". */
export function toPassages(blocks: Block[], max = 40): string[] {
  const prose = blocks
    .filter((b) => !b.code && !looksLikeCode(b.text))
    .map((b) => b.text.trim())
    .filter((p) => !/^[#!|>]/.test(p)) // skip headings, images, tables, quotes
    .map((text) => ({ text, weight: textWeight(visibleText(text)) }));

  let picked = prose.filter((p) => p.weight >= MIN_PASSAGE_WEIGHT);
  if (picked.length === 0) {
    // Pages with only short text, e.g. a job whose whole description is one line.
    const longest = prose.reduce<(typeof prose)[number] | null>((a, p) => (!a || p.weight > a.weight ? p : a), null);
    picked = longest && longest.weight >= MIN_FALLBACK_WEIGHT ? [longest] : [];
  }

  return picked.slice(0, max).map(({ text }) => (text.length > 600 ? `${text.slice(0, 600)}…` : text));
}

/** Markdown passage → plain text for display: link labels only, no emphasis/code marks or HTML tags. */
export function toPlainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\]\([^)]*$/, "") // link cut off by passage truncation
    .replace(/[[\]]/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "• ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function splitFrontMatter(raw: string): { title: string; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { title: "", body: raw };
  const title = m[1].match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? "";
  return { title, body: raw.slice(m[0].length) };
}

/**
 * Start at the first H1 whose text appears in the page title, e.g. "# MutationObserver"
 * in "MutationObserver - Web APIs | MDN". Earlier H1s (sign-up modals, site logos) don't match.
 */
function skipToArticle(body: string, title: string): string {
  if (!title) return body;
  const wanted = normalize(visibleText(title)); // same transform as the H1, so "Engineer-Angular" still matches
  const lines = body.split("\n");
  const start = lines.findIndex((line) => {
    const h1 = line.match(/^#\s+(.*)/)?.[1];
    if (!h1) return false;
    const text = normalize(visibleText(h1));
    return text.length >= 4 && wanted.includes(text);
  });
  return start > 0 ? lines.slice(start).join("\n") : body;
}

/** Split on blank lines, but never inside a ``` fence, so code stays one block. */
function splitBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (code: boolean) => {
    const text = current.join("\n").trim();
    if (text) blocks.push({ text, code });
    current = [];
  };

  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (!inFence) flush(false);
      current.push(line);
      if (inFence) flush(true);
      inFence = !inFence;
    } else if (!inFence && line.trim() === "") {
      flush(false);
    } else {
      current.push(line);
    }
  }
  flush(inFence);
  return blocks;
}

/** Text a reader would see: images removed, links reduced to their label. */
function visibleText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function linkDensity(md: string): number {
  const visible = visibleText(md).length;
  if (visible === 0) return 1;
  const linked = [...md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").matchAll(/\[([^\]]*)\]\([^)]*\)/g)]
    .reduce((n, m) => n + visibleText(m[1]).length, 0);
  return linked / visible;
}

/** Unfenced code, e.g. indented snippets: most lines end in ; { } or are // comments. */
function looksLikeCode(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  const codey = lines.filter((l) => /[;{}(]\s*$|^\s*(\/\/|\/\*|\*)/.test(l)).length;
  return lines.length > 0 && codey / lines.length > 0.4;
}

/** Length with CJK characters counted twice: 65 Chinese characters say about as much as 130 Latin ones. */
function textWeight(s: string): number {
  return s.length + (s.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)?.length ?? 0);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
