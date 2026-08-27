export interface DailyQuestionReservation {
  allowed: boolean;
  dailyLimit: number | undefined;
  used: number;
  remaining: number | undefined;
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
  return `You have reached this server's daily limit of ${limit} AI ${noun}. Your allowance resets at 00:00 UTC.`;
}
