// Judge a job posting for one job seeker: whether they can do it (skills), whether it's
// the kind of work they want (interest), working conditions, friendliness to middle-aged
// applicants, and search relevance, plus yes/no flags for the badge.
// Used for job sites (104) instead of judgePage.
// Docs: https://docs.typesafe.ai/api.md

import { noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { keyPassageQuestion } from "./judge";

/** Share of the total score per dimension (normalized 0–1 each). Only answered ones count. */
const WEIGHTS = { skills: 0.3, interest: 0.25, conditions: 0.2, ageFriendly: 0.15, relevance: 0.1 };

/** A flag shows on the badge once its probability reaches this. */
const FLAG_THRESHOLD = 0.6;

export interface JobFlag {
  label: string;
  tone: "good" | "warn";
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
    flags,
    flag: pickFlag(flags, answers.age_friendly.score, fit),
    keyPassage: passage.pick(answers.key_passage.choice),
  };
}

/** Warnings outrank pluses; within each group the strongest signal wins. */
function pickFlag(
  flags: Record<keyof typeof WARNINGS | "remote" | "flexible", number>,
  ageFriendly: number,
  fit: { skills: number; interest: number | null; conditions: number } | null,
): JobFlag | null {
  const strongest = (cands: [string, number][]) =>
    cands.filter(([, v]) => v >= FLAG_THRESHOLD).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const warn = strongest(Object.entries(WARNINGS).map(([k, label]) => [label, flags[k as keyof typeof WARNINGS]]));
  if (warn) return { label: warn, tone: "warn" };

  // Scores mapped to 0–1 so they compete with flag probabilities on one scale.
  const plus = strongest([
    ...(fit
      ? ([
          ["想做的工作", fit.interest == null ? 0 : (fit.interest - 2) / 2],
          ["能力吻合", (fit.skills - 2) / 2],
          ["條件符合", (fit.conditions - 1.5) / 1.5],
        ] as [string, number][])
      : []),
    ["中高齡友善", (ageFriendly - 1.5) / 1.5],
    ["可遠端", flags.remote],
    ["時間彈性", flags.flexible],
  ]);
  return plus ? { label: plus, tone: "good" } : null;
}
