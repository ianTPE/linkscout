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
      category: choice("What kind of page is `page.content`?", CATEGORIES),
      key_passage: passage.question,
    },
  });

  // Policy lives in code: tweak weights without re-running inference.
  const rel = answers.relevance.score / 4;
  const dep = answers.depth.score / 3;
  const composite = (0.65 * rel + 0.35 * dep) * (1 - 0.7 * answers.seo_spam.noul);

  return {
    url,
    score: Math.round(composite * 100),
    relevance: answers.relevance.score,
    depth: answers.depth.score,
    seoSpam: answers.seo_spam.noul,
    category: answers.category.choice as Category,
    categoryConfidence: answers.category.confidence,
    keyPassage: passage.pick(answers.key_passage.choice),
  };
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
