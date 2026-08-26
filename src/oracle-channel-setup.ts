import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  type GuildBasedChannel,
  type GuildMember,
  type TextChannel,
} from "discord.js";

import { memberHasModeratorRole } from "./moderator-roles.js";

export const ORACLE_SETUP_COMMAND_NAME = "oracle-setup";
export const ORACLE_SETUP_COMMAND_DESCRIPTION =
  "Choose the text channel Karting Oracle should read and reply in.";
export const ORACLE_CHANNEL_SELECT_CUSTOM_ID = "karting-oracle-channel";

const REQUIRED_CHANNEL_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
  { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
] as const;

export function buildOracleChannelSelector(): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(ORACLE_CHANNEL_SELECT_CUSTOM_ID)
    .setPlaceholder("Choose the Karting Oracle channel")
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);

  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    channelSelect,
  );
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
