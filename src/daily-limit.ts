export interface DailyQuestionReservation {
  allowed: boolean;
  dailyLimit: number | undefined;
  used: number;
  remaining: number | undefined;
}

export interface UserQuestionLimitStatus {
  serverDailyLimit: number | undefined;
  personalDailyLimit: number | undefined;
  effectiveDailyLimit: number | undefined;
  used: number;
  remaining: number | undefined;
  isBlocked: boolean;
}

export interface EffectiveQuestionAllowance {
  effectiveDailyLimit: number | undefined;
  remaining: number | undefined;
  isBlocked: boolean;
  allowed: boolean;
}

export const BLOCKED_QUESTION_MESSAGE =
  "🏁 You currently don't have access to ask Karting Oracle questions.";

export function evaluateQuestionAllowance(
  serverDailyLimit: number | undefined,
  personalDailyLimit: number | undefined,
  used: number,
  reserved = 0,
): EffectiveQuestionAllowance {
  const effectiveDailyLimit = personalDailyLimit ?? serverDailyLimit;
  const remaining =
    effectiveDailyLimit === undefined
      ? undefined
      : Math.max(effectiveDailyLimit - used - reserved, 0);

  return {
    effectiveDailyLimit,
    remaining,
    isBlocked: effectiveDailyLimit === 0,
    allowed:
      effectiveDailyLimit === undefined || used + reserved < effectiveDailyLimit,
  };
}

export function shouldReserveDailyQuestion(
  isModerator: boolean,
  isClarificationReply: boolean,
): boolean {
  return !isModerator && !isClarificationReply;
}

export function formatRemainingQuestions(
  reservation: DailyQuestionReservation,
): string | undefined {
  if (reservation.dailyLimit === undefined || reservation.remaining === undefined) {
    return undefined;
  }

  const noun = reservation.remaining === 1 ? "question" : "questions";
  return `⏳ Daily AI questions remaining: ${reservation.remaining} ${noun}.`;
}

export function limitReachedMessage(limit: number): string {
  const noun = limit === 1 ? "question" : "questions";
  return `You have reached your current daily limit of ${limit} AI ${noun}. Your allowance resets at 00:00 UTC.`;
}

function formatLimit(limit: number | undefined): string {
  return limit === undefined ? "Unlimited" : `${limit}/day`;
}

export function formatUserQuestionLimitStatus(
  displayName: string,
  status: UserQuestionLimitStatus,
): string {
  return [
    `Daily limit status for **${displayName}**`,
    `Server default: ${formatLimit(status.serverDailyLimit)}`,
    `Personal override: ${
      status.personalDailyLimit === undefined
        ? "None"
        : formatLimit(status.personalDailyLimit)
    }`,
    `Effective limit: ${formatLimit(status.effectiveDailyLimit)}`,
    `Used today: ${status.used}`,
    `Remaining today: ${status.remaining ?? "Unlimited"}`,
    `Blocked: ${status.isBlocked ? "Yes" : "No"}`,
  ].join("\n");
}
