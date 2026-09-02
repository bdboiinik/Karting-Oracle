import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildBasedChannel,
  type GuildMember,
  type TextChannel,
} from "discord.js";

import { memberHasModeratorRole } from "./moderator-roles.js";
import {
  IGNORE_MESSAGE_MAX_LENGTH,
  IGNORE_MESSAGE_OPTION_NAME,
  ORACLE_IGNORE_SUBCOMMAND_NAME,
} from "./ignore-command.js";
import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CATEGORY_LABELS,
} from "./structured-knowledge.js";

export const ORACLE_COMMAND_NAME = "oracle";
export const ORACLE_SETUP_SUBCOMMAND_NAME = "setup";
export const ORACLE_RESET_SUBCOMMAND_NAME = "reset";
export const ORACLE_LIMIT_GROUP_NAME = "limit";
export const ORACLE_KNOWLEDGE_GROUP_NAME = "knowledge";
export const ORACLE_SETUP_COMMAND_DESCRIPTION =
  "Choose the text channel Karting Oracle should read and reply in.";
export const ORACLE_CHANNEL_SELECT_CUSTOM_ID = "karting-oracle-channel";
export const ORACLE_SETUP_HANDLER_VERSION = "native-channel-select-v2";
export const LEGACY_ORACLE_SETUP_COMMAND_NAME = "oracle-setup";

export interface OracleChannelDiagnostic {
  id: string;
  name: string;
  type: ChannelType;
  isGuildText: boolean;
  isConfigured: boolean;
}

const REQUIRED_CHANNEL_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
  { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
] as const;

export function buildOracleChannelSelector(
  defaultChannelId?: string,
): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(ORACLE_CHANNEL_SELECT_CUSTOM_ID)
    .setPlaceholder("Choose the Karting Oracle channel")
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);

  if (defaultChannelId) {
    channelSelect.setDefaultChannels(defaultChannelId);
  }

  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    channelSelect,
  );
}

export function buildOracleCommand() {
  const categoryChoices = KNOWLEDGE_CATEGORIES.map((category) => ({
    name: KNOWLEDGE_CATEGORY_LABELS[category],
    value: category,
  }));

  return new SlashCommandBuilder()
    .setName(ORACLE_COMMAND_NAME)
    .setDescription("Configure Karting Oracle.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName(ORACLE_SETUP_SUBCOMMAND_NAME)
        .setDescription(ORACLE_SETUP_COMMAND_DESCRIPTION),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName(ORACLE_RESET_SUBCOMMAND_NAME)
        .setDescription("Clear your own Karting Oracle conversation context."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName(ORACLE_IGNORE_SUBCOMMAND_NAME)
        .setDescription("Post a normal chat message without asking Oracle.")
        .addStringOption((option) =>
          option
            .setName(IGNORE_MESSAGE_OPTION_NAME)
            .setDescription("Message to post publicly in the Oracle channel.")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(IGNORE_MESSAGE_MAX_LENGTH),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName(ORACLE_LIMIT_GROUP_NAME)
        .setDescription("Configure the daily AI-question allowance.")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("daily")
            .setDescription("Set the daily AI-question limit for non-moderators.")
            .addIntegerOption((option) =>
              option
                .setName("number")
                .setDescription("Questions allowed per user per UTC day.")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(1_000),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("off")
            .setDescription("Disable the daily AI-question limit."),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("user")
            .setDescription("Set one user's personal daily question limit.")
            .addUserOption((option) =>
              option
                .setName("user")
                .setDescription("User whose personal limit should change.")
                .setRequired(true),
            )
            .addIntegerOption((option) =>
              option
                .setName("limit")
                .setDescription("Personal questions per UTC day; 0 blocks access.")
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(1_000),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("reset-user")
            .setDescription("Remove a user's personal daily-limit override.")
            .addUserOption((option) =>
              option
                .setName("user")
                .setDescription("User who should return to the server default.")
                .setRequired(true),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("status")
            .setDescription("Inspect one user's effective daily allowance.")
            .addUserOption((option) =>
              option
                .setName("user")
                .setDescription("User whose allowance should be shown.")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName(ORACLE_KNOWLEDGE_GROUP_NAME)
        .setDescription("Manage authoritative Karting Oracle knowledge.")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("add")
            .setDescription("Add an authoritative knowledge item.")
            .addStringOption((option) =>
              option
                .setName("category")
                .setDescription("Knowledge category.")
                .setRequired(true)
                .addChoices(...categoryChoices),
            )
            .addStringOption((option) =>
              option
                .setName("title")
                .setDescription("Short descriptive title.")
                .setRequired(true)
                .setMaxLength(100),
            )
            .addStringOption((option) =>
              option
                .setName("content")
                .setDescription("Authoritative information to store.")
                .setRequired(true)
                .setMaxLength(1_800),
            )
            .addStringOption((option) =>
              option
                .setName("url")
                .setDescription("Optional HTTP/HTTPS URL.")
                .setMaxLength(500),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("edit")
            .setDescription("Edit an existing knowledge item.")
            .addStringOption((option) =>
              option
                .setName("id")
                .setDescription("Knowledge item UUID.")
                .setRequired(true),
            )
            .addStringOption((option) =>
              option
                .setName("category")
                .setDescription("Replacement category.")
                .addChoices(...categoryChoices),
            )
            .addStringOption((option) =>
              option
                .setName("title")
                .setDescription("Replacement title.")
                .setMaxLength(100),
            )
            .addStringOption((option) =>
              option
                .setName("content")
                .setDescription("Replacement authoritative content.")
                .setMaxLength(1_800),
            )
            .addStringOption((option) =>
              option
                .setName("url")
                .setDescription("Replacement URL, or 'none' to clear it.")
                .setMaxLength(500),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("view")
            .setDescription("View one item or the latest knowledge items.")
            .addStringOption((option) =>
              option.setName("id").setDescription("Optional knowledge item UUID."),
            )
            .addStringOption((option) =>
              option
                .setName("category")
                .setDescription("Optional category filter.")
                .addChoices(...categoryChoices),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("deactivate")
            .setDescription("Deactivate a knowledge item.")
            .addStringOption((option) =>
              option
                .setName("id")
                .setDescription("Knowledge item UUID.")
                .setRequired(true),
            ),
        ),
    );
}

export function isOracleSetupCommand(
  commandName: string,
  subcommandName: string | null,
): boolean {
  return (
    commandName === ORACLE_COMMAND_NAME &&
    subcommandName === ORACLE_SETUP_SUBCOMMAND_NAME
  );
}

export function buildOracleChannelDiagnostics(
  channels: Iterable<GuildBasedChannel | null>,
  configuredChannelId?: string,
): OracleChannelDiagnostic[] {
  return Array.from(channels)
    .filter((channel): channel is GuildBasedChannel => channel !== null)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      isGuildText: channel.type === ChannelType.GuildText,
      isConfigured: channel.id === configuredChannelId,
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

export function missingOracleChannelPermissions(
  channel: GuildBasedChannel | null | undefined,
  botMember: GuildMember,
): string[] {
  if (channel?.type !== ChannelType.GuildText) {
    return ["a standard server text channel"];
  }

  const permissions = channel.permissionsFor(botMember);

  return REQUIRED_CHANNEL_PERMISSIONS.filter(
    ({ flag }) => !permissions.has(flag),
  ).map(({ label }) => label);
}

export function canBotUseOracleChannel(
  channel: GuildBasedChannel | null | undefined,
  botMember: GuildMember,
): channel is TextChannel {
  return missingOracleChannelPermissions(channel, botMember).length === 0;
}

export function canMemberConfigureOracleChannel(
  memberRoleIds: Iterable<string>,
  moderatorRoleIds: ReadonlySet<string>,
  hasManageGuildPermission: boolean,
): boolean {
  return (
    hasManageGuildPermission ||
    memberHasModeratorRole(memberRoleIds, moderatorRoleIds)
  );
}
