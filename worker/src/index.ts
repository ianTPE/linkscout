// POST /score  { query, urls[], pages?, mode?, profile?, news? }  →  { results: (Verdict | JobVerdict | MonitorVerdict | ScreenedJob | { url, error })[] }
//
// `pages` lets the extension supply content it already has: from a site's own API, for
// sites that block Browser Run and Jina, or an article it fetched itself in fast mode
// (marked `via: "browser"`), which is far faster than either.
// `mode: "job"` scores job postings against the seeker's free-text `profile` instead;
// `mode: "monitor"` sorts news into report sections for the monitoring client in `profile`.

import { TypeSafeClient } from "@typesafe-ai/sdk";
import { cleanMarkdown, toPassages } from "./cleanMarkdown";
import { fetchPage, type Source } from "./fetchPage";
import { judgeJob, screenedVerdict, triageJobs } from "./jobJudge";
import { judgePage, searchIntent } from "./judge";
import { judgeMonitor } from "./monitorJudge";

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

const MAX_PROFILE_CHARS = 2_000;

type SuppliedPages = Record<string, { title?: string; markdown?: string; via?: string }>;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
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

    const { query, urls, pages = {}, mode, profile: rawProfile, news: rawNews } = (await request.json()) as {
      query?: string;
      urls?: string[];
      pages?: SuppliedPages;
      mode?: string;
      profile?: string;
      /** The results come from a news search (Google/Bing/DuckDuckGo News tab). */
      news?: boolean;
    };
    const news = rawNews === true;
    const jobMode = mode === "job";
    const profileMode = jobMode || mode === "monitor";
    const profile = profileMode && typeof rawProfile === "string" ? rawProfile.trim().slice(0, MAX_PROFILE_CHARS) : "";
    if (!query || !Array.isArray(urls) || urls.length === 0) {
      return json({ error: "body must be { query, urls[] }" }, 400);
    }
    // Monitoring is judged against the client, so it can't run without one.
    const monitorMode = mode === "monitor" && profile.length > 0;
    // Different profiles score the same page differently, so the profile is part of the cache key.
    // News searches ask a different question in page mode, so they cache separately.
    const variant = jobMode || monitorMode ? `${mode}:${(await sha256(profile)).slice(0, 16)}` : news ? "page-news" : "page";

    const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    const cache = caches.default;

    // Page mode: judge the search's intent once, before the per-page calls that depend on it.
    let transactional = 0;
    if (!jobMode && !monitorMode) {
      const intentKey = new Request(`https://linkscout.cache/intent/v1?q=${encodeURIComponent(query)}`);
      const hit = await cache.match(intentKey);
      if (hit) {
        transactional = Number(await hit.text());
      } else {
        try {
          transactional = await searchIntent(client, query);
          ctx.waitUntil(
            cache.put(intentKey, new Response(String(transactional), {
              headers: { "Cache-Control": `max-age=${CACHE_TTL_S}` },
            })),
          );
        } catch {
          // Unknown intent: treat as research, i.e. keep penalizing sales pages.
        }
      }
    }

    const todo = urls.slice(0, MAX_URLS);
    // Cache per (mode/profile, query, url) so re-opening the same results page is free.
    const keyFor = (url: string) =>
      new Request(`https://linkscout.cache/v15?m=${variant}&q=${encodeURIComponent(query)}&u=${encodeURIComponent(url)}`);
    const save = <T>(url: string, verdict: T): T => {
      ctx.waitUntil(
        cache.put(keyFor(url), new Response(JSON.stringify(verdict), {
          headers: { "Cache-Control": `max-age=${CACHE_TTL_S}` },
        })),
      );
      return verdict;
    };

    // Cached verdicts first, so triage and scoring only touch the rest.
    const cached = new Map<string, unknown>();
    await Promise.all(
      todo.map(async (url) => {
        const hit = await cache.match(keyFor(url));
        if (hit) cached.set(url, await hit.json());
      }),
    );

    // Job mode with a profile: one cheap title-only request screens out clear mismatches
    // before the per-job scoring. Without a profile there is nothing to screen against.
    let screened = new Map<string, number>();
    if (jobMode && profile) {
      const candidates = todo
        .filter((url) => !cached.has(url) && pages[url]?.title && pages[url]?.markdown)
        .map((url) => ({ url, title: pages[url].title!, markdown: pages[url].markdown! }));
      if (candidates.length >= 2) {
        try {
          screened = await triageJobs(client, profile, candidates);
        } catch {
          // Triage is only an optimization: on failure, score everything.
        }
      }
    }

    const results = await Promise.all(
      todo.map(async (url) => {
        if (cached.has(url)) return cached.get(url);
        if (screened.has(url)) return save(url, { ...screenedVerdict(url, screened.get(url)!), source: "page" as Source });

        try {
          const supplied = pages[url];
          const page =
            typeof supplied?.markdown === "string" && supplied.markdown.trim()
              ? {
                  ...cleanMarkdown(supplied.markdown.slice(0, MAX_PAGE_CHARS), supplied.title),
                  source: (supplied.via === "browser" ? "browser" : "page") as Source,
                }
              : await fetchPage(env, url);
          const passages = toPassages(page.blocks);
          const judged = jobMode
            ? await judgeJob(client, query, profile, url, page.title, page.markdown, passages)
            : monitorMode
              ? await judgeMonitor(client, query, profile, url, page.title, page.markdown, passages)
              : await judgePage(client, query, url, page.title, page.markdown, passages, transactional, news);
          return save(url, { ...judged, source: page.source });
        } catch (err) {
          return { url, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    return json({ results });
  },
} satisfies ExportedHandler<Env>;
