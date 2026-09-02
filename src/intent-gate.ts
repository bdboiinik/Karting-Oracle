import {
  type ClarificationResolution,
  type PendingClarification,
  resolvePendingClarification,
} from "./clarification-state.js";
import {
  formatRemainingQuestions,
  type DailyQuestionReservation,
} from "./daily-limit.js";
import type {
  IntentClassificationResult,
  SafetyCategory,
} from "./intent-classifier.js";
import { OFF_TOPIC_RESPONSE } from "./topic-gate.js";

export interface TerminalIntentPlan {
  dailyQuestionsConsumed: 0 | 1;
  allowClarification: false;
  loadConversation: false;
  loadKnowledge: false;
  generateFullAnswer: false;
  allowWebSearch: false;
  response: string;
}

export type IntentGateResult =
  | {
      outcome: "respond";
      plan: TerminalIntentPlan;
    }
  | {
      outcome: "continue";
      clarification: ClarificationResolution;
    };

export const NONSENSE_RESPONSE =
  "🏁 Nice try 😄 That still counts as one of your daily questions.";
const MODERATOR_NONSENSE_RESPONSE = "🏁 Nice try 😄";

const SAFETY_RESPONSES: Record<Exclude<SafetyCategory, "none">, string> = {
  chemical_ingestion:
    "No — karting fuel, oil, and other chemicals are unsafe to ingest. If this may have happened, seek urgent medical or poison-control advice now.",
  fire_or_fumes:
    "Move away from the fire or fumes and get to fresh air. If anyone is in danger or unwell, contact emergency services now.",
  serious_injury:
    "Stop karting and seek urgent medical help. Call emergency services if the injury is severe or anyone is in immediate danger.",
  other_urgent:
    "Stop and get help from a responsible adult, track official, or medical professional. Contact emergency services if anyone is in immediate danger.",
};

function terminalPlan(
  response: string,
  dailyQuestionsConsumed: 0 | 1,
): TerminalIntentPlan {
  return {
    dailyQuestionsConsumed,
    allowClarification: false,
    loadConversation: false,
    loadKnowledge: false,
    generateFullAnswer: false,
    allowWebSearch: false,
    response,
  };
}

export function resolveClassifiedIntentBeforeClarification(
  result: IntentClassificationResult,
  question: string,
  pending: PendingClarification | undefined,
): IntentGateResult {
  switch (result.classification) {
    case "NONSENSE_OR_TROLLING":
      return { outcome: "respond", plan: terminalPlan(NONSENSE_RESPONSE, 1) };
    case "OFF_TOPIC":
      return { outcome: "respond", plan: terminalPlan(OFF_TOPIC_RESPONSE, 0) };
    case "SAFETY_SENSITIVE":
      return {
        outcome: "respond",
        plan: terminalPlan(
          SAFETY_RESPONSES[
            result.safetyCategory as Exclude<SafetyCategory, "none">
          ],
          1,
        ),
      };
    case "GENUINE_KARTING":
    case "UNCERTAIN":
      return {
        outcome: "continue",
        clarification: resolvePendingClarification(pending, question),
      };
  }
}

export function formatTerminalIntentResponse(
  plan: TerminalIntentPlan,
  reservation: DailyQuestionReservation | undefined,
): string {
  const baseResponse =
    plan.response === NONSENSE_RESPONSE && !reservation
      ? MODERATOR_NONSENSE_RESPONSE
      : plan.response;
  const remaining =
    plan.dailyQuestionsConsumed === 1 && reservation
      ? formatRemainingQuestions(reservation)
      : undefined;

  return remaining ? `${baseResponse}\n\n${remaining}` : baseResponse;
}
