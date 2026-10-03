import type { TypeSafeClient } from "@typesafe-ai/sdk";

/**
 * Stands in for the TypeSafe client: records each systemOne request and answers it with
 * canned answers, so the scoring policy in code can be tested without calling Jev.
 */
export function fakeClient(answers: Record<string, unknown>) {
  const requests: { state: unknown; questions: Record<string, unknown> }[] = [];
  const client = {
    async systemOne(req: { state: unknown; questions: Record<string, unknown> }) {
      requests.push(req);
      return { answers };
    },
  } as unknown as TypeSafeClient;
  return { client, requests };
}
