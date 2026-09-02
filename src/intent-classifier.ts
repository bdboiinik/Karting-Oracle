export const INTENT_CLASSIFICATIONS = [
  "GENUINE_KARTING",
  "NONSENSE_OR_TROLLING",
  "OFF_TOPIC",
  "SAFETY_SENSITIVE",
  "UNCERTAIN",
] as const;

export type IntentClassification =
  (typeof INTENT_CLASSIFICATIONS)[number];

export const SAFETY_CATEGORIES = [
  "none",
  "chemical_ingestion",
  "fire_or_fumes",
  "serious_injury",
  "other_urgent",
] as const;

export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export interface IntentClassificationResult {
  classification: IntentClassification;
  safetyCategory: SafetyCategory;
}

export const INTENT_CLASSIFIER_INPUT_CHARACTER_LIMIT = 800;
export const INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS = 160;

export const INTENT_CLASSIFIER_INSTRUCTIONS = `Classify the intent of one Discord message sent to a karting specialist. Return only the required structured result. Do not answer the message.

Use GENUINE_KARTING when the user appears to want useful karting information, including driving, setup, maintenance, equipment, venues, events, fitness, nutrition, beginner topics, legitimate safety guidance, or an unusual but plausible question.

Use NONSENSE_OR_TROLLING when the primary intent is humour, trolling, testing the bot, an absurd or impossible premise, deliberate pointlessness, or ridiculous misuse/comparison involving karting. Judge the semantic purpose, not the presence of karting words. Do not require a known phrase or example.

Use OFF_TOPIC when there is no material connection to karting.

Use SAFETY_SENSITIVE only for a plausibly immediate or real ingestion, hazardous chemical/fuel exposure, fire/fume danger, or serious injury situation where a short urgent safety response is more appropriate than normal discussion. Potential real harm takes precedence over NONSENSE_OR_TROLLING. Ordinary technical safety questions remain GENUINE_KARTING.

Use UNCERTAIN when the short standalone message lacks enough information to decide. Prefer GENUINE_KARTING or UNCERTAIN over rejecting a plausibly serious, unusual, basic, or younger user's question. A context-dependent reply can be UNCERTAIN; do not classify it as trolling merely because it is short.

safety_category must be chemical_ingestion, fire_or_fumes, serious_injury, or other_urgent only for SAFETY_SENSITIVE. It must be none for every other classification.`;

export const INTENT_CLASSIFIER_RESPONSE_FORMAT = {
  type: "json_schema",
  name: "karting_oracle_intent",
  description: "A minimal semantic intent decision for one incoming message.",
  strict: true,
  schema: {
    type: "object",
    properties: {
      classification: {
        type: "string",
        enum: INTENT_CLASSIFICATIONS,
      },
      safety_category: {
        type: "string",
        enum: SAFETY_CATEGORIES,
      },
    },
    required: ["classification", "safety_category"],
    additionalProperties: false,
  },
} as const;

export function buildIntentClassifierInput(message: string): string {
  return message.trim().slice(0, INTENT_CLASSIFIER_INPUT_CHARACTER_LIMIT);
}

export function buildIntentClassifierRequest(
  model: string,
  message: string,
): ResponseCreateParamsNonStreaming {
  return {
    model,
    instructions: INTENT_CLASSIFIER_INSTRUCTIONS,
    input: buildIntentClassifierInput(message),
    max_output_tokens: INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS,
    reasoning: { effort: "minimal" },
    store: false,
    text: {
      format: INTENT_CLASSIFIER_RESPONSE_FORMAT,
      verbosity: "low",
    },
  };
}

export function parseIntentClassification(
  outputText: string,
): IntentClassificationResult {
  let value: unknown;

  try {
    value = JSON.parse(outputText);
  } catch {
    throw new Error("OpenAI returned an invalid intent classification.");
  }

  if (typeof value !== "object" || value === null) {
    throw new Error("OpenAI returned an invalid intent classification.");
  }

  const row = value as Record<string, unknown>;

  if (
    Object.keys(row).length !== 2 ||
    typeof row.classification !== "string" ||
    !INTENT_CLASSIFICATIONS.includes(
      row.classification as IntentClassification,
    ) ||
    typeof row.safety_category !== "string" ||
    !SAFETY_CATEGORIES.includes(row.safety_category as SafetyCategory)
  ) {
    throw new Error("OpenAI returned an invalid intent classification.");
  }

  const classification = row.classification as IntentClassification;
  const safetyCategory = row.safety_category as SafetyCategory;

  if (
    (classification === "SAFETY_SENSITIVE" && safetyCategory === "none") ||
    (classification !== "SAFETY_SENSITIVE" && safetyCategory !== "none")
  ) {
    throw new Error("OpenAI returned an invalid intent classification.");
  }

  return { classification, safetyCategory };
}
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
