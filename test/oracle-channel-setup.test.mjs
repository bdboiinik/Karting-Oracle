import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannelType,
  ComponentType,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";

import {
  buildOracleCommand,
  buildOracleChannelDiagnostics,
  buildOracleChannelSelector,
  canMemberConfigureOracleChannel,
  isOracleSetupCommand,
  missingOracleChannelPermissions,
  ORACLE_CHANNEL_SELECT_CUSTOM_ID,
  ORACLE_COMMAND_NAME,
  ORACLE_SETUP_SUBCOMMAND_NAME,
} from "../dist/oracle-channel-setup.js";

test("registers the setup route as /oracle setup", () => {
  const command = buildOracleCommand().toJSON();

  assert.equal(command.name, ORACLE_COMMAND_NAME);
  assert.deepEqual(
    command.options?.map((option) => option.name),
    [ORACLE_SETUP_SUBCOMMAND_NAME],
  );
  assert.equal(isOracleSetupCommand("oracle", "setup"), true);
  assert.equal(isOracleSetupCommand("oracle-setup", null), false);
});

test("builds a native selector restricted to one text channel", () => {
  const row = buildOracleChannelSelector().toJSON();
  const selector = row.components[0];

  assert.equal(selector?.type, ComponentType.ChannelSelect);
  assert.equal(selector?.custom_id, ORACLE_CHANNEL_SELECT_CUSTOM_ID);
  assert.deepEqual(selector?.channel_types, [ChannelType.GuildText]);
  assert.equal(selector?.min_values, 1);
  assert.equal(selector?.max_values, 1);
  assert.equal("options" in selector, false);
});

test("marks the currently configured text channel as the native default", () => {
  const row = buildOracleChannelSelector("123456789").toJSON();
  const selector = row.components[0];

  assert.deepEqual(selector?.default_values, [
    { id: "123456789", type: "channel" },
  ]);
});

test("reports each missing bot permission for a text channel", () => {
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () =>
      new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
  };

  assert.deepEqual(
    missingOracleChannelPermissions(channel, {}),
    ["Send Messages", "Read Message History"],
  );
});

test("accepts a text channel when all required bot permissions are current", () => {
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () =>
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ]),
  };

  assert.deepEqual(missingOracleChannelPermissions(channel, {}), []);
});

test("Administrator naturally satisfies all required channel permissions", () => {
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () =>
      new PermissionsBitField([PermissionFlagsBits.Administrator]),
  };

  assert.deepEqual(missingOracleChannelPermissions(channel, {}), []);
});

test("fresh selector diagnostics include configured and non-text channels", () => {
  const channels = [
    {
      id: "111",
      name: "karting-oracle",
      type: ChannelType.GuildText,
    },
    {
      id: "222",
      name: "announcements",
      type: ChannelType.GuildAnnouncement,
    },
  ];

  const diagnostics = buildOracleChannelDiagnostics(channels, "111");

  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.find((channel) => channel.id === "111"),
    {
      id: "111",
      name: "karting-oracle",
      type: ChannelType.GuildText,
      isGuildText: true,
      isConfigured: true,
    },
  );
  assert.equal(
    diagnostics.find((channel) => channel.id === "222")?.isGuildText,
    false,
  );
});

test("allows Manage Server or any configured moderator role to run setup", () => {
  const moderatorRoleIds = new Set(["222", "333"]);

  assert.equal(
    canMemberConfigureOracleChannel(["111"], moderatorRoleIds, true),
    true,
  );
  assert.equal(
    canMemberConfigureOracleChannel(["111", "333"], moderatorRoleIds, false),
    true,
  );
  assert.equal(
    canMemberConfigureOracleChannel(["111"], moderatorRoleIds, false),
    false,
  );
});
