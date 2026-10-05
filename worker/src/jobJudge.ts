// Judge a job posting for one job seeker: whether they can do it (skills), whether it's
// the kind of work they want (interest), working conditions, friendliness to middle-aged
// applicants, and search relevance, plus yes/no flags for the badge, and how much of the
// work AI tools can speed up (shown on its own badge, not scored).
// Used for job sites (104) instead of judgePage.
// Docs: https://docs.typesafe.ai/api.md

import { noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { keyPassageQuestion } from "./judge";

/** Share of the total score per dimension (normalized 0–1 each). Only answered ones count. */
const WEIGHTS = { skills: 0.3, interest: 0.25, conditions: 0.2, ageFriendly: 0.15, relevance: 0.1 };

/** A flag shows on the badge once its probability reaches this. */
const FLAG_THRESHOLD = 0.6;
/** interest_fit level 3 = "Mostly the kind of work the seeker wants": enough for the badge. */
const INTEREST_BADGE_MIN = 3;

export interface JobFlag {
  /** Stable id, for the extension to show in its own UI language. */
  key: FlagKey;
  /** Traditional Chinese label, kept for older extension versions. */
  label: string;
  tone: "good" | "warn" | "muted";
}

export interface JobVerdict {
  url: string;
  kind: "job";
  /** 0–100, computed in code from the raw judgments below. */
  score: number;
  relevance: number; // 0–4
  skillsFit: number | null; // 0–4, null without a profile
  interestFit: number | null; // 0–4, null without a profile or if it names no kind of work
  conditionsFit: number | null; // 0–3, null without a profile
  ageFriendly: number; // 0–3
  /** 0–3: how much of the day-to-day work AI tools can do or speed up. Shown, not scored. */
  aiLeverage: number;
  flags: Record<string, number>; // probability 0–1 per flag
  /** The one flag to show on the badge: the strongest warning, else the strongest plus. */
  flag: JobFlag | null;
  keyPassage: string | null;
}

const WARNINGS = {
  overtime: "⚠ 常加班／輪班",
  physical: "⚠ 體力負荷重",
  young: "⚠ 偏好年輕人",
} as const;

const PLUSES = {
  interest: "想做的工作",
  skills: "能力吻合",
  conditions: "條件符合",
  ageFriendly: "中高齡友善",
  remote: "可遠端",
  flexible: "時間彈性",
  screened: "初篩略過",
} as const;

const FLAG_LABELS = { ...WARNINGS, ...PLUSES };
export type FlagKey = keyof typeof FLAG_LABELS;
const flag = (key: FlagKey, tone: JobFlag["tone"]): JobFlag => ({ key, label: FLAG_LABELS[key], tone });

export async function judgeJob(
  client: TypeSafeClient,
  query: string,
  profile: string,
  url: string,
  title: string,
  markdown: string,
  passages: string[],
): Promise<JobVerdict> {
  const hasProfile = profile.trim().length > 0;
  const state = {
    search_query: query,
    ...(hasProfile ? { job_seeker: profile.trim() } : {}),
    page: { url, title, content: markdown.slice(0, 12_000) },
  };
  const passage = keyPassageQuestion(passages);

  // Without a profile, the fit questions have nothing to compare against; skip them.
  // Ability (skills_fit) and wishes (interest_fit) are separate questions: mixed into one,
  // "wants AI work" made the seeker look less able to do admin jobs they're qualified for.
  const fitQuestions = {
    skills_fit: score(
      {
        question:
          "How well do the experience and skills described in `job_seeker` meet the requirements and duties of the job posting in `page.content`?",
        note: "Judge ability only: could this person do the job well? Ignore whether they want this kind of work.",
      },
      [
        "Unsuited: requires skills or experience the seeker clearly lacks",
        "Weak fit: some overlap, but major requirements are missing",
        "Possible fit: the seeker meets some key requirements",
        "Good fit: the seeker meets most requirements",
        "Excellent fit: the seeker's experience and skills closely match the requirements",
      ],
    ),
    interest_fit: score(
      {
        question:
          "How well does the kind of work in the job posting in `page.content` match the kind of work `job_seeker` says they want to do?",
        note: "Judge only the seeker's stated wishes about the type of work, role, or field. Ignore their skills, location, hours, and pay.",
      },
      [
        "Opposite of what the seeker wants, or a kind of work they want to avoid",
        "Not the kind of work the seeker asked for",
        "Partly: some of the duties are the kind of work the seeker wants",
        "Mostly the kind of work the seeker wants",
        "Exactly the kind of work the seeker wants",
      ],
    ),
    // About the profile alone: without a stated wish, interest_fit has nothing to judge.
    states_interest: noul(
      "Does `job_seeker` say what kind of work, role, or field they want to do (not just their past experience or working conditions)?",
    ),
    conditions_fit: score(
      {
        question:
          "How well do the working conditions of the job posting in `page.content` match the preferences stated in `job_seeker`?",
        conditions: "Location and commute, remote work, working hours and shifts, overtime, business travel.",
        note: "Judge only conditions the seeker mentions; a condition the seeker doesn't mention is neither a match nor a conflict.",
      },
      [
        "Conflicts with a stated preference (e.g. night shifts when the seeker wants day work, or the wrong city)",
        "Partly matches; some stated preferences are unmet or unclear",
        "Mostly matches the stated preferences",
        "Matches all stated preferences",
      ],
    ),
  };

  // All questions are independent, so they go in one request and run in parallel.
  const { answers } = await client.systemOne({
    state,
    questions: {
      ...(hasProfile ? fitQuestions : {}),
      relevance: score("How well does the job posting in `page.content` match what the user searched for in `search_query`?", [
        "Unrelated to the search",
        "Loosely related",
        "Matches part of the search",
        "Matches the search well",
        "Exactly what the search describes",
      ]),
      age_friendly: score(
        "How welcoming is the job posting in `page.content` to middle-aged and older applicants (45 and over)?",
        [
          "Excludes them in effect: age limits, wants a 'young team' or only fresh graduates, or heavy physical work",
          "Leans toward younger applicants, or is physically demanding",
          "Neutral: no signals either way",
          "Welcoming: explicitly accepts middle-aged, older, or second-career (二度就業) applicants, or values long experience",
        ],
      ),
      ai_leverage: score(
        {
          question:
            "How much of the day-to-day work in the job in `page.content` could someone do much faster or better with AI tools?",
          note: "AI tools here: chat assistants for drafting, summarizing, translating, searching, sorting information, data entry, spreadsheets, and routine monitoring or reporting. Physical, on-site, or face-to-face work gains little.",
        },
        [
          "Little: mostly physical, on-site, or face-to-face work",
          "Some: a few tasks such as emails or simple records",
          "Much: a large share is writing, information, or data work AI can help with",
          "Most: the core work is the kind AI tools do well, such as drafting, summarizing, research, data processing, or monitoring",
        ],
      ),
      flag_remote: noul("Does the job posting in `page.content` offer remote or hybrid work?"),
      flag_flexible: noul("Does the job posting in `page.content` offer flexible working hours or a flexible schedule?"),
      flag_overtime: noul(
        "Does the job posting in `page.content` indicate frequent overtime, long hours, night shifts, or rotating shifts?",
      ),
      flag_physical: noul(
        "Does the job in `page.content` involve heavy physical labor, such as lifting heavy items or standing for long periods?",
      ),
      flag_young: noul(
        "Does the job posting in `page.content` signal a preference for young applicants, e.g. 'young team', age limits, or 'fresh graduates only'?",
      ),
      key_passage: passage.question,
    },
  });

  const fit = hasProfile
    ? {
        skills: answers.skills_fit!.score,
        interest: answers.states_interest!.noul >= 0.5 ? answers.interest_fit!.score : null,
        conditions: answers.conditions_fit!.score,
      }
    : null;

  // Policy lives in code: tweak weights and thresholds without re-running inference.
  const parts: [number, number][] = [
    [WEIGHTS.relevance, answers.relevance.score / 4],
    [WEIGHTS.ageFriendly, answers.age_friendly.score / 3],
  ];
  if (fit) {
    parts.push([WEIGHTS.skills, fit.skills / 4], [WEIGHTS.conditions, fit.conditions / 3]);
    if (fit.interest != null) parts.push([WEIGHTS.interest, fit.interest / 4]);
  }
  const totalWeight = parts.reduce((n, [w]) => n + w, 0);
  const composite = parts.reduce((n, [w, v]) => n + w * v, 0) / totalWeight;

  const flags = {
    remote: answers.flag_remote.noul,
    flexible: answers.flag_flexible.noul,
    overtime: answers.flag_overtime.noul,
    physical: answers.flag_physical.noul,
    young: answers.flag_young.noul,
  };

  return {
    url,
    kind: "job",
    score: Math.round(composite * 100),
    relevance: answers.relevance.score,
    skillsFit: fit?.skills ?? null,
    interestFit: fit?.interest ?? null,
    conditionsFit: fit?.conditions ?? null,
    ageFriendly: answers.age_friendly.score,
    aiLeverage: answers.ai_leverage.score,
    flags,
    flag: pickFlag(flags, answers.age_friendly.score, fit),
    keyPassage: passage.pick(answers.key_passage.choice),
  };
}

/**
 * Warnings outrank pluses. Among pluses, "the kind of work you want" always shows when it
 * qualifies; otherwise the strongest signal wins.
 */
function pickFlag(
  flags: Record<keyof typeof WARNINGS | "remote" | "flexible", number>,
  ageFriendly: number,
  fit: { skills: number; interest: number | null; conditions: number } | null,
): JobFlag | null {
  const strongest = (cands: [FlagKey, number][]) =>
    cands.filter(([, v]) => v >= FLAG_THRESHOLD).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const warn = strongest((Object.keys(WARNINGS) as (keyof typeof WARNINGS)[]).map((k) => [k, flags[k]]));
  if (warn) return flag(warn, "warn");

  // Scores mapped to 0–1 so they compete with flag probabilities on one scale.
  if (fit?.interest != null && fit.interest >= INTEREST_BADGE_MIN) return flag("interest", "good");

  const plus = strongest([
    ...(fit
      ? ([
          ["skills", (fit.skills - 2) / 2],
          ["conditions", (fit.conditions - 1.5) / 1.5],
        ] as [FlagKey, number][])
      : []),
    ["ageFriendly", (ageFriendly - 1.5) / 1.5],
    ["remote", flags.remote],
    ["flexible", flags.flexible],
  ]);
  return plus ? flag(plus, "good") : null;
}

// ---------------------------------------------------------------------------
// Title-only triage: one request screens a whole batch before full scoring.
// Measured on 10 jobs: ~1,500 tokens for the batch vs ~3,600 per job for full
// scoring; the clear mismatches it drops save roughly a quarter of the tokens.
// ---------------------------------------------------------------------------

/** Jobs below this probability of plausibly suiting the seeker skip full scoring. Kept low: a wrong skip hides a real match. */
export const TRIAGE_CUTOFF = 0.15;

export interface ScreenedJob {
  url: string;
  kind: "job";
  screened: true;
  /** Probability from triage that the job could suit the seeker. */
  plausible: number;
  score: number;
  flag: JobFlag;
  keyPassage: null;
}

/** Returns url → probability for the jobs that fail triage; jobs that pass are absent. */
export async function triageJobs(
  client: TypeSafeClient,
  profile: string,
  jobs: { url: string; title: string; markdown: string }[],
): Promise<Map<string, number>> {
  const facts = Object.fromEntries(
    jobs.map((j, i) => [
      `j${i}`,
      {
        // 104 titles are "職稱｜公司"; location comes from the job's fact table.
        title: j.title,
        location: j.markdown.match(/^\| 地點 \| (.*) \|$/m)?.[1] ?? "",
      },
    ]),
  );
  const { answers } = await client.systemOne({
    state: { job_seeker: profile, jobs: facts },
    questions: Object.fromEntries(
      jobs.map((_, i) => [
        `j${i}`,
        noul(
          `Could the job \`jobs.j${i}\` plausibly suit \`job_seeker\`, judging only from its title, company, and location? Answer yes unless it is clearly unsuitable.`,
        ),
      ]),
    ),
  });

  const failed = new Map<string, number>();
  jobs.forEach((j, i) => {
    const p = answers[`j${i}`].noul;
    if (p < TRIAGE_CUTOFF) failed.set(j.url, p);
  });
  return failed;
}

export function screenedVerdict(url: string, plausible: number): ScreenedJob {
  return {
    url,
    kind: "job",
    screened: true,
    plausible,
    score: Math.round(plausible * 100),
    flag: flag("screened", "muted"),
    keyPassage: null,
  };
}
