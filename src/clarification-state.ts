export interface OracleClarification {
  missingInformation: string;
  candidateInterpretation?: string;
}

export interface PendingClarification {
  originalQuestion: string;
  missingInformation: string;
  candidateInterpretation?: string;
  askedClarifications: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ClarificationResolution {
  effectiveQuestion: string;
  isClarificationReply: boolean;
  resolved: boolean;
  pending?: PendingClarification;
}

const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1_000;
const AFFIRMATIVE_PATTERN =
  /^(?:yes|yeah|yep|yup|correct|exactly|that's right|that is right|i do|it is|sure)[.!\s]*$/i;
const NEGATIVE_PATTERN = /^(?:no|nope|not that|incorrect)[.!\s]*$/i;
const CORRECTION_PATTERN =
  /\b(?:sorry|typo|misspell(?:ed|ing)?|spelt|spelled|meant|correction|actually)\b/i;
const VAGUE_PATTERN =
  /^(?:maybe|not sure|i(?:'m| am) not sure|i don(?:'t|’t) know|unsure)[.!\s]*$/i;

function stateKey(discordGuildId: string, discordUserId: string): string {
  return `${discordGuildId}:${discordUserId}`;
}

function normalizeForComparison(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function clarificationSignature(clarification: OracleClarification): string {
  return normalizeForComparison(
    `${clarification.missingInformation} ${clarification.candidateInterpretation ?? ""}`,
  );
}

function substantiallySameSignature(left: string, right: string): boolean {
  if (left === right) return true;

  const leftWords = new Set(left.split(" ").filter(Boolean));
  const rightWords = new Set(right.split(" ").filter(Boolean));
  const union = new Set([...leftWords, ...rightWords]);
  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;

  return union.size > 0 && shared / union.size >= 0.72;
}

function matchesPriorClarification(
  askedClarifications: string[],
  clarification: OracleClarification,
): boolean {
  const signature = clarificationSignature(clarification);
  const candidate = clarification.candidateInterpretation
    ? normalizeForComparison(clarification.candidateInterpretation).replace(
        /^(?:do you mean|does the user mean|is it|the user means)\s+/,
        "",
      )
    : "";

  return askedClarifications.some(
    (asked) =>
      substantiallySameSignature(asked, signature) ||
      (candidate.length >= 8 && asked.includes(candidate)),
  );
}

function resolvedQuestion(
  pending: PendingClarification,
  suppliedDetail: string,
): string {
  return [
    `Original question: ${pending.originalQuestion}`,
    `User clarification: ${suppliedDetail}`,
  ].join("\n");
}

export function createPendingClarification(
  originalQuestion: string,
  clarification: OracleClarification,
  now = Date.now(),
): PendingClarification {
  return {
    originalQuestion: originalQuestion.trim(),
    missingInformation: clarification.missingInformation.trim(),
    ...(clarification.candidateInterpretation?.trim()
      ? { candidateInterpretation: clarification.candidateInterpretation.trim() }
      : {}),
    askedClarifications: [clarificationSignature(clarification)],
    createdAt: now,
    updatedAt: now,
  };
}

export function updatePendingClarification(
  pending: PendingClarification,
  clarification: OracleClarification,
  now = Date.now(),
): PendingClarification {
  const signature = clarificationSignature(clarification);
  return {
    ...pending,
    missingInformation: clarification.missingInformation.trim(),
    ...(clarification.candidateInterpretation?.trim()
      ? { candidateInterpretation: clarification.candidateInterpretation.trim() }
      : { candidateInterpretation: undefined }),
    askedClarifications: matchesPriorClarification(
      pending.askedClarifications,
      clarification,
    )
      ? pending.askedClarifications
      : [...pending.askedClarifications, signature],
    updatedAt: now,
  };
}

export function isRepeatedClarification(
  pending: PendingClarification,
  clarification: OracleClarification,
): boolean {
  return matchesPriorClarification(
    pending.askedClarifications,
    clarification,
  );
}

export function resolvePendingClarification(
  pending: PendingClarification | undefined,
  reply: string,
): ClarificationResolution {
  const trimmedReply = reply.trim();

  if (!pending) {
    return {
      effectiveQuestion: trimmedReply,
      isClarificationReply: false,
      resolved: false,
    };
  }

  if (AFFIRMATIVE_PATTERN.test(trimmedReply) && pending.candidateInterpretation) {
    return {
      effectiveQuestion: resolvedQuestion(
        pending,
        `The user confirmed: ${pending.candidateInterpretation}`,
      ),
      isClarificationReply: true,
      resolved: true,
      pending,
    };
  }

  if (NEGATIVE_PATTERN.test(trimmedReply) || VAGUE_PATTERN.test(trimmedReply)) {
    return {
      effectiveQuestion: [
        `Original question: ${pending.originalQuestion}`,
        `Missing information: ${pending.missingInformation}`,
        `User reply: ${trimmedReply}`,
      ].join("\n"),
      isClarificationReply: true,
      resolved: false,
      pending,
    };
  }

  // A correction or a concrete short reply to a pending question is the missing
  // detail. Treating it as a new standalone question caused the original loop.
  if (
    CORRECTION_PATTERN.test(trimmedReply) ||
    (trimmedReply.length >= 2 && trimmedReply.length <= 400)
  ) {
    return {
      effectiveQuestion: resolvedQuestion(
        pending,
        `The user supplied this correction/detail: ${trimmedReply}`,
      ),
      isClarificationReply: true,
      resolved: true,
      pending,
    };
  }

  return {
    effectiveQuestion: trimmedReply,
    isClarificationReply: false,
    resolved: false,
  };
}

export class PendingClarificationStore {
  readonly #entries = new Map<string, PendingClarification>();

  constructor(private readonly ttlMs = DEFAULT_PENDING_TTL_MS) {}

  get(
    discordGuildId: string,
    discordUserId: string,
    now = Date.now(),
  ): PendingClarification | undefined {
    const key = stateKey(discordGuildId, discordUserId);
    const pending = this.#entries.get(key);

    if (pending && now - pending.updatedAt > this.ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }

    return pending;
  }

  set(
    discordGuildId: string,
    discordUserId: string,
    pending: PendingClarification,
  ): void {
    this.#entries.set(stateKey(discordGuildId, discordUserId), pending);
  }

  clear(discordGuildId: string, discordUserId: string): void {
    this.#entries.delete(stateKey(discordGuildId, discordUserId));
  }
}
