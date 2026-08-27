export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  discordGuildId: string;
  discordUserId: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
}

export interface ConversationContextLimits {
  maxMessages: number;
  tokenBudget: number;
}

export const DEFAULT_CONVERSATION_CONTEXT_LIMITS: ConversationContextLimits = {
  maxMessages: 10,
  tokenBudget: 1_600,
};

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }

  return parsed;
}

export function resolveConversationContextLimits(
  environment: NodeJS.ProcessEnv,
): ConversationContextLimits {
  return {
    maxMessages: parseBoundedInteger(
      environment.ORACLE_HISTORY_MAX_MESSAGES,
      DEFAULT_CONVERSATION_CONTEXT_LIMITS.maxMessages,
      2,
      30,
      "ORACLE_HISTORY_MAX_MESSAGES",
    ),
    tokenBudget: parseBoundedInteger(
      environment.ORACLE_HISTORY_TOKEN_BUDGET,
      DEFAULT_CONVERSATION_CONTEXT_LIMITS.tokenBudget,
      200,
      8_000,
      "ORACLE_HISTORY_TOKEN_BUDGET",
    ),
  };
}

export function estimateConversationTokens(message: ConversationMessage): number {
  return Math.ceil(message.content.length / 4) + 6;
}

export function selectConversationContext(
  messages: ConversationMessage[],
  discordGuildId: string,
  discordUserId: string,
  limits: ConversationContextLimits,
): ConversationMessage[] {
  const scopedMessages = messages
    .filter(
      (message) =>
        message.discordGuildId === discordGuildId &&
        message.discordUserId === discordUserId,
    )
    .sort(
      (first, second) =>
        Date.parse(first.createdAt) - Date.parse(second.createdAt),
    )
    .slice(-limits.maxMessages);

  const selected: ConversationMessage[] = [];
  let usedTokens = 0;

  for (const message of [...scopedMessages].reverse()) {
    const estimatedTokens = estimateConversationTokens(message);

    if (usedTokens + estimatedTokens > limits.tokenBudget) {
      continue;
    }

    selected.push(message);
    usedTokens += estimatedTokens;
  }

  return selected.reverse();
}
