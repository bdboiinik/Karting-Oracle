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

export interface OracleChannelDiagnostic {
  id: string;
  name: string;
  type: ChannelType;
  isGuildText: boolean;
  isConfigured: boolean;
  canView: boolean;
  canSend: boolean;
  canReadHistory: boolean;
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

export function buildOracleChannelDiagnostics(
  channels: Iterable<GuildBasedChannel | null>,
  botMember: GuildMember,
  configuredChannelId?: string,
): OracleChannelDiagnostic[] {
  return Array.from(channels)
    .filter((channel): channel is GuildBasedChannel => channel !== null)
    .map((channel) => {
      const permissions = channel.permissionsFor(botMember);

      return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        isGuildText: channel.type === ChannelType.GuildText,
        isConfigured: channel.id === configuredChannelId,
        canView: permissions.has(PermissionFlagsBits.ViewChannel),
        canSend: permissions.has(PermissionFlagsBits.SendMessages),
        canReadHistory: permissions.has(
          PermissionFlagsBits.ReadMessageHistory,
        ),
      };
    })
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
