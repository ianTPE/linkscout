// Ask Jev (TypeSafe System One) to judge one page against the user's search query.
// Docs: https://docs.typesafe.ai/api.md

import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { toPlainText } from "./cleanMarkdown";

const CATEGORIES = {
  docs: "Official documentation, API reference, or specification",
  tutorial: "Step-by-step guide or how-to article",
  qa: "Forum thread or Q&A page (Stack Overflow, Reddit, discussions)",
  news: "News report or announcement",
  research: "Academic paper, study, or in-depth technical analysis",
  blog: "Personal blog post, opinion, or experience write-up",
  product: "Product, pricing, landing, or shopping page",
  other: "None of the above",
} as const;

export type Category = keyof typeof CATEGORIES;

export interface Verdict {
  url: string;
  /** 0–100, computed in code from the raw judgments below. */
  score: number;
  relevance: number; // 0–4
  depth: number; // 0–3
  seoSpam: number; // probability 0–1
  promotional: number; // probability 0–1 that the page is mainly selling something
  /** Probability that the search itself is to buy or find a product/service; sales pages aren't penalized then. */
  transactional: number;
  category: Category;
  categoryConfidence: number;
  keyPassage: string | null;
}

export async function judgePage(
  client: TypeSafeClient,
  query: string,
  url: string,
  title: string,
  markdown: string,
  passages: string[],
  transactional: number,
): Promise<Verdict> {
  const state = {
    search_query: query,
    page: { url, title, content: markdown.slice(0, 12_000) },
  };

  const passage = keyPassageQuestion(passages);

  // All questions are independent, so they go in one request and run in parallel.
  const { answers } = await client.systemOne({
    state,
    questions: {
      relevance: score("How well does `page.content` address what the user wants from `search_query`?", [
        "Unrelated to the query",
        "Mentions the topic but does not help with the query",
        "Partially answers the query; the user would need other sources",
        "Answers the query well",
        "Directly and thoroughly answers the query; the user could stop here",
      ]),
      depth: score("How much substantive, original information does `page.content` contain?", [
        "Almost none: boilerplate, navigation, ads, or a stub",
        "Thin: short or generic content restating common knowledge",
        "Solid: specific details, examples, or data",
        "Rich: expert-level detail, original data, or working code",
      ]),
      seo_spam: noul("Is `page.content` low-quality SEO filler, content-farm text, or mostly ads/affiliate links?"),
      promotional: noul(
        "Is `page.content` mainly a sales, product, pricing, or marketing page whose purpose is to sell something?",
      ),
      category: choice("What kind of page is `page.content`?", CATEGORIES),
      key_passage: passage.question,
    },
  });

  // Policy lives in code: tweak weights without re-running inference.
  const rel = answers.relevance.score / 4;
  const dep = answers.depth.score / 3;
  // Sales pages are what a shopping search wants, so the penalty fades as the search gets transactional.
  const promoPenalty = 0.5 * answers.promotional.noul * (1 - transactional);
  const composite = (0.65 * rel + 0.35 * dep) * (1 - 0.7 * answers.seo_spam.noul) * (1 - promoPenalty);

  return {
    url,
    score: Math.round(composite * 100),
    relevance: answers.relevance.score,
    depth: answers.depth.score,
    seoSpam: answers.seo_spam.noul,
    promotional: answers.promotional.noul,
    transactional,
    category: answers.category.choice as Category,
    categoryConfidence: answers.category.confidence,
    keyPassage: passage.pick(answers.key_passage.choice),
  };
}

/**
 * Once per search: is the user trying to buy something or find a product, service, or
 * local business (rather than learn about something)? State is the query alone.
 */
export async function searchIntent(client: TypeSafeClient, query: string): Promise<number> {
  const { answers } = await client.systemOne({
    state: { search_query: query },
    questions: {
      transactional: noul(
        "Is the goal of `search_query` to buy something, or to find a specific product, service, store, or local business to use, rather than to learn or research?",
        {
          true: "Shopping or local: e.g. 'buy nike pegasus 41', 'pizza delivery near me', 'iPhone 17 價格', '台北 牙醫 推薦 預約'",
          false: "Learning or research: e.g. 'how does MutationObserver work', 'best vpn comparison', 'MutationObserver 怎麼用'",
        },
      ),
    },
  });
  return answers.transactional.noul;
}

/**
 * The key passage shown in place of opening the page: a Choice over candidates found
 * in code ("select, don't generate"). Expects the page under `page.content` in state.
 */
export function keyPassageQuestion(passages: string[]) {
  const options: Record<string, string | null> = {
    none: "No passage has substantive content: only boilerplate, navigation, slogans, or contact details",
  };
  passages.forEach((p, i) => (options[`p${i}`] = p));

  return {
    // Broad filter-style searches ("jobs in Taipei") have no passage that "answers"
    // them, so fall back to the passage that best shows what the page offers.
    question: choice(
      {
        question:
          "Which passage from `page.content` should the user read to decide whether this page is worth opening for `search_query`?",
        preference: [
          "First choice: a passage that directly answers `search_query`.",
          "Otherwise: the passage that best describes what the page concretely offers (for a job posting, what the work involves; for an article, its main point).",
          "Avoid passages that are generic company introductions, slogans, or contact details.",
        ],
      },
      options,
    ),
    /** Plain-text passage for the chosen option, or null for "none". */
    pick: (chosen: string): string | null =>
      chosen === "none" || !options[chosen] ? null : toPlainText(options[chosen]),
  };
}
