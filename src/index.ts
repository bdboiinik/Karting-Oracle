import "dotenv/config";

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import OpenAI from "openai";

import {
  renderAnswerContent,
  updateVerificationPresentation,
} from "./answer-presentation.js";
import { ChannelConfigStore } from "./channel-config-store.js";
import {
  buildFeedbackButtons,
  feedbackButtonFromCustomId,
  KeyedSerialQueue,
} from "./feedback.js";
import type { RecordedVote, VoteTotals, VoteType } from "./feedback-types.js";
import {
  buildOracleInput,
  ORACLE_INSTRUCTIONS,
  ORACLE_RESPONSE_FORMAT,
  parseOracleResponse,
  type OracleAnswer,
} from "./oracle-response.js";
import {
  isMissingAnswerError,
  SupabasePersistenceError,
  SupabaseService,
  type AnswerVerification,
  type VerifiedKnowledge,
} from "./supabase-service.js";
import {
  buildVerificationButton,
  type VerificationAction,
  verificationButtonFromCustomId,
} from "./verification.js";

const DISCORD_MESSAGE_LIMIT = 2_000;
const OPENAI_MODEL = "gpt-5-mini";
const OPENAI_OUTPUT_TOKEN_LIMITS = [1_500, 2_500] as const;
const CHANNEL_SELECT_CUSTOM_ID = "karting-oracle-channel";
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const CHANNEL_CONFIG_PATH = fileURLToPath(
  new URL("../data/guild-config.json", import.meta.url),
);
const REQUIRED_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
] as const;

const requiredEnvironmentVariables = [
  "DISCORD_TOKEN",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "MODERATOR_ROLE_ID",
] as const;

type EnvironmentVariable = (typeof requiredEnvironmentVariables)[number];

function readEnvironmentVariable(name: EnvironmentVariable): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function canBotUseChannel(
  channel: GuildBasedChannel | null | undefined,
  botMember: GuildMember,
): channel is TextChannel {
  return (
    channel?.type === ChannelType.GuildText &&
    channel.permissionsFor(botMember).has(REQUIRED_CHANNEL_PERMISSIONS)
  );
}

function buildChannelSelector(): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(CHANNEL_SELECT_CUSTOM_ID)
    .setPlaceholder("Choose the Karting Oracle channel")
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);

  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect);
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

async function main(): Promise<void> {
  const discordToken = readEnvironmentVariable("DISCORD_TOKEN");
  const openaiApiKey = readEnvironmentVariable("OPENAI_API_KEY");
  const supabaseUrl = readEnvironmentVariable("SUPABASE_URL");
  const supabaseServiceRoleKey = readEnvironmentVariable(
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const moderatorRoleId = readEnvironmentVariable("MODERATOR_ROLE_ID");

  if (!DISCORD_SNOWFLAKE_PATTERN.test(moderatorRoleId)) {
    throw new Error("MODERATOR_ROLE_ID must be a valid Discord role ID.");
  }

  const channelConfig = new ChannelConfigStore(CHANNEL_CONFIG_PATH);
  const answerUpdates = new KeyedSerialQueue();
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
  ): Promise<OracleAnswer> {
    for (const maxOutputTokens of OPENAI_OUTPUT_TOKEN_LIMITS) {
      const response = await openai.responses.create({
        model: OPENAI_MODEL,
        instructions: ORACLE_INSTRUCTIONS,
        input: buildOracleInput(prompt, verifiedKnowledge),
        max_output_tokens: maxOutputTokens,
        text: {
          format: ORACLE_RESPONSE_FORMAT,
        },
      });

      const responseText = response.output_text.trim();

      if (responseText) {
        try {
          return parseOracleResponse(
            responseText,
            verifiedKnowledge.length > 0,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Invalid output";
          console.warn(`Could not parse the OpenAI response: ${detail}`);
          continue;
        }
      }

      console.warn(
        [
          "OpenAI returned no visible text",
          `status=${response.status}`,
          `reason=${response.incomplete_details?.reason ?? "none"}`,
          `output_tokens=${response.usage?.output_tokens ?? "unknown"}`,
          `reasoning_tokens=${response.usage?.output_tokens_details.reasoning_tokens ?? "unknown"}`,
        ].join(", "),
      );
    }

    throw new Error("OpenAI returned no visible text after retrying.");
  }

  function buildAnswerComponents(
    answerId: string,
    totals: VoteTotals,
    isVerified: boolean,
  ) {
    return [
      buildFeedbackButtons(answerId, totals),
      buildVerificationButton(answerId, isVerified),
    ];
  }

  async function findPromptChannel(guild: Guild): Promise<TextChannel | undefined> {
    await guild.channels.fetch();
    const botMember = guild.members.me ?? (await guild.members.fetchMe());

    if (canBotUseChannel(guild.systemChannel, botMember)) {
      return guild.systemChannel;
    }

    const availableChannels = guild.channels.cache
      .filter((channel): channel is TextChannel =>
        canBotUseChannel(channel, botMember),
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
          "Thanks for adding Karting Oracle! A server administrator can choose the one text channel I should read and reply in:",
        components: [buildChannelSelector()],
        allowedMentions: { parse: [] },
      });

      promptedGuildIds.add(guild.id);
      console.log(`Asked ${guild.name} to choose an Oracle channel in #${promptChannel.name}.`);
    } finally {
      promptingGuildIds.delete(guild.id);
    }
  }

  async function ensureGuildConfiguration(guild: Guild): Promise<void> {
    const configuredChannelId = channelConfig.get(guild.id);

    if (configuredChannelId) {
      await guild.channels.fetch();
      const configuredChannel = guild.channels.cache.get(configuredChannelId);
      const botMember = guild.members.me ?? (await guild.members.fetchMe());

      if (canBotUseChannel(configuredChannel, botMember)) {
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
          await ensureGuildConfiguration(guild);
        } catch (error) {
          console.error(`Could not configure ${guild.name}:`, error);
        }
      }
    })();
  });

  client.on(Events.GuildCreate, (guild) => {
    void ensureGuildConfiguration(guild).catch((error: unknown) => {
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

    let member: GuildMember;

    try {
      member = await interaction.guild.members.fetch(interaction.user.id);
    } catch (error) {
      console.error("Could not check the moderator role:", error);
      await interaction.editReply(
        "I could not check your moderator role right now. Please try again.",
      );
      return;
    }

    if (!member.roles.cache.has(moderatorRoleId)) {
      await interaction.editReply(
        "Only members with the configured moderator role can verify answers.",
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
    if (
      !interaction.isChannelSelectMenu() ||
      interaction.customId !== CHANNEL_SELECT_CUSTOM_ID ||
      !interaction.inCachedGuild()
    ) {
      return;
    }

    void (async () => {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: "Only a server administrator can choose the Oracle channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const selectedChannelId = interaction.values[0];
        const selectedChannel = selectedChannelId
          ? await interaction.guild.channels.fetch(selectedChannelId)
          : null;
        const botMember =
          interaction.guild.members.me ??
          (await interaction.guild.members.fetchMe());

        if (!canBotUseChannel(selectedChannel, botMember)) {
          await interaction.editReply(
            "I need View Channel, Send Messages, and Read Message History permissions in that text channel.",
          );
          return;
        }

        await channelConfig.set(interaction.guildId, selectedChannel.id);
        promptedGuildIds.add(interaction.guildId);

        await interaction.editReply(
          `Configured ${selectedChannel}. I will only read and reply in that channel. You can use the menu again to change it.`,
        );
        console.log(
          `Configured #${selectedChannel.name} as the Oracle channel for ${interaction.guild.name}.`,
        );
      } catch (error) {
        console.error("Could not save the selected Oracle channel:", error);
        await interaction
          .editReply("I could not save that channel. Please try again.")
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

  client.on(Events.MessageCreate, async (message) => {
    const prompt = message.content.trim();

    if (message.author.bot || !message.inGuild() || prompt.length === 0) {
      return;
    }

    const oracleChannelId = channelConfig.get(message.guildId);

    if (!oracleChannelId || message.channelId !== oracleChannelId) {
      return;
    }

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

    let questionId: string;

    try {
      questionId = await database.saveQuestion({
        discordMessageId: message.id,
        discordUserId: message.author.id,
        questionText: prompt,
      });
    } catch (error) {
      logDatabaseError("Could not save the Discord question", error);
      await sendFailure(
        "Sorry, I could not save your question right now. Please try again in a moment.",
      );
      return;
    }

    await message.channel.sendTyping().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "Unknown error";
      console.error(`Could not send the typing indicator: ${detail}`);
    });

    let verifiedKnowledge: VerifiedKnowledge[] = [];

    try {
      verifiedKnowledge = await database.searchVerifiedKnowledge(prompt, 3);
    } catch (error) {
      logDatabaseError(
        "Verified knowledge search failed; answering without it",
        error,
      );
    }

    let oracleAnswer: OracleAnswer;

    try {
      oracleAnswer = await generateOracleAnswer(prompt, verifiedKnowledge);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      console.error(`Failed to get an OpenAI response: ${detail}`);
      await sendFailure("Sorry, I could not get an AI response right now.");
      return;
    }

    const answerId = randomUUID();
    let totals: VoteTotals;

    try {
      await database.createAnswer({
        id: answerId,
        questionId,
        answerText: oracleAnswer.text,
      });
      totals = await database.getVoteTotals(answerId);
    } catch (error) {
      logDatabaseError("Could not save the AI answer", error);
      await database.deleteAnswer(answerId).catch((rollbackError: unknown) => {
        logDatabaseError("Could not roll back the unsent AI answer", rollbackError);
      });
      await sendFailure(
        "Sorry, I generated an answer but could not save it. Please try again in a moment.",
      );
      return;
    }

    const discordReply = await message
      .reply({
        content: renderAnswerContent(oracleAnswer.text, {
          isVerified: false,
          usedVerifiedKnowledge: oracleAnswer.usedVerifiedKnowledge,
          messageLimit: DISCORD_MESSAGE_LIMIT,
        }),
        components: buildAnswerComponents(answerId, totals, false),
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(async (error: unknown) => {
        const detail = error instanceof Error ? error.message : "Unknown error";
        console.error(`Failed to send the Discord answer: ${detail}`);
        await database.deleteAnswer(answerId).catch((rollbackError: unknown) => {
          logDatabaseError("Could not roll back the unsent AI answer", rollbackError);
        });
        return undefined;
      });

    if (!discordReply) {
      return;
    }

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
  });

  await client.login(discordToken);
}

main().catch((error: unknown) => {
  console.error("Bot failed to start:", error);
  process.exitCode = 1;
});
