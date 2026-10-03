# linkscout

Scores the links on a search results page before you click them.

```
Search page (extension)  ──urls+query──▶  Worker /score
                                            ├─ Cloudflare Browser Run (Kitesurf) → Markdown
                                            │    └─ if that fails or returns < 200 chars → Jina Reader
                                            └─ Jev (TypeSafe) → relevance / depth / SEO spam / category / key passage
         ◀──── badge + key passage ────────┘
```

## Layout

| Path | What it is |
| --- | --- |
| `extension/` | MV3 extension (plain JS). Watches Google / Bing / DuckDuckGo results, including ones that load later, and sends them to the Worker |
| `worker/` | Cloudflare Worker. `POST /score { query, urls[] }`; results are cached for 24h per (query, url) |

## Getting started

1. **Worker**
   ```sh
   npm install
   # Put keys in the root .env: CF_ACCOUNT_ID, CF_API_TOKEN (or CF_API_KEY),
   # TYPESAFE_API_KEY, and optionally JINA_API_KEY
   npm run dev        # syncs .env → worker/.dev.vars first, then http://localhost:8787
   ```
   `npm run env:sync` regenerates `worker/.dev.vars` on its own. Only the keys listed in `worker/.dev.vars.example` are copied; to sync a new key, add it there.
   `CF_API_TOKEN` needs the **Browser Rendering - Edit** permission. `JINA_API_KEY` is optional: without it the Jina fallback still works, just with a lower rate limit.

2. **Test it on its own**
   ```sh
   curl -X POST localhost:8787/score -H 'Authorization: Bearer dev-token' \
     -H 'Content-Type: application/json' \
     -d '{"query":"rust async trait","urls":["https://blog.rust-lang.org/2023/12/21/async-fn-rpit-in-traits.html"]}'
   ```

3. **Extension**: open `chrome://extensions`, turn on Developer mode, choose "Load unpacked", and select `extension/`. It defaults to localhost:8787 with the token `dev-token`; you can change these in the options page.

4. **Deploy**
   ```sh
   cd worker
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret bulk secrets.json   # then delete secrets.json
   ```
   `secrets.json` holds the same five keys as `worker/.dev.vars.example` (`CF_ACCOUNT_ID`, `CF_API_TOKEN`,
   `TYPESAFE_API_KEY`, `JINA_API_KEY`, `LINKSCOUT_TOKEN`). In production, `LINKSCOUT_TOKEN` must be a random
   value (e.g. `openssl rand -hex 32`), not `dev-token`: the workers.dev URL is public, and this token is all
   that stops strangers from spending your Browser Run / Jev / Jina quota. Keep it in `.env` as
   `LINKSCOUT_PROD_TOKEN` so `env:sync` doesn't copy it into local dev.

   Then put the workers.dev URL and that token into the extension's options page.

## Scoring

`worker/src/judge.ts` asks Jev five independent questions in one request: relevance (Score 0–4), depth (Score 0–3), SEO filler (Noul), category (Choice), and key passage (a Choice over paragraphs that code has already split out). The 0–100 total is computed in code, so changing the weights doesn't require running the model again.

## License

MIT — see [LICENSE](LICENSE).
