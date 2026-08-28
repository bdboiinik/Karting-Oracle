export const MAX_ORACLE_ANSWER_CHARACTERS = 1_800;

const UNNECESSARY_FOLLOW_UP =
  /(?:\n\s*)?(?:Would you like me to|Do you want me to|Let me know if you(?:'d| would) like me to)[^.!?]*(?:[.!?]|$)/gi;
const REDUNDANT_SUMMARY =
  /^(?:in summary|to summarise|to summarize|overall|the short answer is)\b/i;
const SECTION_HEADING = /^\*\*[A-Z]\.\s+[^*]+\*\*$/;

function cleanAnswer(answer: string): string {
  return answer
    .replace(/\r\n/g, "\n")
    .replace(UNNECESSARY_FOLLOW_UP, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ensureCompleteUnit(unit: string): string {
  const trimmed = unit
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .trim();

  if (!trimmed || /[.!?]$/.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}.`;
}

function splitAnswerUnits(answer: string): string[] {
  const units: string[] = [];

  for (const line of answer.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed || SECTION_HEADING.test(trimmed)) continue;

    const sentences = trimmed.split(/(?<=[.!?])\s+(?=[A-Z0-9**])/);
    for (const sentence of sentences) {
      const complete = ensureCompleteUnit(sentence);
      if (complete) units.push(complete);
    }
  }

  return units;
}

function wordSet(sentence: string): Set<string> {
  return new Set(
    sentence
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

function isRepetitive(sentence: string, selected: string[]): boolean {
  const words = wordSet(sentence);
  if (words.size < 4) return false;

  return selected.some((existing) => {
    const existingWords = wordSet(existing);
    const overlap = [...words].filter((word) => existingWords.has(word)).length;
    return overlap / Math.min(words.size, existingWords.size) >= 0.75;
  });
}

function shortenLongUnit(unit: string, limit: number): string {
  if (unit.length <= limit) return unit;
  if (limit <= 1) return ".".slice(0, Math.max(0, limit));

  const candidate = unit.slice(0, limit - 1);
  const clauseBoundary = Math.max(
    candidate.lastIndexOf(";"),
    candidate.lastIndexOf(","),
    candidate.lastIndexOf(":"),
  );
  const wordBoundary = candidate.lastIndexOf(" ");
  const boundary = clauseBoundary >= Math.floor(limit * 0.45)
    ? clauseBoundary
    : wordBoundary;
  const shortened = candidate.slice(0, Math.max(1, boundary)).trimEnd();

  return `${shortened.replace(/[,:;\s]+$/, "")}.`;
}

export function condenseAnswerForDiscord(
  answer: string,
  maximumCharacters = MAX_ORACLE_ANSWER_CHARACTERS,
): string {
  const limit = Math.max(1, Math.trunc(maximumCharacters));
  const cleaned = cleanAnswer(answer);

  if (cleaned.length <= limit) {
    return cleaned;
  }

  const units = splitAnswerUnits(cleaned);
  if (units.length === 0) {
    return shortenLongUnit(cleaned, limit);
  }

  const selected: string[] = [];
  let usedCharacters = 0;

  for (const unit of units) {
    if (
      selected.length > 0 &&
      (REDUNDANT_SUMMARY.test(unit) || isRepetitive(unit, selected))
    ) {
      continue;
    }

    const separatorLength = selected.length === 0 ? 0 : 1;
    if (usedCharacters + separatorLength + unit.length > limit) {
      continue;
    }

    selected.push(unit);
    usedCharacters += separatorLength + unit.length;
  }

  if (selected.length === 0) {
    return shortenLongUnit(units[0], limit);
  }

  return selected.join(" ");
}
