import {
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";

import { buildVerificationButton } from "./verification.js";

const ANSWER_EDIT_CUSTOM_ID_PREFIX = "karting-oracle-answer-edit:v5";
const ANSWER_EDIT_TEXT_CUSTOM_ID = "karting-oracle-answer-edit-text";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function editCustomId(answerId: string): string {
  return `${ANSWER_EDIT_CUSTOM_ID_PREFIX}:${answerId}`;
}

export function answerEditIdFromCustomId(customId: string): string | undefined {
  const prefix = `${ANSWER_EDIT_CUSTOM_ID_PREFIX}:`;

  if (!customId.startsWith(prefix)) {
    return undefined;
  }

  const answerId = customId.slice(prefix.length);
  return UUID_PATTERN.test(answerId) ? answerId : undefined;
}

export function buildModeratorAnswerButtons(
  answerId: string,
  isVerified: boolean,
) {
  const row = buildVerificationButton(answerId, isVerified);
  const editButton = new ButtonBuilder()
    .setCustomId(editCustomId(answerId))
    .setLabel("Edit Answer")
    .setStyle(ButtonStyle.Secondary);

  return row.addComponents(editButton);
}

export function buildAnswerEditModal(answerId: string, answerText: string) {
  const textInput = new TextInputBuilder()
    .setCustomId(ANSWER_EDIT_TEXT_CUSTOM_ID)
    .setLabel("Corrected answer")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(1_800)
    .setValue(answerText.slice(0, 1_800));

  return new ModalBuilder()
    .setCustomId(editCustomId(answerId))
    .setTitle("Edit Karting Oracle answer")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
    );
}

export function editedAnswerFromModalFields(fields: {
  getTextInputValue(customId: string): string;
}): string {
  return fields.getTextInputValue(ANSWER_EDIT_TEXT_CUSTOM_ID).trim();
}
