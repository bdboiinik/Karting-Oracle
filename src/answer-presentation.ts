import { condenseAnswerForDiscord } from "./answer-length.js";

export const VERIFIED_ANSWER_BADGE = "✅ **Verified by a moderator**";
export const VERIFIED_KNOWLEDGE_NOTE =
  "📚 Informed by verified community knowledge";

export interface AnswerPresentationOptions {
  isVerified: boolean;
  usedVerifiedKnowledge: boolean;
  messageLimit?: number;
}

function removePresentationLines(content: string): string {
  return content
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== VERIFIED_ANSWER_BADGE &&
        line.trim() !== VERIFIED_KNOWLEDGE_NOTE,
    )
    .join("\n")
    .trim();
}

export function renderAnswerContent(
  answerText: string,
  options: AnswerPresentationOptions,
): string {
  const messageLimit = options.messageLimit ?? 2_000;
  const statusLines: string[] = [];

  if (options.isVerified) {
    statusLines.push(VERIFIED_ANSWER_BADGE);
  }

  if (options.usedVerifiedKnowledge) {
    statusLines.push(VERIFIED_KNOWLEDGE_NOTE);
  }

  const suffix = statusLines.join("\n");
  const separator = suffix ? "\n\n" : "";
  const availableAnswerLength = Math.max(
    0,
    messageLimit - separator.length - suffix.length,
  );
  const cleanAnswer = removePresentationLines(answerText);
  const displayedAnswer = condenseAnswerForDiscord(
    cleanAnswer,
    availableAnswerLength,
  );

  return `${displayedAnswer}${separator}${suffix}`;
}

export function updateVerificationPresentation(
  displayedContent: string,
  isVerified: boolean,
): string {
  return renderAnswerContent(displayedContent, {
    isVerified,
    usedVerifiedKnowledge: displayedContent
      .split("\n")
      .some((line) => line.trim() === VERIFIED_KNOWLEDGE_NOTE),
  });
}
