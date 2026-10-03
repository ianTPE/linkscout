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

Search results (Google, Bing, DuckDuckGo, including their News tabs) are judged by `worker/src/judge.ts`, which asks Jev six independent questions in one `systemOne` request:

| Question | Type |
| --- | --- |
| relevance to the search | `Score` 0–4 |
| depth of the content | `Score` 0–3 |
| SEO filler / content farm | `Noul` |
| mainly a sales page | `Noul` |
| kind of page (docs, tutorial, Q&A, news, …) | `Choice` |
| key passage to show under the result | `Choice` over paragraphs that code has already split out ("select, don't generate") |

The 0–100 total is computed in code, so changing the weights doesn't require running the model again:

```
(0.65 · relevance + 0.35 · depth) × (1 − 0.7 · seo) × (1 − 0.5 · sales · (1 − transactional))
```

`transactional` is one `Noul` per search ("is this search about buying something?"), so sales pages aren't penalized on shopping searches. With reordering on, results are sorted by this score.

Job postings on 104.com.tw use `worker/src/jobJudge.ts` instead, which scores each job against the seeker's free-text profile from the options page: skills fit, the kind of work they want, working conditions (`Score`s), age-friendliness, relevance, and `Noul` flags for remote work, flexible hours, overtime, physical labor and a preference for young applicants. The badge shows the strongest warning, or else the strongest plus. Before that, one title-only request triages the whole batch, and jobs with a `Noul` below 0.15 skip full scoring; on 10 jobs that request costs about 1,500 tokens, against about 3,600 tokens per job for full scoring.

## Tests

```bash
npm test
```

The tests in `worker/test/` run the page cleaning and the scoring policy against a fake Jev client with canned answers, so they need no API key. CI runs them with the typecheck on every push.

## How this was built

Most of the code was written with Claude Code (Anthropic's coding agent), directed and tested by the author on real search pages.

## License

MIT — see [LICENSE](LICENSE).
