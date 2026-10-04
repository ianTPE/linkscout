import { describe, expect, it } from "vitest";
import { judgeMonitor, monitorScore, normalizeExamples } from "../src/monitorJudge";
import { fakeClient } from "./fakeClient";

const answers = (o: { section?: string; confidence?: number; importance?: number; prominence?: number } = {}) => ({
  section: { choice: o.section ?? "exposure", confidence: o.confidence ?? 0.9 },
  tone: { choice: "negative", confidence: 0.8 },
  topic: { choice: "legal", confidence: 0.7 },
  news_type: { choice: "press_release", confidence: 0.8 },
  prominence: { score: o.prominence ?? 3 },
  importance: { score: o.importance ?? 3 },
  key_passage: { choice: "none" },
});

describe("monitorScore", () => {
  it("ranks every exposure article above every industry article", () => {
    expect(monitorScore("exposure", 0, 0)).toBe(40);
    expect(monitorScore("industry", 3, 3)).toBe(80);
    expect(monitorScore("exposure", 3, 3)).toBe(100);
  });

  it("ranks an uncertain exclusion like industry news", () => {
    expect(monitorScore("stock", 3, 3, true)).toBe(80);
  });

  it("keeps excluded articles at the bottom", () => {
    expect(monitorScore("stock", 3, 3)).toBe(10);
    expect(monitorScore("unrelated", 0, 0)).toBe(0);
    expect(monitorScore("industry", 0, 0)).toBe(20);
  });
});

describe("judgeMonitor", () => {
  it("asks all questions in one request, with the client in state", async () => {
    const { client, requests } = fakeClient(answers());
    await judgeMonitor(client, "台積電", "客戶：台積電", "https://example.com", "T", "c", []);
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions).sort()).toEqual(
      ["importance", "key_passage", "news_type", "prominence", "section", "tone", "topic"],
    );
    expect((requests[0].state as { monitoring_client: string }).monitoring_client).toBe("客戶：台積電");
    expect(requests[0].state).not.toHaveProperty("monitoring_examples");
  });

  it("puts the report's example headlines in state when given", async () => {
    const { client, requests } = fakeClient(answers());
    const examples = { include: ["台積電跌停"], exclude: ["台股盤後：加權指數漲 100 點"] };
    await judgeMonitor(client, "台積電", "客戶：台積電", "https://example.com", "T", "c", [], examples);
    expect(requests[0].state).toMatchObject({ monitoring_examples: examples });
  });

  it("returns the section, tone and topic with the computed score", async () => {
    const { client } = fakeClient(answers({ section: "stock", importance: 1.5 }));
    const v = await judgeMonitor(client, "q", "p", "https://example.com", "T", "c", []);
    expect(v).toMatchObject({
      kind: "monitor",
      section: "stock",
      tone: "negative",
      topic: "legal",
      newsType: "press_release",
      score: 5,
    });
  });

  it("marks a low-confidence exclusion as uncertain instead of hiding it", async () => {
    const { client } = fakeClient(answers({ section: "stock", confidence: 0.39, importance: 1.5 }));
    const v = await judgeMonitor(client, "q", "p", "https://example.com", "T", "c", []);
    expect(v).toMatchObject({ uncertain: true, score: 50 });
  });
});

describe("normalizeExamples", () => {
  it("keeps up to five trimmed, non-empty strings per list", () => {
    const many = ["a", " b ", "", "c", "d", "e", "f"];
    expect(normalizeExamples({ include: many, exclude: [1, "x"] })).toEqual({
      include: ["a", "b", "c", "d", "e"],
      exclude: ["x"],
    });
  });

  it("returns null when there is nothing usable", () => {
    expect(normalizeExamples(undefined)).toBeNull();
    expect(normalizeExamples({ include: [" "], exclude: "x" })).toBeNull();
  });
});
