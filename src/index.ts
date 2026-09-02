import "dotenv/config";

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

import {
  renderAnswerContent,
  updateVerificationPresentation,
  VERIFIED_KNOWLEDGE_NOTE,
} from "./answer-presentation.js";
import {
  answerEditIdFromCustomId,
  buildAnswerEditModal,
  buildModeratorAnswerButtons,
  editedAnswerFromModalFields,
} from "./answer-editing.js";
import { ChannelConfigStore } from "./channel-config-store.js";
import {
  createPendingClarification,
  isRepeatedClarification,
  PendingClarificationStore,
  resolvePendingClarification,
  updatePendingClarification,
} from "./clarification-state.js";
import {
  resolveConversationContextLimits,
  selectConversationContext,
  type ConversationMessage,
} from "./conversation-context.js";
import {
  BLOCKED_QUESTION_MESSAGE,
  formatRemainingQuestions,
  formatUserQuestionLimitStatus,
  limitReachedMessage,
  shouldReserveDailyQuestion,
  type DailyQuestionReservation,
  type UserQuestionLimitStatus,
} from "./daily-limit.js";
import {
  classifyGenuineKartingIntent,
  formatNonsenseResponse,
  NONSENSE_PROCESSING_PLAN,
} from "./intent-gate.js";
import {
  buildFeedbackButtons,
  feedbackButtonFromCustomId,
  KeyedSerialQueue,
} from "./feedback.js";
import type { RecordedVote, VoteTotals, VoteType } from "./feedback-types.js";
import {
  memberHasModeratorRole,
  resolveModeratorRoleIds,
} from "./moderator-roles.js";
import {
  buildOracleCommand,
  buildOracleChannelDiagnostics,
  buildOracleChannelSelector,
  canBotUseOracleChannel,
  canMemberConfigureOracleChannel,
  isOracleSetupCommand,
  LEGACY_ORACLE_SETUP_COMMAND_NAME,
  ORACLE_COMMAND_NAME,
  missingOracleChannelPermissions,
  ORACLE_CHANNEL_SELECT_CUSTOM_ID,
  ORACLE_KNOWLEDGE_GROUP_NAME,
  ORACLE_LIMIT_GROUP_NAME,
  ORACLE_RESET_SUBCOMMAND_NAME,
  ORACLE_SETUP_HANDLER_VERSION,
  ORACLE_SETUP_SUBCOMMAND_NAME,
} from "./oracle-channel-setup.js";
import {
  buildOracleInput,
  buildWebOracleInput,
  ORACLE_INSTRUCTIONS,
  ORACLE_RESPONSE_FORMAT,
  parseOracleResponse,
  type ClarificationPromptContext,
  type OracleAnswer,
  WEB_ORACLE_INSTRUCTIONS,
} from "./oracle-response.js";
import {
  isKnowledgeCategory,
  KNOWLEDGE_CATEGORY_LABELS,
  normalizeOptionalKnowledgeUrl,
  renderKnowledgeItem,
} from "./structured-knowledge.js";
import { safeErrorDetails } from "./safe-diagnostics.js";
import {
  isMissingAnswerError,
  SupabasePersistenceError,
  SupabaseService,
  type AnswerVerification,
  type UpdateStructuredKnowledgeInput,
  type VerifiedKnowledge,
} from "./supabase-service.js";
import {
  type VerificationAction,
  verificationButtonFromCustomId,
} from "./verification.js";
import {
  classifyTopic,
  OFF_TOPIC_RESPONSE,
} from "./topic-gate.js";
import {
  appendWebSourceCitation,
  createWebCacheKey,
  getWebSearchDiagnostics,
  isAcceptableWebSourceForRequest,
  parseWebSourcedAnswer,
  resolveWebRetrievalRequest,
  webCacheTtlMs,
  webRetrievalFailureMessage,
  WEB_ORACLE_RESPONSE_FORMAT,
} from "./web-retrieval.js";

const DISCORD_MESSAGE_LIMIT = 2_000;
const OPENAI_MODEL = "gpt-5-mini";
const OPENAI_PLANNING_OUTPUT_TOKEN_LIMIT = 2_000;
const OPENAI_WEB_OUTPUT_TOKEN_LIMIT = 2_500;
const OPENAI_MAX_WEB_TOOL_CALLS = 3;
const CHANNEL_CONFIG_PATH = fileURLToPath(
  new URL("../data/guild-config.json", import.meta.url),
);

const requiredEnvironmentVariables = [
  "DISCORD_TOKEN",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type EnvironmentVariable = (typeof requiredEnvironmentVariables)[number];

function readEnvironmentVariable(name: EnvironmentVariable): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function feedbackVoteLabel(vote: VoteType): string {
  return vote === "helpful" ? "Helpful" : "Not Helpful";
}

function feedbackConfirmation(feedback: RecordedVote): string {
  const currentLabel = feedbackVoteLabel(feedback.vote);

  if (!feedback.previousVote) {
    return `Thanks! Your vote is now ${currentLabel}.`;
  }

  if (feedback.previousVote === feedback.vote) {
    return `Your vote is still ${currentLabel}.`;
  }

  return `Updated your vote from ${feedbackVoteLabel(feedback.previousVote)} to ${currentLabel}.`;
}

function logDatabaseError(context: string, error: unknown): void {
  const detail =
    error instanceof SupabasePersistenceError
      ? error.message
      : error instanceof Error
        ? error.name
        : "Unknown error";

  console.error(`${context}: ${detail}`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTypingIndicator<T>(
  sendTyping: () => Promise<unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const refreshTyping = async (): Promise<void> => {
    await sendTyping().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "Unknown error";
      console.error(`Could not send the typing indicator: ${detail}`);
    });
  };

  await refreshTyping();
  const refreshTimer = setInterval(() => {
    void refreshTyping();
  }, 8_000);

  try {
    return await operation();
  } finally {
    clearInterval(refreshTimer);
  }
}

async function main(): Promise<void> {
  const discordToken = readEnvironmentVariable("DISCORD_TOKEN");
  const openaiApiKey = readEnvironmentVariable("OPENAI_API_KEY");
  const supabaseUrl = readEnvironmentVariable("SUPABASE_URL");
  const supabaseServiceRoleKey = readEnvironmentVariable(
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const moderatorRoleIds = resolveModeratorRoleIds(process.env);
  const conversationLimits = resolveConversationContextLimits(process.env);

  const channelConfig = new ChannelConfigStore(CHANNEL_CONFIG_PATH);
  const answerUpdates = new KeyedSerialQueue();
  const questionUpdates = new KeyedSerialQueue();
  const pendingClarifications = new PendingClarificationStore();
  const promptedGuildIds = new Set<string>();
  const promptingGuildIds = new Set<string>();

  await channelConfig.load();

  const openai = new OpenAI({ apiKey: openaiApiKey });
  const database = new SupabaseService(supabaseUrl, supabaseServiceRoleKey);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  async function generateOracleAnswer(
    prompt: string,
    verifiedKnowledge: VerifiedKnowledge[],
    structuredKnowledge: Awaited<
      ReturnType<SupabaseService["searchStructuredKnowledge"]>
    >,
    conversation: Awaited<
      ReturnType<SupabaseService["getConversationHistory"]>
    >,
    clarificationContext?: ClarificationPromptContext,
  ): Promise<OracleAnswer> {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      instructions: ORACLE_INSTRUCTIONS,
      input: buildOracleInput(
        prompt,
        verifiedKnowledge,
        structuredKnowledge,
        conversation,
        clarificationContext,
      ),
      max_output_tokens: OPENAI_PLANNING_OUTPUT_TOKEN_LIMIT,
      text: {
        format: ORACLE_RESPONSE_FORMAT,
        verbosity: "low",
      },
    });
    const responseText = response.output_text.trim();

    if (!responseText) {
      throw new Error(
        [
          "OpenAI returned no visible text",
          `status=${response.status}`,
          `reason=${response.incomplete_details?.reason ?? "none"}`,
          `error=${response.error ? safeErrorDetails(response.error) : "none"}`,
        ].join(", "),
      );
    }

    const initialAnswer = parseOracleResponse(
      responseText,
      verifiedKnowledge.length > 0,
      structuredKnowledge.length > 0,
    );
    const trustedKnowledgeText = [
      ...structuredKnowledge.flatMap((item) => [
        item.title,
        item.content,
        item.url ?? "",
      ]),
      ...verifiedKnowledge.flatMap((item) => [
        item.questionText,
        item.answerText,
      ]),
    ].join("\n");
    const webRequest = resolveWebRetrievalRequest(
      prompt,
      initialAnswer,
      trustedKnowledgeText,
    );

    if (!webRequest) {
      return initialAnswer;
    }

    const cacheKey = createWebCacheKey(
      webRequest.query,
      webRequest.factType,
      webRequest.temporalMode,
    );
    console.log(
      `[web-search] required=true fact_type=${webRequest.factType} temporal_mode=${webRequest.temporalMode} cache_key=${cacheKey.slice(0, 12)}`,
    );

    try {
      const cached = await database.getWebRetrievalCache(cacheKey);

      if (cached) {
        const cachedSource = cached.sources[0];
        const evidenceContext = {
          question: prompt,
          query: webRequest.query,
          factType: webRequest.factType,
          temporalMode: webRequest.temporalMode,
        };

        if (
          cachedSource &&
          isAcceptableWebSourceForRequest(cachedSource, evidenceContext)
        ) {
          console.log(
            `[web-search] cache_hit=true tool_invoked=false fact_type=${cached.factType}`,
          );
          return {
            text: cached.answerText,
            isKartingRelated: true,
            usedVerifiedKnowledge: cached.usedVerifiedKnowledge,
            usedStructuredKnowledge: cached.usedStructuredKnowledge,
          };
        }

        console.warn(
          `[web-search] cache_hit=true validation=ignored_inadequate_source fact_type=${cached.factType} temporal_mode=${webRequest.temporalMode}`,
        );
      }
    } catch (error) {
      logDatabaseError(
        "Web retrieval cache read failed; continuing without cache",
        error,
      );
    }

    try {
      console.log(
        `[web-search] cache_hit=false request_started=true fact_type=${webRequest.factType}`,
      );
      const webResponseRequest: ResponseCreateParamsNonStreaming & {
        max_tool_calls: number;
      } = {
        model: OPENAI_MODEL,
        instructions: WEB_ORACLE_INSTRUCTIONS,
        input: buildWebOracleInput(
          prompt,
          webRequest.query,
          webRequest.temporalMode,
          verifiedKnowledge,
          structuredKnowledge,
          conversation,
        ),
        max_output_tokens: OPENAI_WEB_OUTPUT_TOKEN_LIMIT,
        max_tool_calls: OPENAI_MAX_WEB_TOOL_CALLS,
        tools: [
          {
            type: "web_search",
            search_context_size:
              webRequest.temporalMode === "historical_pattern"
                ? "medium"
                : "low",
          },
        ],
        tool_choice: "required",
        parallel_tool_calls: false,
        include: ["web_search_call.action.sources"],
        text: {
          format: WEB_ORACLE_RESPONSE_FORMAT,
          verbosity: "low",
        },
      };
      const webResponse = await openai.responses.create(webResponseRequest);
      const webDiagnostics = getWebSearchDiagnostics(webResponse.output);
      console.log(
        `[web-search] result=${JSON.stringify({
          responseStatus: webResponse.status,
          responseError: webResponse.error
            ? safeErrorDetails(webResponse.error)
            : undefined,
          ...webDiagnostics,
        })}`,
      );
      const webResponseText = webResponse.output_text.trim();

      if (!webResponseText) {
        throw new Error(
          `OpenAI web retrieval returned no visible text (status=${webResponse.status}, reason=${webResponse.incomplete_details?.reason ?? "none"}).`,
        );
      }

      const sourcedAnswer = parseWebSourcedAnswer(
        webResponseText,
        webResponse.output,
        verifiedKnowledge.length > 0,
        structuredKnowledge.length > 0,
        {
          question: prompt,
          query: webRequest.query,
          factType: webRequest.factType,
          temporalMode: webRequest.temporalMode,
        },
      );
      const answerText = appendWebSourceCitation(
        sourcedAnswer.answerText,
        sourcedAnswer.source,
      );
      console.log(
        `[web-search] validation=passed primary_source_domain=${new URL(sourcedAnswer.source.url).hostname}`,
      );
      const fetchedAt = new Date();

      await database
        .saveWebRetrievalCache({
          cacheKey,
          canonicalQuery: webRequest.query,
          factType: webRequest.factType,
          factText: sourcedAnswer.factText,
          answerText,
          sources: [sourcedAnswer.source],
          usedVerifiedKnowledge: sourcedAnswer.usedVerifiedKnowledge,
          usedStructuredKnowledge: sourcedAnswer.usedStructuredKnowledge,
          fetchedAt: fetchedAt.toISOString(),
          expiresAt: new Date(
            fetchedAt.getTime() +
              webCacheTtlMs(webRequest.factType, webRequest.temporalMode),
          ).toISOString(),
        })
        .catch((error: unknown) => {
          logDatabaseError(
            "Could not cache the web-retrieved karting fact",
            error,
          );
        });

      return {
        text: answerText,
        isKartingRelated: true,
        usedVerifiedKnowledge: sourcedAnswer.usedVerifiedKnowledge,
        usedStructuredKnowledge: sourcedAnswer.usedStructuredKnowledge,
      };
    } catch (error) {
      console.error(
        `[web-search] validation_or_request=failed error=${safeErrorDetails(error)}`,
      );
      return {
        text: webRetrievalFailureMessage(webRequest.temporalMode),
        isKartingRelated: true,
        usedVerifiedKnowledge: false,
        usedStructuredKnowledge: false,
      };
    }
  }

  function buildAnswerComponents(
    answerId: string,
    totals: VoteTotals,
    isVerified: boolean,
  ) {
    return [
      buildFeedbackButtons(answerId, totals),
      buildModeratorAnswerButtons(answerId, isVerified),
    ];
  }

  async function isConfiguredModerator(
    guild: Guild,
    discordUserId: string,
  ): Promise<boolean> {
    const member = await guild.members.fetch({
      user: discordUserId,
      force: true,
    });

    return memberHasModeratorRole(member.roles.cache.keys(), moderatorRoleIds);
  }

  async function canUserConfigureOracleChannel(
    guild: Guild,
    discordUserId: string,
    hasManageGuildPermission: boolean,
  ): Promise<boolean> {
    if (hasManageGuildPermission) {
      return true;
    }

    const member = await guild.members.fetch({
      user: discordUserId,
      force: true,
    });

    return canMemberConfigureOracleChannel(
      member.roles.cache.keys(),
      moderatorRoleIds,
      false,
    );
  }

  async function registerOracleSetupCommand(guild: Guild): Promise<void> {
    const commands = await guild.commands.fetch();
    const existingCommand = commands.find(
      (command) => command.name === ORACLE_COMMAND_NAME,
    );
    const legacyCommand = commands.find(
      (command) => command.name === LEGACY_ORACLE_SETUP_COMMAND_NAME,
    );
    const commandData = buildOracleCommand();

    if (!existingCommand) {
      await guild.commands.create(commandData);
    } else {
      await guild.commands.edit(existingCommand, commandData);
    }

    if (legacyCommand) {
      await guild.commands.delete(legacyCommand.id);
    }

    console.log(
      `Registered /${ORACLE_COMMAND_NAME} ${ORACLE_SETUP_SUBCOMMAND_NAME} on ${guild.name} (${guild.id}); removedLegacyCommand=${Boolean(legacyCommand)}.`,
    );
  }

  async function inspectOracleChannelSelector(guild: Guild): Promise<
    string | undefined
  > {
    const configuredChannelId = channelConfig.get(guild.id);
    const channels = await guild.channels.fetch(undefined, { force: true });
    const diagnostics = buildOracleChannelDiagnostics(
      channels.values(),
      configuredChannelId,
    );

    console.log(
      `Oracle channel selector diagnostics for ${guild.name}: ${JSON.stringify({
        guildId: guild.id,
        configuredChannelId: configuredChannelId ?? null,
        channels: diagnostics,
      })}`,
    );

    const configuredChannel = configuredChannelId
      ? channels.get(configuredChannelId)
      : undefined;

    return configuredChannel?.type === ChannelType.GuildText
      ? configuredChannel.id
      : undefined;
  }

  async function findPromptChannel(guild: Guild): Promise<TextChannel | undefined> {
    await guild.channels.fetch();
    const botMember = await guild.members.fetchMe({ force: true });

    if (canBotUseOracleChannel(guild.systemChannel, botMember)) {
      return guild.systemChannel;
    }

    const availableChannels = guild.channels.cache
      .filter((channel): channel is TextChannel =>
        canBotUseOracleChannel(channel, botMember),
      )
      .sort(
        (firstChannel, secondChannel) =>
          firstChannel.rawPosition - secondChannel.rawPosition,
      );

    return (
      availableChannels.find((channel) => channel.name === "general") ??
      availableChannels.first()
    );
  }

  async function promptForChannel(guild: Guild): Promise<void> {
    if (
      channelConfig.has(guild.id) ||
      promptedGuildIds.has(guild.id) ||
      promptingGuildIds.has(guild.id)
    ) {
      return;
    }

    promptingGuildIds.add(guild.id);

    try {
      const promptChannel = await findPromptChannel(guild);

      if (!promptChannel) {
        console.warn(
          `Could not ask for a channel in ${guild.name}: grant the bot View Channel, Send Messages, and Read Message History in at least one text channel.`,
        );
        return;
      }

      await promptChannel.send({
        content:
          `Thanks for adding Karting Oracle! A server administrator or configured moderator can run \`/${ORACLE_COMMAND_NAME} ${ORACLE_SETUP_SUBCOMMAND_NAME}\` to choose the text channel I should read and reply in.`,
        allowedMentions: { parse: [] },
      });

      promptedGuildIds.add(guild.id);
      console.log(
        `Asked ${guild.name} to run /${ORACLE_COMMAND_NAME} ${ORACLE_SETUP_SUBCOMMAND_NAME} in #${promptChannel.name}.`,
      );
    } finally {
      promptingGuildIds.delete(guild.id);
    }
  }

  async function ensureGuildConfiguration(guild: Guild): Promise<void> {
    const configuredChannelId = channelConfig.get(guild.id);

    if (configuredChannelId) {
      const configuredChannel = await guild.channels.fetch(configuredChannelId, {
        force: true,
      });
      const botMember = await guild.members.fetchMe({ force: true });

      if (canBotUseOracleChannel(configuredChannel, botMember)) {
        console.log(`Listening in #${configuredChannel.name} on ${guild.name}.`);
        return;
      }

      await channelConfig.delete(guild.id);
      promptedGuildIds.delete(guild.id);
      console.warn(
        `The saved Oracle channel for ${guild.name} is unavailable; asking for a new one.`,
      );
    }

    await promptForChannel(guild);
  }

  async function prepareGuild(guild: Guild): Promise<void> {
    try {
      await registerOracleSetupCommand(guild);
    } catch (error) {
      console.error(
        `Could not register /${ORACLE_COMMAND_NAME} ${ORACLE_SETUP_SUBCOMMAND_NAME} on ${guild.name}:`,
        error,
      );
    }

    await ensureGuildConfiguration(guild);
  }

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}.`);

    void database
      .checkConnection()
      .then(() => {
        console.log("Supabase persistence is ready.");
      })
      .catch((error: unknown) => {
        logDatabaseError("Supabase persistence check failed", error);
      });

    void (async () => {
      for (const guild of readyClient.guilds.cache.values()) {
        try {
          await prepareGuild(guild);
        } catch (error) {
          console.error(`Could not configure ${guild.name}:`, error);
        }
      }
    })();
  });

  client.on(Events.GuildCreate, (guild) => {
    void prepareGuild(guild).catch((error: unknown) => {
      console.error(`Could not configure ${guild.name}:`, error);
    });
  });

  async function handleFeedbackButton(
    interaction: ButtonInteraction,
    answerId: string,
    vote: VoteType,
  ): Promise<void> {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    await answerUpdates.run(answerId, async () => {
      let feedback: RecordedVote;

      try {
        feedback = await database.recordVote(
          answerId,
          interaction.user.id,
          vote,
        );
      } catch (error) {
        logDatabaseError("Could not persist feedback", error);

        await interaction.editReply(
          isMissingAnswerError(error)
            ? "Persistent voting is not available for this older answer. Ask a new question and vote on its answer."
            : "I could not save your vote right now. Please try again in a moment.",
        );
        return;
      }

      let verification: AnswerVerification;

      try {
        verification = await database.getAnswerVerification(answerId);
      } catch (error) {
        logDatabaseError(
          "Recorded feedback but could not read verification state",
          error,
        );
        await interaction.editReply(
          "Your vote was recorded, but I could not refresh the answer controls right now.",
        );
        return;
      }

      try {
        await interaction.message.edit({
          components: buildAnswerComponents(
            answerId,
            feedback.totals,
            verification.isVerified,
          ),
        });
      } catch (error) {
        console.error("Recorded feedback but could not refresh its totals:", error);
        await interaction
          .editReply(
            "Your vote was recorded, but I could not refresh the totals right now.",
          )
          .catch((replyError: unknown) => {
            console.error("Could not send the feedback update warning:", replyError);
          });
        return;
      }

      await interaction
        .editReply(feedbackConfirmation(feedback))
        .catch((error: unknown) => {
          console.error("Recorded feedback but could not confirm it:", error);
        });
    });
  }

  async function handleVerificationButton(
    interaction: ButtonInteraction,
    answerId: string,
    action: VerificationAction,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.inCachedGuild()) {
      await interaction.editReply(
        "Answer verification is only available inside a Discord server.",
      );
      return;
    }

    let isModerator: boolean;

    try {
      isModerator = await isConfiguredModerator(
        interaction.guild,
        interaction.user.id,
      );
    } catch (error) {
      console.error("Could not check the moderator role:", error);
      await interaction.editReply(
        "I could not check your moderator role right now. Please try again.",
      );
      return;
    }

    if (!isModerator) {
      await interaction.editReply(
        "Only members with a configured moderator role can verify answers.",
      );
      return;
    }

    await answerUpdates.run(answerId, async () => {
      const shouldVerify = action === "verify";
      let verification: AnswerVerification;
      let totals: VoteTotals;

      try {
        verification = await database.setAnswerVerification(
          answerId,
          interaction.user.id,
          shouldVerify,
        );
        totals = await database.getVoteTotals(answerId);
      } catch (error) {
        logDatabaseError("Could not update answer verification", error);
        await interaction.editReply(
          isMissingAnswerError(error)
            ? "Verification is not available for this older answer. Ask a new question and verify its answer."
            : "I could not update verification right now. Please try again in a moment.",
        );
        return;
      }

      try {
        await interaction.message.edit({
          content: updateVerificationPresentation(
            interaction.message.content,
            verification.isVerified,
          ),
          components: buildAnswerComponents(
            answerId,
            totals,
            verification.isVerified,
          ),
        });
      } catch (error) {
        console.error(
          "Updated verification but could not refresh the Discord answer:",
          error,
        );
        await interaction.editReply(
          "The database was updated, but I could not refresh the Discord answer right now.",
        );
        return;
      }

      await interaction.editReply(
        verification.isVerified
          ? "Answer verified. It can now support similar future answers."
          : "Answer unverified. It will no longer be used as trusted community knowledge.",
      );
    });
  }

  async function handleAnswerEditButton(
    interaction: ButtonInteraction,
    answerId: string,
  ): Promise<void> {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: "Answer editing is only available inside a Discord server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let isModerator: boolean;

    try {
      isModerator = await isConfiguredModerator(
        interaction.guild,
        interaction.user.id,
      );
    } catch (error) {
      console.error("Could not check the answer editor's moderator role:", error);
      await interaction.reply({
        content: "I could not check your moderator role right now.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isModerator) {
      await interaction.reply({
        content:
          "Only members with a configured moderator role can edit answers.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const answer = await database.getAnswerForEditing(answerId);
      await interaction.showModal(
        buildAnswerEditModal(answerId, answer.answerText),
      );
    } catch (error) {
      logDatabaseError("Could not open answer editor", error);
      await interaction.reply({
        content: "I could not load that answer for editing right now.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  async function handleAnswerEditModal(
    interaction: ModalSubmitInteraction<"cached">,
    answerId: string,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let isModerator: boolean;

    try {
      isModerator = await isConfiguredModerator(
        interaction.guild,
        interaction.user.id,
      );
    } catch (error) {
      console.error("Could not check the answer editor's moderator role:", error);
      await interaction.editReply(
        "I could not check your moderator role right now.",
      );
      return;
    }

    if (!isModerator) {
      await interaction.editReply(
        "Only members with a configured moderator role can edit answers.",
      );
      return;
    }

    if (
      !interaction.message ||
      interaction.message.author.id !== client.user?.id
    ) {
      await interaction.editReply(
        "I could not identify the original Karting Oracle answer.",
      );
      return;
    }

    const sourceMessage = interaction.message;

    const editedText = editedAnswerFromModalFields(interaction.fields);

    if (!editedText) {
      await interaction.editReply("The edited answer cannot be empty.");
      return;
    }

    await answerUpdates.run(answerId, async () => {
      try {
        const [editedAnswer, totals] = await Promise.all([
          database.editAnswer(answerId, editedText, interaction.user.id),
          database.getVoteTotals(answerId),
        ]);
        const usedVerifiedKnowledge = sourceMessage.content
          .split("\n")
          .some((line) => line.trim() === VERIFIED_KNOWLEDGE_NOTE);

        await sourceMessage.edit({
          content: renderAnswerContent(editedAnswer.answerText, {
            isVerified: editedAnswer.isVerified,
            usedVerifiedKnowledge,
            messageLimit: DISCORD_MESSAGE_LIMIT,
          }),
          components: buildAnswerComponents(
            answerId,
            totals,
            editedAnswer.isVerified,
          ),
        });

        await interaction.editReply(
          "Answer updated and saved to the audit history. It must be verified again before it is trusted knowledge.",
        );
      } catch (error) {
        logDatabaseError("Could not edit answer", error);
        await interaction.editReply(
          "I could not save that answer edit. Make sure the text changed and try again.",
        );
      }
    });
  }

  async function requireModeratorCommand(
    interaction: ChatInputCommandInteraction<"cached">,
  ): Promise<boolean> {
    try {
      if (
        await isConfiguredModerator(interaction.guild, interaction.user.id)
      ) {
        return true;
      }
    } catch (error) {
      console.error("Could not check the command moderator role:", error);
      await interaction.reply({
        content: "I could not check your moderator role right now.",
        flags: MessageFlags.Ephemeral,
      });
      return false;
    }

    await interaction.reply({
      content:
        "Only members with a configured Oracle moderator role can use this command.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  async function handleV5OracleCommand(
    interaction: ChatInputCommandInteraction<"cached">,
  ): Promise<void> {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (!group && subcommand === ORACLE_RESET_SUBCOMMAND_NAME) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const deleted = await questionUpdates.run(
          `${interaction.guildId}:${interaction.user.id}`,
          () =>
            database.clearConversation(
              interaction.guildId,
              interaction.user.id,
            ),
        );
        await interaction.editReply(
          deleted > 0
            ? "Your Karting Oracle conversation context has been cleared."
            : "You did not have any saved conversation context to clear.",
        );
      } catch (error) {
        logDatabaseError("Could not reset conversation", error);
        await interaction.editReply(
          "I could not clear your conversation context right now.",
        );
      }
      return;
    }

    if (
      group !== ORACLE_LIMIT_GROUP_NAME &&
      group !== ORACLE_KNOWLEDGE_GROUP_NAME
    ) {
      return;
    }

    if (!(await requireModeratorCommand(interaction))) {
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (group === ORACLE_LIMIT_GROUP_NAME) {
        if (subcommand === "daily" || subcommand === "off") {
          const dailyLimit =
            subcommand === "daily"
              ? interaction.options.getInteger("number", true)
              : null;
          const savedLimit = await database.setGuildDailyQuestionLimit(
            interaction.guildId,
            dailyLimit,
            interaction.user.id,
          );

          await interaction.editReply(
            savedLimit === undefined
              ? "Daily AI-question limits are now off for this server."
              : `Non-moderators may now ask ${savedLimit} AI question${savedLimit === 1 ? "" : "s"} per UTC day.`,
          );
          return;
        }

        const targetUser = interaction.options.getUser("user", true);
        let status: UserQuestionLimitStatus;

        if (subcommand === "user") {
          const personalLimit = interaction.options.getInteger("limit", true);
          status = await database.setUserDailyQuestionLimit(
            interaction.guildId,
            targetUser.id,
            personalLimit,
            interaction.user.id,
          );
        } else if (subcommand === "reset-user") {
          status = await database.resetUserDailyQuestionLimit(
            interaction.guildId,
            targetUser.id,
          );
        } else {
          status = await database.getUserQuestionLimitStatus(
            interaction.guildId,
            targetUser.id,
          );
        }

        const actionNotice =
          subcommand === "user"
            ? status.isBlocked
              ? `Question access blocked for **${targetUser.username}**.`
              : `Personal daily limit updated for **${targetUser.username}**.`
            : subcommand === "reset-user"
              ? `Personal daily-limit override removed for **${targetUser.username}**.`
              : undefined;
        const statusText = formatUserQuestionLimitStatus(
          targetUser.username,
          status,
        );

        await interaction.editReply(
          actionNotice ? `${actionNotice}\n\n${statusText}` : statusText,
        );
        return;
      }

      const rawCategory = interaction.options.getString("category");
      const category = rawCategory ?? undefined;

      if (category !== undefined && !isKnowledgeCategory(category)) {
        await interaction.editReply("That knowledge category is invalid.");
        return;
      }

      if (subcommand === "add") {
        if (!category) {
          await interaction.editReply("A knowledge category is required.");
          return;
        }

        const item = await database.createStructuredKnowledge({
          category,
          title: interaction.options.getString("title", true).trim(),
          content: interaction.options.getString("content", true).trim(),
          url: normalizeOptionalKnowledgeUrl(
            interaction.options.getString("url"),
          ),
          discordModeratorUserId: interaction.user.id,
        });
        await interaction.editReply(
          `Knowledge item added.\n\n${renderKnowledgeItem(item)}`.slice(
            0,
            DISCORD_MESSAGE_LIMIT,
          ),
        );
        return;
      }

      const id = interaction.options.getString("id");

      if (subcommand === "view") {
        if (id) {
          const item = await database.getStructuredKnowledge(id);
          await interaction.editReply(
            renderKnowledgeItem(item).slice(0, DISCORD_MESSAGE_LIMIT),
          );
          return;
        }

        const items = await database.listStructuredKnowledge(category, 10);
        const summary = items
          .map(
            (item) =>
              `${item.isActive === false ? "⚫" : "🟢"} **${item.title}** — ${KNOWLEDGE_CATEGORY_LABELS[item.category]}\n\`${item.id}\``,
          )
          .join("\n\n");
        await interaction.editReply(
          summary || "No structured knowledge items matched.",
        );
        return;
      }

      if (!id) {
        await interaction.editReply("A knowledge item ID is required.");
        return;
      }

      if (subcommand === "deactivate") {
        const item = await database.deactivateStructuredKnowledge(
          id,
          interaction.user.id,
        );
        await interaction.editReply(
          `Knowledge item deactivated.\n\n${renderKnowledgeItem(item)}`.slice(
            0,
            DISCORD_MESSAGE_LIMIT,
          ),
        );
        return;
      }

      if (subcommand === "edit") {
        const changes: UpdateStructuredKnowledgeInput = {};
        const title = interaction.options.getString("title");
        const content = interaction.options.getString("content");
        const rawUrl = interaction.options.getString("url");

        if (title !== null) changes.title = title.trim();
        if (content !== null) changes.content = content.trim();
        if (category !== undefined) changes.category = category;
        if (rawUrl !== null) {
          changes.url = normalizeOptionalKnowledgeUrl(rawUrl) ?? null;
        }

        if (Object.keys(changes).length === 0) {
          await interaction.editReply("Provide at least one field to change.");
          return;
        }

        const item = await database.updateStructuredKnowledge(
          id,
          changes,
          interaction.user.id,
        );
        await interaction.editReply(
          `Knowledge item updated.\n\n${renderKnowledgeItem(item)}`.slice(
            0,
            DISCORD_MESSAGE_LIMIT,
          ),
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      const isValidationError = detail.includes("URL");

      if (!isValidationError) {
        logDatabaseError("Oracle command failed", error);
      }

      await interaction.editReply(
        isValidationError
          ? detail
          : "I could not complete that Oracle command right now.",
      );
    }
  }

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const feedbackButton = feedbackButtonFromCustomId(interaction.customId);

    if (interaction.message.author.id !== client.user?.id) {
      return;
    }

    if (feedbackButton) {
      void handleFeedbackButton(
        interaction,
        feedbackButton.answerId,
        feedbackButton.vote,
      ).catch((error: unknown) => {
        console.error("Could not record feedback:", error);

        const errorMessage = "Sorry, I could not record your feedback right now.";
        const sendError = interaction.deferred || interaction.replied
          ? interaction.editReply(errorMessage)
          : interaction.reply({
              content: errorMessage,
              flags: MessageFlags.Ephemeral,
            });

        void sendError.catch((replyError: unknown) => {
          console.error("Could not send the feedback error message:", replyError);
        });
      });
      return;
    }

    const answerEditId = answerEditIdFromCustomId(interaction.customId);

    if (answerEditId) {
      void handleAnswerEditButton(interaction, answerEditId).catch(
        (error: unknown) => {
          console.error("Could not open answer editing:", error);
        },
      );
      return;
    }

    const verificationButton = verificationButtonFromCustomId(
      interaction.customId,
    );

    if (!verificationButton) {
      return;
    }

    void handleVerificationButton(
      interaction,
      verificationButton.answerId,
      verificationButton.action,
    ).catch((error: unknown) => {
      console.error("Could not handle answer verification:", error);

      const errorMessage =
        "Sorry, I could not update answer verification right now.";
      const sendError = interaction.deferred || interaction.replied
        ? interaction.editReply(errorMessage)
        : interaction.reply({
            content: errorMessage,
            flags: MessageFlags.Ephemeral,
          });

      void sendError.catch((replyError: unknown) => {
        console.error("Could not send the verification error message:", replyError);
      });
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isModalSubmit() || !interaction.inCachedGuild()) {
      return;
    }

    const answerId = answerEditIdFromCustomId(interaction.customId);

    if (!answerId) {
      return;
    }

    void handleAnswerEditModal(interaction, answerId).catch(
      (error: unknown) => {
        console.error("Could not handle answer editing:", error);
      },
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== ORACLE_COMMAND_NAME ||
      !interaction.inCachedGuild()
    ) {
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);
    const isReset =
      group === null && subcommand === ORACLE_RESET_SUBCOMMAND_NAME;
    const isModeratorCommand =
      group === ORACLE_LIMIT_GROUP_NAME ||
      group === ORACLE_KNOWLEDGE_GROUP_NAME;

    if (!isReset && !isModeratorCommand) {
      return;
    }

    void handleV5OracleCommand(interaction).catch((error: unknown) => {
      console.error("Could not handle the V5 Oracle command:", error);
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== ORACLE_COMMAND_NAME ||
      !isOracleSetupCommand(
        interaction.commandName,
        interaction.options.getSubcommand(false),
      ) ||
      !interaction.inCachedGuild()
    ) {
      return;
    }

    void (async () => {
      let canConfigure: boolean;

      try {
        canConfigure = await canUserConfigureOracleChannel(
          interaction.guild,
          interaction.user.id,
          interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild),
        );
      } catch (error) {
        console.error("Could not check Oracle setup permissions:", error);
        await interaction.reply({
          content:
            "I could not check your Oracle setup permissions right now. Please try again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!canConfigure) {
        await interaction.reply({
          content:
            "Only members with Manage Server or a configured moderator role can change the Oracle channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      let defaultChannelId: string | undefined;

      try {
        defaultChannelId = await inspectOracleChannelSelector(
          interaction.guild,
        );
      } catch (error) {
        console.error(
          "Could not collect fresh Oracle channel selector diagnostics:",
          error,
        );
      }

      const selector = buildOracleChannelSelector(defaultChannelId);
      const selectorJson = selector.toJSON();
      const component = selectorJson.components[0];

      console.log(
        `Oracle setup handler executed: ${JSON.stringify({
          handlerVersion: ORACLE_SETUP_HANDLER_VERSION,
          guildId: interaction.guildId,
          command: `/${interaction.commandName} ${interaction.options.getSubcommand(false)}`,
          actionRowComponentType: selectorJson.type,
          selectorComponentType: component?.type,
          expectedNativeChannelSelectType: 8,
          hasStaticOptions:
            component !== undefined && "options" in component,
        })}`,
      );

      await interaction.reply({
        content:
          "Choose the text channel Karting Oracle should read and reply in. The selection will only be saved if the bot currently has all required permissions.",
        components: [selector],
        flags: MessageFlags.Ephemeral,
      });
    })().catch((error: unknown) => {
      console.error(
        `Could not run /${ORACLE_COMMAND_NAME} ${ORACLE_SETUP_SUBCOMMAND_NAME}:`,
        error,
      );
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (
      !interaction.isChannelSelectMenu() ||
      interaction.customId !== ORACLE_CHANNEL_SELECT_CUSTOM_ID ||
      !interaction.inCachedGuild()
    ) {
      return;
    }

    void (async () => {
      let canConfigure: boolean;

      try {
        canConfigure = await canUserConfigureOracleChannel(
          interaction.guild,
          interaction.user.id,
          interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild),
        );
      } catch (error) {
        console.error("Could not check Oracle setup permissions:", error);
        await interaction.reply({
          content:
            "I could not check your Oracle setup permissions right now. Please try again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!canConfigure) {
        await interaction.reply({
          content:
            "Only members with Manage Server or a configured moderator role can change the Oracle channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferUpdate();

      try {
        const selectedChannelId = interaction.values[0];
        const selectedChannel = selectedChannelId
          ? await interaction.guild.channels.fetch(selectedChannelId, {
              force: true,
            })
          : null;
        const botMember = await interaction.guild.members.fetchMe({ force: true });
        const missingPermissions = missingOracleChannelPermissions(
          selectedChannel,
          botMember,
        );

        if (!selectedChannel || missingPermissions.length > 0) {
          await interaction.editReply({
            content: `I cannot save that channel. Karting Oracle is missing: **${missingPermissions.join(
              "**, **",
            )}**. Update the channel permissions, then choose it again.`,
            components: [
              buildOracleChannelSelector(channelConfig.get(interaction.guildId)),
            ],
          });
          return;
        }

        if (!canBotUseOracleChannel(selectedChannel, botMember)) {
          await interaction.editReply({
            content:
              "I cannot save that channel because its current permissions are insufficient.",
            components: [
              buildOracleChannelSelector(channelConfig.get(interaction.guildId)),
            ],
          });
          return;
        }

        await channelConfig.set(interaction.guildId, selectedChannel.id);
        promptedGuildIds.add(interaction.guildId);

        await interaction.editReply({
          content: `\u2705 Karting Oracle channel set to #${selectedChannel.name}`,
          components: [],
        });
        console.log(
          `Configured #${selectedChannel.name} as the Oracle channel for ${interaction.guild.name}.`,
        );
      } catch (error) {
        console.error("Could not save the selected Oracle channel:", error);
        await interaction
          .editReply({
            content:
              "I could not save that channel. Check the bot permissions and try again.",
            components: [
              buildOracleChannelSelector(channelConfig.get(interaction.guildId)),
            ],
          })
          .catch(() => undefined);
      }
    })().catch((error: unknown) => {
      console.error("Could not handle the channel selection:", error);
    });
  });

  client.on(Events.ChannelDelete, (channel) => {
    if (channel.isDMBased()) {
      return;
    }

    if (channelConfig.get(channel.guild.id) !== channel.id) {
      return;
    }

    void (async () => {
      await channelConfig.delete(channel.guild.id);
      promptedGuildIds.delete(channel.guild.id);
      await promptForChannel(channel.guild);
    })().catch((error: unknown) => {
      console.error(`Could not reconfigure ${channel.guild.name}:`, error);
    });
  });

  client.on(Events.GuildDelete, (guild) => {
    promptedGuildIds.delete(guild.id);
    promptingGuildIds.delete(guild.id);

    void channelConfig.delete(guild.id).catch((error: unknown) => {
      console.error(`Could not remove the saved configuration for ${guild.name}:`, error);
    });
  });

  async function handleOracleMessage(message: Message<true>): Promise<void> {
    const prompt = message.content.trim();
    const pendingClarification = pendingClarifications.get(
      message.guildId,
      message.author.id,
    );
    const clarificationResolution = resolvePendingClarification(
      pendingClarification,
      prompt,
    );
    const effectivePrompt = clarificationResolution.effectiveQuestion;
    const sendFailure = async (content: string): Promise<void> => {
      await message
        .reply({
          content,
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : "Unknown error";
          console.error(`Failed to send a Discord error message: ${detail}`);
        });
    };

    const initialTopic = classifyTopic(
      effectivePrompt,
      Boolean(pendingClarification),
      false,
    );

    if (initialTopic === "obviously_off_topic") {
      await sendFailure(OFF_TOPIC_RESPONSE);
      return;
    }

    let isModerator: boolean;

    try {
      isModerator = await isConfiguredModerator(
        message.guild,
        message.author.id,
      );
    } catch (error) {
      console.error("Could not check the question author's moderator role:", error);
      await sendFailure(
        "Sorry, I could not check your question allowance right now. Please try again.",
      );
      return;
    }

    let reservation: DailyQuestionReservation | undefined;

    if (
      shouldReserveDailyQuestion(
        isModerator,
        clarificationResolution.isClarificationReply,
      )
    ) {
      try {
        reservation = await database.reserveDailyQuestion(
          message.guildId,
          message.author.id,
        );
      } catch (error) {
        logDatabaseError("Could not check the daily question allowance", error);
        await sendFailure(
          "Sorry, I could not check your daily question allowance right now. Please try again.",
        );
        return;
      }

      if (!reservation.allowed) {
        await sendFailure(
          reservation.dailyLimit === 0
            ? BLOCKED_QUESTION_MESSAGE
            : limitReachedMessage(reservation.dailyLimit ?? 0),
        );
        return;
      }
    }

    const releaseReservation = async (): Promise<void> => {
      if (!reservation?.allowed) {
        return;
      }

      try {
        await database.releaseDailyQuestion(
          message.guildId,
          message.author.id,
        );
      } catch (error) {
        logDatabaseError("Could not release daily question reservation", error);
      }
    };

    const completeReservation = async (): Promise<boolean> => {
      if (!reservation?.allowed) {
        return true;
      }

      let completionError: unknown;

      for (const retryDelay of [0, 250, 1_000]) {
        if (retryDelay > 0) {
          await wait(retryDelay);
        }

        try {
          await database.completeDailyQuestion(
            message.guildId,
            message.author.id,
          );
          completionError = undefined;
          break;
        } catch (error) {
          completionError = error;
        }
      }

      if (completionError) {
        logDatabaseError(
          "Could not finalize successful daily question usage",
          completionError,
        );
        return false;
      }

      return true;
    };

    const intent = clarificationResolution.isClarificationReply
      ? "genuine"
      : classifyGenuineKartingIntent(effectivePrompt);

    if (intent === "obvious_nonsense") {
      if (
        NONSENSE_PROCESSING_PLAN.consumeReservedQuestion &&
        !(await completeReservation())
      ) {
        await sendFailure(
          "Sorry, I could not update your daily question allowance right now. Please try again.",
        );
        return;
      }

      await sendFailure(formatNonsenseResponse(reservation));
      return;
    }

    let history: ConversationMessage[];

    try {
      const storedHistory = await database.getConversationHistory(
        message.guildId,
        message.author.id,
        conversationLimits.maxMessages * 2,
      );
      history = selectConversationContext(
        storedHistory,
        message.guildId,
        message.author.id,
        conversationLimits,
      );
    } catch (error) {
      logDatabaseError("Could not load conversation history", error);
      await releaseReservation();
      await sendFailure(
        "Sorry, I could not load your conversation context right now. Please try again in a moment.",
      );
      return;
    }

    const [verifiedKnowledge, structuredKnowledge] = await Promise.all([
      database.searchVerifiedKnowledge(effectivePrompt, 3).catch((error: unknown) => {
        logDatabaseError(
          "Verified knowledge search failed; answering without it",
          error,
        );
        return [] as VerifiedKnowledge[];
      }),
      database.searchStructuredKnowledge(effectivePrompt, 4).catch((error: unknown) => {
        logDatabaseError(
          "Structured knowledge search failed; answering without it",
          error,
        );
        return [];
      }),
    ]);

    const topic = classifyTopic(
      effectivePrompt,
      history.length > 0,
      verifiedKnowledge.length > 0 || structuredKnowledge.length > 0,
    );

    if (topic === "obviously_off_topic") {
      await releaseReservation();
      await sendFailure(OFF_TOPIC_RESPONSE);
      return;
    }

    let oracleAnswer: OracleAnswer;

    try {
      const clarificationContext = pendingClarification
        ? {
            mustResumeOriginal: clarificationResolution.resolved,
            previousClarifications: pendingClarification.askedClarifications,
          }
        : undefined;
      oracleAnswer = await withTypingIndicator(
        () => message.channel.sendTyping(),
        async () => {
          let generated = await generateOracleAnswer(
            effectivePrompt,
            verifiedKnowledge,
            structuredKnowledge,
            history,
            clarificationContext,
          );

          if (
            pendingClarification &&
            generated.clarification &&
            isRepeatedClarification(
              pendingClarification,
              generated.clarification,
            )
          ) {
            console.warn(
              `[clarification] repeated=true guild_id=${message.guildId} user_id=${message.author.id}`,
            );
            generated = await generateOracleAnswer(
              `${effectivePrompt}\nThe previous attempt repeated an already-answered clarification. Give the best supported answer to the original question now.`,
              verifiedKnowledge,
              structuredKnowledge,
              history,
              {
                mustResumeOriginal: true,
                previousClarifications:
                  pendingClarification.askedClarifications,
              },
            );

            if (
              generated.clarification &&
              isRepeatedClarification(
                pendingClarification,
                generated.clarification,
              )
            ) {
              throw new Error(
                "OpenAI repeated an already-resolved clarification twice.",
              );
            }
          }

          return generated;
        },
      );
    } catch (error) {
      console.error(
        `[openai] answer_generation=failed error=${safeErrorDetails(error)}`,
      );
      await releaseReservation();
      await sendFailure("Sorry, I could not get an AI response right now.");
      return;
    }

    if (!oracleAnswer.isKartingRelated) {
      await releaseReservation();
      await sendFailure(OFF_TOPIC_RESPONSE);
      return;
    }

    let questionId: string;

    try {
      questionId = await database.saveQuestion({
        discordMessageId: message.id,
        discordGuildId: message.guildId,
        discordUserId: message.author.id,
        questionText: effectivePrompt,
      });
    } catch (error) {
      logDatabaseError("Could not save the Discord question", error);
      await releaseReservation();
      await sendFailure(
        "Sorry, I could not save your question right now. Please try again in a moment.",
      );
      return;
    }

    const answerId = randomUUID();
    let totals: VoteTotals;
    let conversationSaved = false;

    try {
      await database.createAnswer({
        id: answerId,
        questionId,
        answerText: oracleAnswer.text,
      });
      totals = await database.getVoteTotals(answerId);
      await database.appendConversationExchange({
        discordGuildId: message.guildId,
        discordUserId: message.author.id,
        questionId,
        answerId,
        questionText: effectivePrompt,
        answerText: oracleAnswer.text,
      });
      conversationSaved = true;
    } catch (error) {
      logDatabaseError("Could not save the AI answer", error);
      await database.deleteAnswer(answerId).catch((rollbackError: unknown) => {
        logDatabaseError("Could not roll back the unsent AI answer", rollbackError);
      });
      await releaseReservation();
      await sendFailure(
        "Sorry, I generated an answer but could not save it. Please try again in a moment.",
      );
      return;
    }

    let answerContent = renderAnswerContent(oracleAnswer.text, {
      isVerified: false,
      usedVerifiedKnowledge: oracleAnswer.usedVerifiedKnowledge,
      messageLimit: DISCORD_MESSAGE_LIMIT,
    });
    const remainingNotice = reservation
      ? formatRemainingQuestions(reservation)
      : undefined;

    if (remainingNotice) {
      const maximumAnswerLength =
        DISCORD_MESSAGE_LIMIT - remainingNotice.length - 2;
      answerContent = `${answerContent.slice(0, maximumAnswerLength).trimEnd()}\n\n${remainingNotice}`;
    }

    const discordReply = await message
      .reply({
        content: answerContent,
        components: buildAnswerComponents(answerId, totals, false),
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(async (error: unknown) => {
        const detail = error instanceof Error ? error.message : "Unknown error";
        console.error(`Failed to send the Discord answer: ${detail}`);
        if (conversationSaved) {
          await database
            .deleteConversationExchange(questionId, answerId)
            .catch((rollbackError: unknown) => {
              logDatabaseError(
                "Could not roll back the unsent conversation exchange",
                rollbackError,
              );
            });
        }
        await database.deleteAnswer(answerId).catch((rollbackError: unknown) => {
          logDatabaseError("Could not roll back the unsent AI answer", rollbackError);
        });
        await releaseReservation();
        return undefined;
      });

    if (!discordReply) {
      return;
    }

    if (oracleAnswer.clarification) {
      const nextPending = pendingClarification
        ? updatePendingClarification(
            pendingClarification,
            oracleAnswer.clarification,
          )
        : createPendingClarification(prompt, oracleAnswer.clarification);
      pendingClarifications.set(
        message.guildId,
        message.author.id,
        nextPending,
      );
      console.log(
        `[clarification] pending=true guild_id=${message.guildId} user_id=${message.author.id}`,
      );
    } else if (pendingClarification) {
      pendingClarifications.clear(message.guildId, message.author.id);
      console.log(
        `[clarification] resolved=true guild_id=${message.guildId} user_id=${message.author.id}`,
      );
    }

    await completeReservation();

    let attachmentError: unknown;

    for (const retryDelay of [0, 250, 1_000]) {
      if (retryDelay > 0) {
        await wait(retryDelay);
      }

      try {
        await database.attachDiscordMessageId(answerId, discordReply.id);
        attachmentError = undefined;
        break;
      } catch (error) {
        attachmentError = error;
      }
    }

    if (attachmentError) {
      logDatabaseError(
        "Could not attach the Discord message ID after three attempts",
        attachmentError,
      );
    }
  }

  client.on(Events.MessageCreate, (message) => {
    const prompt = message.content.trim();

    if (message.author.bot || !message.inGuild() || prompt.length === 0) {
      return;
    }

    const oracleChannelId = channelConfig.get(message.guildId);

    if (!oracleChannelId || message.channelId !== oracleChannelId) {
      return;
    }

    void questionUpdates
      .run(`${message.guildId}:${message.author.id}`, () =>
        handleOracleMessage(message),
      )
      .catch((error: unknown) => {
        console.error("Could not process the Oracle question:", error);
      });
  });

  await client.login(discordToken);
}

main().catch((error: unknown) => {
  console.error("Bot failed to start:", error);
  process.exitCode = 1;
});
