// Same pages, two extractions: score each with Jev from the browser's text and from Jina's.
// Usage (from worker/): npx vite-node scripts/compare.ts browser-pages.json "search query"
import { readFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { cleanMarkdown, toPassages } from "../src/cleanMarkdown";
import { judgePage } from "../src/judge";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const [file, query] = process.argv.slice(2);
const pages = JSON.parse(readFileSync(file, "utf8")) as Record<string, { title: string; markdown: string } | null>;
const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });

const judge = (url: string, title: string, md: string) => {
  const p = cleanMarkdown(md, title);
  return judgePage(client, query, url, p.title, p.markdown, toPassages(p.blocks), 0);
};

const rows = await Promise.all(
  Object.entries(pages).map(async ([url, b]) => {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "application/json", "X-Return-Format": "markdown", Authorization: `Bearer ${env.JINA_API_KEY}` },
      signal: AbortSignal.timeout(40_000),
    }).then((r) => r.json() as Promise<{ data?: { content?: string; title?: string } }>).catch(() => ({ data: undefined }));
    const [vb, vj] = await Promise.all([
      b ? judge(url, b.title, b.markdown) : null,
      res.data?.content ? judge(url, res.data.title ?? "", res.data.content) : null,
    ]);
    const fmt = (v: Awaited<ReturnType<typeof judgePage>> | null) =>
      v ? `${v.score} r${v.relevance} d${v.depth} ${v.category}` : "—";
    return {
      host: new URL(url).hostname,
      browser: fmt(vb),
      jina: fmt(vj),
      passage_b: vb?.keyPassage?.slice(0, 24) ?? "",
      passage_j: vj?.keyPassage?.slice(0, 24) ?? "",
    };
  }),
);
console.table(rows);
