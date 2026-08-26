import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

export type VerificationAction = "verify" | "unverify";

export interface VerificationButtonData {
  action: VerificationAction;
  answerId: string;
}

const VERIFICATION_CUSTOM_ID_PREFIX = "karting-oracle-verification:v4";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function verificationCustomId(
  answerId: string,
  action: VerificationAction,
): string {
  return `${VERIFICATION_CUSTOM_ID_PREFIX}:${action}:${answerId}`;
}

export function verificationButtonFromCustomId(
  customId: string,
): VerificationButtonData | undefined {
  const prefix = `${VERIFICATION_CUSTOM_ID_PREFIX}:`;

  if (!customId.startsWith(prefix)) {
    return undefined;
  }

  const [action, answerId, ...extraParts] = customId
    .slice(prefix.length)
    .split(":");

  if (
    (action !== "verify" && action !== "unverify") ||
    !answerId ||
    !UUID_PATTERN.test(answerId) ||
    extraParts.length > 0
  ) {
    return undefined;
  }

  return { action, answerId };
}

export function buildVerificationButton(
  answerId: string,
  isVerified: boolean,
): ActionRowBuilder<ButtonBuilder> {
  const action: VerificationAction = isVerified ? "unverify" : "verify";
  const button = new ButtonBuilder()
    .setCustomId(verificationCustomId(answerId, action))
    .setEmoji(isVerified ? "↩️" : "✅")
    .setLabel(isVerified ? "Unverify" : "Verify Answer")
    .setStyle(isVerified ? ButtonStyle.Secondary : ButtonStyle.Primary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}
