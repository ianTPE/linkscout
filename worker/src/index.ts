// POST /score  { query, urls[], pages? }  →  { results: (Verdict | { url, error })[] }
//
// `pages` lets the extension supply content it already has (e.g. from a site's own API,
// fetched in the user's browser) for sites that block Browser Run and Jina.

import { TypeSafeClient } from "@typesafe-ai/sdk";
import { cleanMarkdown, toPassages } from "./cleanMarkdown";
import { fetchPage, type Source } from "./fetchPage";
import { judgePage, type Verdict } from "./judge";

export interface Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  TYPESAFE_API_KEY: string;
  LINKSCOUT_TOKEN: string;
  JINA_API_KEY?: string;
}

const MAX_URLS = 10;
/** Cap on client-supplied page content, before cleaning. */
const MAX_PAGE_CHARS = 50_000;

type SuppliedPages = Record<string, { title?: string; markdown?: string }>;
const CACHE_TTL_S = 60 * 60 * 24;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/score") return json({ error: "not found" }, 404);
    if (request.headers.get("Authorization") !== `Bearer ${env.LINKSCOUT_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }

    const { query, urls, pages = {} } = (await request.json()) as {
      query?: string;
      urls?: string[];
      pages?: SuppliedPages;
    };
    if (!query || !Array.isArray(urls) || urls.length === 0) {
      return json({ error: "body must be { query, urls[] }" }, 400);
    }

    const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    const cache = caches.default;

    const results = await Promise.all(
      urls.slice(0, MAX_URLS).map(async (url) => {
        // Cache per (query, url) so re-opening the same SERP is free.
        const key = new Request(
          `https://linkscout.cache/v5?q=${encodeURIComponent(query)}&u=${encodeURIComponent(url)}`,
        );
        const hit = await cache.match(key);
        if (hit) return (await hit.json()) as Verdict & { source: Source };

        try {
          const supplied = pages[url];
          const page =
            typeof supplied?.markdown === "string" && supplied.markdown.trim()
              ? { ...cleanMarkdown(supplied.markdown.slice(0, MAX_PAGE_CHARS), supplied.title), source: "page" as const }
              : await fetchPage(env, url);
          const verdict = {
            ...(await judgePage(client, query, url, page.title, page.markdown, toPassages(page.blocks))),
            source: page.source,
          };
          ctx.waitUntil(
            cache.put(key, new Response(JSON.stringify(verdict), {
              headers: { "Cache-Control": `max-age=${CACHE_TTL_S}` },
            })),
          );
          return verdict;
        } catch (err) {
          return { url, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    return json({ results });
  },
} satisfies ExportedHandler<Env>;
