// Where does the time go? For each URL: Kitesurf fetch, Jina fetch, and the Jev request,
// timed separately and run the way the Worker runs them (all URLs at once).
// Usage (from worker/): npx vite-node scripts/timing.ts urls.txt "search query"
// Reads keys from ../.env; never prints them.

import { readFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { cleanMarkdown, toPassages } from "../src/cleanMarkdown";
import { judgePage } from "../src/judge";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const CF_TOKEN = env.CF_API_TOKEN ?? env.CF_API_KEY;
const [file, query] = process.argv.slice(2);
const urls = readFileSync(file, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const t = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - t), value };
  } catch (err) {
    return { ms: Math.round(performance.now() - t), error: err instanceof Error ? err.message.slice(0, 60) : String(err) };
  }
}

const kitesurf = (url: string) =>
  timed(async () => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-run/markdown?browser=kitesurf`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, rejectRequestPattern: ["/^.*\\.(css|png|jpe?g|gif|webp|svg|woff2?|mp4)(\\?.*)?$/"] }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = (await res.json()) as { success: boolean; result?: string };
    if (!body.success || !body.result) throw new Error(`status ${res.status}`);
    return cleanMarkdown(body.result);
  });

const jina = (url: string) =>
  timed(async () => {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "application/json", "X-Return-Format": "markdown", Authorization: `Bearer ${env.JINA_API_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { data?: { content?: string; title?: string } };
    if (!body.data?.content) throw new Error(`status ${res.status}`);
    return cleanMarkdown(body.data.content, body.data.title);
  });

const rows = await Promise.all(
  urls.map(async (url) => {
    const [k, j] = await Promise.all([kitesurf(url), jina(url)]);
    const page = j.value?.markdown && j.value.markdown.length >= 200 ? j.value : k.value;
    const jev = page
      ? await timed(() => judgePage(client, query, url, page.title, page.markdown, toPassages(page.blocks), 0))
      : { ms: 0, error: "no page" };
    return {
      host: new URL(url).hostname,
      kitesurf: k.error ? `✗ ${k.ms} (${k.error})` : `${k.ms} / ${k.value!.markdown.length}ch`,
      jina: j.error ? `✗ ${j.ms} (${j.error})` : `${j.ms} / ${j.value!.markdown.length}ch`,
      jev: jev.error ? `✗ ${jev.ms}` : jev.ms,
    };
  }),
);
console.table(rows);
