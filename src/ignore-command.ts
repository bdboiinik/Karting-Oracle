export const ORACLE_IGNORE_SUBCOMMAND_NAME = "ignore";
export const IGNORE_MESSAGE_OPTION_NAME = "message";
export const IGNORE_MESSAGE_MAX_LENGTH = 1_800;

export const IGNORE_PROCESSING_PLAN = {
  classifyIntent: false,
  loadConversation: false,
  loadKnowledge: false,
  callOpenAI: false,
  allowWebSearch: false,
  storeConversation: false,
  consumeDailyQuestion: false,
  alterConversationContext: false,
} as const;

export interface IgnoreCommandResult {
  allowed: boolean;
  content: string;
}

export function buildIgnoreCommandResult(
  configuredOracleChannelId: string | undefined,
  currentChannelId: string,
  discordUserId: string,
  message: string,
): IgnoreCommandResult {
  if (
    !configuredOracleChannelId ||
    currentChannelId !== configuredOracleChannelId
  ) {
    return {
      allowed: false,
      content: "/oracle ignore is only available in the configured Oracle channel.",
    };
  }

  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    return {
      allowed: false,
      content: "Please provide a message to post.",
    };
  }

  return {
    allowed: true,
    content: `💬 <@${discordUserId}>: ${trimmedMessage}`,
  };
}
