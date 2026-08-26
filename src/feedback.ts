import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import type { VoteTotals, VoteType } from "./feedback-types.js";

export interface FeedbackButtonData {
  answerId: string;
  vote: VoteType;
}

const FEEDBACK_CUSTOM_ID_PREFIX = "karting-oracle-feedback:v3";
const LEGACY_FEEDBACK_CUSTOM_ID_PREFIX = "karting-oracle-feedback:v2";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function feedbackCustomId(answerId: string, vote: VoteType): string {
  return `${FEEDBACK_CUSTOM_ID_PREFIX}:${vote}:${answerId}`;
}

export function feedbackButtonFromCustomId(
  customId: string,
): FeedbackButtonData | undefined {
  const prefix = [FEEDBACK_CUSTOM_ID_PREFIX, LEGACY_FEEDBACK_CUSTOM_ID_PREFIX]
    .map((candidate) => `${candidate}:`)
    .find((candidate) => customId.startsWith(candidate));

  if (!prefix) {
    return undefined;
  }

  const [rawVote, answerId, ...extraParts] = customId
    .slice(prefix.length)
    .split(":");
  const vote = rawVote === "not-helpful" ? "not_helpful" : rawVote;

  if (
    (vote !== "helpful" && vote !== "not_helpful") ||
    !answerId ||
    !UUID_PATTERN.test(answerId) ||
    extraParts.length > 0
  ) {
    return undefined;
  }

  return { answerId, vote };
}

export function buildFeedbackButtons(
  answerId: string,
  totals: VoteTotals,
): ActionRowBuilder<ButtonBuilder> {
  const helpfulButton = new ButtonBuilder()
    .setCustomId(feedbackCustomId(answerId, "helpful"))
    .setEmoji("\u{1F44D}")
    .setLabel(`Helpful (${totals.helpful})`)
    .setStyle(ButtonStyle.Success);

  const notHelpfulButton = new ButtonBuilder()
    .setCustomId(feedbackCustomId(answerId, "not_helpful"))
    .setEmoji("\u{1F44E}")
    .setLabel(`Not Helpful (${totals.notHelpful})`)
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    helpfulButton,
    notHelpfulButton,
  );
}

export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);

    return result.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
  }
}
