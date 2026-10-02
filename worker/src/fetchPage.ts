// Fetch a page as Markdown: Cloudflare Browser Run (Kitesurf) first, Jina Reader as fallback.
// Docs: https://developers.cloudflare.com/browser-run/kitesurf/ · https://jina.ai/reader/

export interface FetchEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  /** Optional; without it Jina uses the lower anonymous rate limit. */
  JINA_API_KEY?: string;
}

export type Source = "kitesurf" | "jina";

/** Below this, treat the result as a failed render (bot wall, empty shell, error page). */
const MIN_CONTENT_CHARS = 200;

export async function fetchMarkdown(
  env: FetchEnv,
  url: string,
): Promise<{ markdown: string; source: Source }> {
  const errors: string[] = [];
  for (const [source, fetcher] of [
    ["kitesurf", fetchViaKitesurf],
    ["jina", fetchViaJina],
  ] as const) {
    try {
      const markdown = await fetcher(env, url);
      if (markdown.trim().length >= MIN_CONTENT_CHARS) return { markdown, source };
      errors.push(`${source}: only ${markdown.trim().length} chars`);
    } catch (err) {
      errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Could not fetch ${url} (${errors.join("; ")})`);
}

async function fetchViaJina(env: FetchEnv, url: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Return-Format": "markdown",
  };
  if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;

  const res = await fetch(`https://r.jina.ai/${url}`, { headers });
  const body = (await res.json()) as { code?: number; data?: { content?: string }; readableMessage?: string };
  if (!res.ok || typeof body.data?.content !== "string") {
    throw new Error(`${res.status} ${body.readableMessage ?? ""}`.trim());
  }
  return body.data.content;
}

async function fetchViaKitesurf(env: FetchEnv, url: string): Promise<string> {
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
  return body.result;
}

/** Split Markdown into readable paragraph candidates for "show the key passage". */
export function toPassages(markdown: string, max = 40): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 80 && !/^[#!\[|>-]/.test(p)) // skip headings, images, link lists, tables
    .slice(0, max)
    .map((p) => (p.length > 600 ? `${p.slice(0, 600)}…` : p));
}
