// Fetch a page as Markdown: Cloudflare Browser Run (Kitesurf) first, Jina Reader as fallback.
// Docs: https://developers.cloudflare.com/browser-run/kitesurf/ · https://jina.ai/reader/

import { cleanMarkdown, type CleanPage } from "./cleanMarkdown";

export interface FetchEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  /** Optional; without it Jina uses the lower anonymous rate limit. */
  JINA_API_KEY?: string;
}

export type Source = "kitesurf" | "jina";

/** Below this (after cleaning), treat the result as a failed render (bot wall, empty shell, error page). */
const MIN_CONTENT_CHARS = 200;

interface RawPage {
  markdown: string;
  title?: string;
}

export async function fetchPage(env: FetchEnv, url: string): Promise<CleanPage & { source: Source }> {
  const errors: string[] = [];
  for (const [source, fetcher] of [
    ["kitesurf", fetchViaKitesurf],
    ["jina", fetchViaJina],
  ] as const) {
    try {
      const raw = await fetcher(env, url);
      const page = cleanMarkdown(raw.markdown, raw.title);
      if (page.markdown.length >= MIN_CONTENT_CHARS) return { ...page, source };
      errors.push(`${source}: only ${page.markdown.length} chars after cleaning`);
    } catch (err) {
      errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Could not fetch ${url} (${errors.join("; ")})`);
}

async function fetchViaJina(env: FetchEnv, url: string): Promise<RawPage> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Return-Format": "markdown",
  };
  if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;

  const res = await fetch(`https://r.jina.ai/${url}`, { headers });
  const body = (await res.json()) as {
    data?: { content?: string; title?: string };
    readableMessage?: string;
  };
  if (!res.ok || typeof body.data?.content !== "string") {
    throw new Error(`${res.status} ${body.readableMessage ?? ""}`.trim());
  }
  return { markdown: body.data.content, title: body.data.title };
}

async function fetchViaKitesurf(env: FetchEnv, url: string): Promise<RawPage> {
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/browser-run/markdown?browser=kitesurf`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      // Skip heavy assets; we only need the text.
      rejectRequestPattern: ["/^.*\\.(css|png|jpe?g|gif|webp|svg|woff2?|mp4)(\\?.*)?$/"],
    }),
  });

  const body = (await res.json()) as { success: boolean; result?: string; errors?: unknown };
  if (!res.ok || !body.success || typeof body.result !== "string") {
    throw new Error(`${res.status} ${JSON.stringify(body.errors)}`);
  }
  // Title comes from the result's own front matter, which cleanMarkdown parses.
  return { markdown: body.result };
}
