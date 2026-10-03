import { describe, expect, it } from "vitest";
import { judgeJob, triageJobs, TRIAGE_CUTOFF } from "../src/jobJudge";
import { fakeClient } from "./fakeClient";

type Opts = Partial<{
  rel: number; age: number; skills: number; interest: number; states: number; cond: number;
  remote: number; flexible: number; overtime: number; physical: number; young: number;
}>;

const answers = (o: Opts = {}) => ({
  relevance: { score: o.rel ?? 4 },
  age_friendly: { score: o.age ?? 3 },
  skills_fit: { score: o.skills ?? 4 },
  interest_fit: { score: o.interest ?? 4 },
  states_interest: { noul: o.states ?? 1 },
  conditions_fit: { score: o.cond ?? 3 },
  flag_remote: { noul: o.remote ?? 0 },
  flag_flexible: { noul: o.flexible ?? 0 },
  flag_overtime: { noul: o.overtime ?? 0 },
  flag_physical: { noul: o.physical ?? 0 },
  flag_young: { noul: o.young ?? 0 },
  key_passage: { choice: "none" },
});

const judge = (o: Opts, profile = "想做 AI 相關工作") => {
  const fake = fakeClient(answers(o));
  return judgeJob(fake.client, "行政", profile, "https://www.104.com.tw/job/x", "職稱｜公司", "content", []).then(
    (v) => ({ v, questions: Object.keys(fake.requests[0].questions) }),
  );
};

describe("judgeJob", () => {
  it("skips the fit questions without a profile", async () => {
    const { v, questions } = await judge({ rel: 4, age: 0 }, "");
    expect(questions).not.toContain("skills_fit");
    expect(v.skillsFit).toBeNull();
    // relevance 0.1 and age 0.15 are the only weights left: 0.1 / 0.25
    expect(v.score).toBe(40);
  });

  it("ignores interest_fit when the profile names no kind of work", async () => {
    const { v } = await judge({ interest: 0, states: 0.2 });
    expect(v.interestFit).toBeNull();
    expect(v.score).toBe(100);
  });

  it("puts any warning above the pluses", async () => {
    const { v } = await judge({ overtime: 0.9, remote: 0.95 });
    expect(v.flag).toEqual({ label: "⚠ 常加班／輪班", tone: "warn" });
  });

  it("shows 想做的工作 first among pluses", async () => {
    const { v } = await judge({ interest: 3, remote: 0.99 });
    expect(v.flag).toEqual({ label: "想做的工作", tone: "good" });
  });

  it("otherwise shows the strongest plus", async () => {
    const { v } = await judge({ interest: 1, skills: 2, cond: 1, age: 1, remote: 0.95, flexible: 0.7 });
    expect(v.flag?.label).toBe("可遠端");
  });
});

describe("triageJobs", () => {
  it("returns only the jobs below the cutoff", async () => {
    const { client, requests } = fakeClient({ j0: { noul: 0.9 }, j1: { noul: TRIAGE_CUTOFF - 0.01 } });
    const jobs = [
      { url: "a", title: "行政助理｜A", markdown: "| 地點 | 台北市 |" },
      { url: "b", title: "堆高機司機｜B", markdown: "" },
    ];
    const failed = await triageJobs(client, "profile", jobs);
    expect([...failed.keys()]).toEqual(["b"]);
    expect((requests[0].state as { jobs: Record<string, { location: string }> }).jobs.j0.location).toBe("台北市");
  });
});
