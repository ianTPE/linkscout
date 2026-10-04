// Judge a news article for a media-monitoring client: does it belong in the report's
// "news exposure" section (coverage of the client) or its "industry news" section, or is
// it stock-market news (not monitored) or unrelated? Plus tone toward the client, topic,
// how central the client is, and importance, for sorting and the badge.
// Used on search pages when monitoring mode is on, instead of judgePage.
// Docs: https://docs.typesafe.ai/api.md

import { choice, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { keyPassageQuestion, newsTypeQuestion, type NewsType } from "./judge";

export const SECTIONS = {
  exposure:
    "News exposure: the article is about the client company itself (not a namesake) or substantively covers its business, products, people, or events, including an article mainly about the client's own stock (its price, trading, buybacks, or exchange actions on it)",
  industry:
    "Industry news: not substantively about the client, but about its industry, market, supply chain, customers, competitors, regulation, or technology in a way that matters to the client",
  stock:
    "Stock-market news: market moves or other companies' shares, or a roundup of many stocks' prices, trading, institutional buying or selling, margin trading, ETF holdings, or price targets in which the client is one name among many",
  unrelated: "Unrelated: none of the above",
} as const;
export type Section = keyof typeof SECTIONS;

export const TOPICS = {
  operations: "Operations and financial results: revenue, profit, guidance (not share prices)",
  product: "Products and technology",
  investment: "Investment, expansion, new plants, mergers and acquisitions",
  partnership: "Partnerships, customers, and suppliers",
  people: "People and corporate governance: executives, board, shareholders' meetings",
  legal: "Legal: lawsuits, disputes, investigations, regulatory penalties",
  policy: "Government policy and industry regulation",
  market: "Market and industry trends",
  competitor: "A competitor's moves",
  esg: "ESG: environment, labor, social responsibility",
  brand: "Brand, marketing, events, and charity",
  other: "Other",
} as const;
export type Topic = keyof typeof TOPICS;

const TONES = {
  positive: "Positive toward the client",
  neutral: "Neutral or factual",
  negative: "Negative toward the client: criticism, problems, risks, losses, disputes",
} as const;
export type Tone = keyof typeof TONES;

export interface MonitorVerdict {
  url: string;
  kind: "monitor";
  /** 0–100, computed in code: how much the article belongs in the report, for sorting. */
  score: number;
  section: Section;
  sectionConfidence: number;
  /**
   * Excluded (stock or unrelated) but with low confidence: shown and ranked like industry
   * news for a human to check, since a wrongly hidden article is worse than an extra one.
   */
  uncertain: boolean;
  /** Only meaningful for the exposure section. */
  tone: Tone;
  topic: Topic;
  newsType: NewsType;
  prominence: number; // 0–3: how central the client is
  importance: number; // 0–3
  keyPassage: string | null;
}

/** Headlines the user's report did and did not include, as few-shot guidance for the section. */
// A type alias, not an interface, so it fits the SDK's JSON state type.
export type MonitorExamples = {
  include: string[];
  exclude: string[];
};

const MAX_EXAMPLES = 5;
const MAX_EXAMPLE_CHARS = 200;

/** Keeps up to five non-empty headlines per list from untrusted input; null when both are empty. */
export function normalizeExamples(raw: unknown): MonitorExamples | null {
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().slice(0, MAX_EXAMPLE_CHARS))
      .filter(Boolean)
      .slice(0, MAX_EXAMPLES);
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const examples = { include: list(r.include), exclude: list(r.exclude) };
  return examples.include.length || examples.exclude.length ? examples : null;
}

/** Below this confidence, an article judged out of the report still shows, marked for checking. */
export const UNCERTAIN_BELOW = 0.5;

/**
 * Report sections first: exposure ranks above industry news; excluded articles sink to the
 * bottom, unless the exclusion is uncertain (then they rank like industry news).
 */
export function monitorScore(section: Section, importance: number, prominence: number, uncertain = false): number {
  const imp = importance / 3;
  const prom = prominence / 3;
  const v =
    section === "exposure" ? 0.4 + 0.6 * (0.6 * imp + 0.4 * prom)
    : section === "industry" || uncertain ? 0.2 + 0.6 * imp
    : 0.1 * imp;
  return Math.round(v * 100);
}

export async function judgeMonitor(
  client: TypeSafeClient,
  query: string,
  profile: string,
  url: string,
  title: string,
  markdown: string,
  passages: string[],
  examples: MonitorExamples | null = null,
): Promise<MonitorVerdict> {
  const state = {
    search_query: query,
    monitoring_client: profile.trim(),
    ...(examples ? { monitoring_examples: examples } : {}),
    page: { url, title, content: markdown.slice(0, 12_000) },
  };
  const passage = keyPassageQuestion(passages);

  // All questions are independent, so they go in one request and run in parallel.
  const { answers } = await client.systemOne({
    state,
    questions: {
      section: choice(
        {
          question:
            "For a media-monitoring report on the company described in `monitoring_client`, which section does the article in `page.content` belong to?",
          note:
            "The client's own stock counts as the client: an article mainly about its share price, trading, buybacks, dividends, investor conferences, or a limit-down or trading halt is news exposure. Market roundups that only list the client among many stocks are stock-market news. If `monitoring_examples` is given, it lists headlines this report did and did not include: it shows the report's own standard, so where it differs from the guidance above, follow the examples.",
        },
        SECTIONS,
      ),
      tone: choice("How does the article in `page.content` portray the company in `monitoring_client`?", TONES),
      topic: choice("What is the main topic of the article in `page.content`?", TOPICS),
      news_type: newsTypeQuestion(),
      prominence: score(
        "How central is the company in `monitoring_client` to the article in `page.content`?",
        [
          "Not mentioned",
          "Passing mention, e.g. one name in a list",
          "One of several main subjects",
          "The main subject",
        ],
      ),
      importance: score(
        {
          question:
            "How important is the article in `page.content` for the management and PR team of the company in `monitoring_client` to know about?",
          note:
            "Judge importance to the company's business and reputation. Routine share-price moves are routine; an unusual event in its own stock, such as a limit-down, a trading halt, or a large buyback, can be notable or major.",
        },
        [
          "Routine: nothing they need to know",
          "Minor: background information",
          "Notable: worth reading",
          "Major: could materially affect the company's reputation or business; needs attention",
        ],
      ),
      key_passage: passage.question,
    },
  });

  const section = answers.section.choice as Section;
  const uncertain = (section === "stock" || section === "unrelated") && answers.section.confidence < UNCERTAIN_BELOW;
  return {
    url,
    kind: "monitor",
    score: monitorScore(section, answers.importance.score, answers.prominence.score, uncertain),
    section,
    sectionConfidence: answers.section.confidence,
    uncertain,
    tone: answers.tone.choice as Tone,
    topic: answers.topic.choice as Topic,
    newsType: answers.news_type.choice as NewsType,
    prominence: answers.prominence.score,
    importance: answers.importance.score,
    keyPassage: passage.pick(answers.key_passage.choice),
  };
}
