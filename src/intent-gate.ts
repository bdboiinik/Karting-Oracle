import {
  formatRemainingQuestions,
  type DailyQuestionReservation,
} from "./daily-limit.js";

export type GenuineIntentClassification = "genuine" | "obvious_nonsense";

export interface NonsenseProcessingPlan {
  consumeReservedQuestion: true;
  loadConversation: false;
  loadKnowledge: false;
  generateFullAnswer: false;
  allowWebSearch: false;
}

export const NONSENSE_PROCESSING_PLAN: NonsenseProcessingPlan = {
  consumeReservedQuestion: true,
  loadConversation: false,
  loadKnowledge: false,
  generateFullAnswer: false,
  allowWebSearch: false,
};

export const NONSENSE_RESPONSE =
  "🏁 Nice try 😄 That still counts as one of your daily questions.";
const MODERATOR_NONSENSE_RESPONSE = "🏁 Nice try 😄";

const NON_FOOD_EQUIPMENT =
  "(?:(?:kart|racing)\\s+)?(?:tyres?|tires?|helmet|race suit|rib protector|steering wheel|engine|chassis|sprocket|brake disc)";

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
  /\b(?:use|wear)\b[\s\S]{0,40}\b(?:helmet|tyre|tire|race suit)\b[\s\S]{0,40}\b(?:as|for)\b[\s\S]{0,20}\b(?:cereal bowl|soup bowl|drinking cup|dinner plate|toilet|pillow)\b/i,
];

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
