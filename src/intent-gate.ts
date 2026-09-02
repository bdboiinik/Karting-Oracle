import {
  formatRemainingQuestions,
  type DailyQuestionReservation,
} from "./daily-limit.js";
import {
  type ClarificationResolution,
  type PendingClarification,
  resolvePendingClarification,
} from "./clarification-state.js";

export type GenuineIntentClassification = "genuine" | "obvious_nonsense";

export interface NonsenseProcessingPlan {
  dailyQuestionsConsumed: 1;
  allowClarification: false;
  loadConversation: false;
  loadKnowledge: false;
  generateFullAnswer: false;
  allowWebSearch: false;
}

export type IntentGateResult =
  | {
      outcome: "reject_nonsense";
      plan: NonsenseProcessingPlan;
    }
  | {
      outcome: "continue";
      clarification: ClarificationResolution;
    };

export const NONSENSE_PROCESSING_PLAN: NonsenseProcessingPlan = {
  dailyQuestionsConsumed: 1,
  allowClarification: false,
  loadConversation: false,
  loadKnowledge: false,
  generateFullAnswer: false,
  allowWebSearch: false,
};

export const NONSENSE_RESPONSE =
  "🏁 Nice try 😄 That still counts as one of your daily questions.";
const MODERATOR_NONSENSE_RESPONSE = "🏁 Nice try 😄";

const NON_FOOD_EQUIPMENT =
  "(?:(?:kart|racing)\\s+)?(?:tyres?|tires?|helmet|race suit|rib protector|steering (?:wheel|column)|engine|chassis|sprocket|brake disc)";
const ABSURD_ALTERNATIVE_OBJECT =
  "(?:toothbrush|cereal bowl|soup bowl|drinking cup|dinner plate|toilet|pillow)";

const OBVIOUS_NONSENSE_PATTERNS = [
  new RegExp(
    `\\b(?:is|are|would|could)\\s+(?:a|an|my|the)?\\s*${NON_FOOD_EQUIPMENT}\\b[\\s\\S]{0,45}\\b(?:breakfast|lunch|dinner|snack|meal|food|edible|delicious)\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:eat|serve|have)\\s+(?:a|an|my|the)?\\s*${NON_FOOD_EQUIPMENT}\\b(?:\\s+(?:for|as)\\s+(?:breakfast|lunch|dinner|a snack|a meal))?`,
    "i",
  ),
  /\b(?:eat|eating|edible)\b\s+(?:a|an|my|the)?\s*\b(?:kart|go[ -]?kart)\b/i,
  /\b(?:marry|wedding|honeymoon|romantically date)\b[\s\S]{0,60}\b(?:my\s+)?(?:kart|go[ -]?kart|helmet|tyre|tire)\b/i,
  /\b(?:kart|go[ -]?kart|helmet|tyre|tire)\b[\s\S]{0,60}\b(?:marry|wedding|honeymoon|romantically date)\b/i,
  new RegExp(
    `\\b(?:can|could|should|may|would)\\s+i\\s+(?:use|wear|turn)\\s+(?:my|the|a|an)?\\s*${NON_FOOD_EQUIPMENT}\\b[\\s\\S]{0,35}\\b(?:as|for|into)\\s+(?:my|the|a|an)?\\s*${ABSURD_ALTERNATIVE_OBJECT}\\b`,
    "i",
  ),
];

export function nonsenseProcessingPlan(
  question: string,
): NonsenseProcessingPlan | undefined {
  return classifyGenuineKartingIntent(question) === "obvious_nonsense"
    ? NONSENSE_PROCESSING_PLAN
    : undefined;
}

export function resolveIntentBeforeClarification(
  question: string,
  pending: PendingClarification | undefined,
): IntentGateResult {
  const plan = nonsenseProcessingPlan(question);

  if (plan) {
    return { outcome: "reject_nonsense", plan };
  }

  return {
    outcome: "continue",
    clarification: resolvePendingClarification(pending, question),
  };
}

export function classifyGenuineKartingIntent(
  question: string,
): GenuineIntentClassification {
  return OBVIOUS_NONSENSE_PATTERNS.some((pattern) => pattern.test(question))
    ? "obvious_nonsense"
    : "genuine";
}

export function formatNonsenseResponse(
  reservation: DailyQuestionReservation | undefined,
): string {
  if (!reservation) {
    return MODERATOR_NONSENSE_RESPONSE;
  }

  const remaining = formatRemainingQuestions(reservation);
  return remaining
    ? `${NONSENSE_RESPONSE}\n\n${remaining}`
    : NONSENSE_RESPONSE;
}
