import { describe, expect, it } from "vitest";
import { judgePage } from "../src/judge";
import { fakeClient } from "./fakeClient";

const answers = (o: { rel?: number; dep?: number; seo?: number; promo?: number; passage?: string } = {}) => ({
  relevance: { score: o.rel ?? 4, confidence: 0.9 },
  depth: { score: o.dep ?? 3, confidence: 0.9 },
  seo_spam: { noul: o.seo ?? 0 },
  promotional: { noul: o.promo ?? 0 },
  category: { choice: "docs", confidence: 0.8 },
  key_passage: { choice: o.passage ?? "none", confidence: 0.7 },
});

const judge = (a: ReturnType<typeof answers>, transactional = 0, passages: string[] = []) =>
  judgePage(fakeClient(a).client, "query", "https://example.com", "Title", "content", passages, transactional);

describe("judgePage", () => {
  it("asks all questions in one request", async () => {
    const { client, requests } = fakeClient(answers());
    await judgePage(client, "q", "https://example.com", "T", "c", [], 0);
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions).sort()).toEqual(
      ["category", "depth", "key_passage", "promotional", "relevance", "seo_spam"],
    );
  });

  it("asks the news type instead of the category on news searches", async () => {
    const a = { ...answers(), news_type: { choice: "sponsored", confidence: 0.85 } };
    const { client, requests } = fakeClient(a);
    const v = await judgePage(client, "q", "https://example.com", "T", "c", [], 0, true);
    expect(Object.keys(requests[0].questions)).toContain("news_type");
    expect(Object.keys(requests[0].questions)).not.toContain("category");
    expect(v).toMatchObject({ category: "news", newsType: "sponsored", categoryConfidence: 0.85 });
  });

  it("weights relevance 0.65 and depth 0.35", async () => {
    expect((await judge(answers())).score).toBe(100);
    expect((await judge(answers({ rel: 4, dep: 0 }))).score).toBe(65);
    expect((await judge(answers({ rel: 0, dep: 3 }))).score).toBe(35);
  });

  it("cuts SEO filler by up to 70%", async () => {
    expect((await judge(answers({ seo: 1 }))).score).toBe(30);
  });

  it("halves sales pages on research searches but not on shopping searches", async () => {
    expect((await judge(answers({ promo: 1 }), 0)).score).toBe(50);
    expect((await judge(answers({ promo: 1 }), 1)).score).toBe(100);
  });

  it("returns the chosen passage as plain text, or null for none", async () => {
    const passages = ["First **para**", "See [the docs](https://x.y)"];
    expect((await judge(answers({ passage: "p1" }), 0, passages)).keyPassage).toBe("See the docs");
    expect((await judge(answers({ passage: "none" }), 0, passages)).keyPassage).toBeNull();
  });
});
