import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { ConversationMessage } from "./conversation-context.js";
import type { DailyQuestionReservation } from "./daily-limit.js";
import type { RecordedVote, VoteTotals, VoteType } from "./feedback-types.js";
import {
  isKnowledgeCategory,
  type KnowledgeCategory,
  type StructuredKnowledge,
} from "./structured-knowledge.js";

interface SupabaseErrorLike {
  code?: string;
  message?: string;
}

interface VoteTotalsRow {
  helpful: number | string;
  not_helpful: number | string;
}

interface RecordedVoteRow extends VoteTotalsRow {
  previous_vote: VoteType | null;
}

interface AnswerVerificationRow {
  is_verified: boolean;
  verified_by_discord_user_id: string | null;
  verified_at: string | null;
}

interface VerifiedKnowledgeRow {
  answer_id: string;
  question_text: string;
  answer_text: string;
  relevance: number | string;
}

interface ConversationMessageRow {
  discord_guild_id: string;
  discord_user_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface DailyQuestionReservationRow {
  allowed: boolean;
  daily_limit: number | null;
  used: number;
  remaining: number | null;
}

interface StructuredKnowledgeRow {
  id?: string;
  knowledge_id?: string;
  title: string;
  category: string;
  content: string;
  url: string | null;
  active?: boolean;
  relevance?: number | string;
}

interface EditableAnswerRow {
  answer_text: string;
  discord_message_id: string | null;
  is_verified: boolean;
}

interface EditedAnswerRow {
  answer_text: string;
  is_verified: boolean;
  edited_by_discord_user_id: string;
  edited_at: string;
}

export interface SaveQuestionInput {
  discordMessageId: string;
  discordGuildId: string;
  discordUserId: string;
  questionText: string;
}

export interface CreateAnswerInput {
  id: string;
  questionId: string;
  answerText: string;
}

export interface AnswerVerification {
  isVerified: boolean;
  verifiedByDiscordUserId: string | undefined;
  verifiedAt: string | undefined;
}

export interface VerifiedKnowledge {
  answerId: string;
  questionText: string;
  answerText: string;
  relevance: number;
}

export interface CreateStructuredKnowledgeInput {
  title: string;
  category: KnowledgeCategory;
  content: string;
  url: string | undefined;
  discordModeratorUserId: string;
}

export interface UpdateStructuredKnowledgeInput {
  title?: string;
  category?: KnowledgeCategory;
  content?: string;
  url?: string | null;
}

export interface EditableAnswer {
  answerText: string;
  discordMessageId: string | undefined;
  isVerified: boolean;
}

export interface EditedAnswer {
  answerText: string;
  isVerified: boolean;
  editedByDiscordUserId: string;
  editedAt: string;
}

export class SupabasePersistenceError extends Error {
  constructor(
    public readonly operation: string,
    public readonly code: string,
    message: string,
  ) {
    super(`Supabase ${operation} failed [${code}]: ${message}`);
    this.name = "SupabasePersistenceError";
  }
}

function persistenceError(
  operation: string,
  error?: SupabaseErrorLike | null,
): SupabasePersistenceError {
  return new SupabasePersistenceError(
    operation,
    error?.code ?? "UNKNOWN",
    error?.message ?? "No result was returned.",
  );
}

function parseCount(value: number | string, field: string): number {
  const count = Number(value);

  if (!Number.isSafeInteger(count) || count < 0) {
    throw persistenceError("read vote totals", {
      code: "INVALID_RESPONSE",
      message: `Invalid ${field} count returned by the database.`,
    });
  }

  return count;
}

function parseTotals(row: VoteTotalsRow): VoteTotals {
  return {
    helpful: parseCount(row.helpful, "helpful"),
    notHelpful: parseCount(row.not_helpful, "not_helpful"),
  };
}

function isVoteType(value: unknown): value is VoteType {
  return value === "helpful" || value === "not_helpful";
}

function parseVerification(row: AnswerVerificationRow): AnswerVerification {
  if (typeof row.is_verified !== "boolean") {
    throw persistenceError("read answer verification", {
      code: "INVALID_RESPONSE",
      message: "Invalid verification state returned by the database.",
    });
  }

  return {
    isVerified: row.is_verified,
    verifiedByDiscordUserId: row.verified_by_discord_user_id ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
  };
}

function parseStructuredKnowledge(
  row: StructuredKnowledgeRow,
): StructuredKnowledge {
  const id = row.id ?? row.knowledge_id;
  const relevance =
    row.relevance === undefined ? undefined : Number(row.relevance);

  if (
    typeof id !== "string" ||
    typeof row.title !== "string" ||
    !isKnowledgeCategory(row.category) ||
    typeof row.content !== "string" ||
    (row.url !== null && typeof row.url !== "string") ||
    (relevance !== undefined && (!Number.isFinite(relevance) || relevance < 0))
  ) {
    throw persistenceError("read structured knowledge", {
      code: "INVALID_RESPONSE",
      message: "Invalid structured knowledge returned by the database.",
    });
  }

  return {
    id,
    title: row.title,
    category: row.category,
    content: row.content,
    url: row.url ?? undefined,
    isActive: row.active,
    relevance,
  };
}

function normalizeSupabaseUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("SUPABASE_URL must be a valid HTTPS URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("SUPABASE_URL must use HTTPS.");
  }

  const path = url.pathname.replace(/\/+$/, "");

  if (path && path !== "/rest/v1") {
    throw new Error(
      "SUPABASE_URL must be the project URL or its /rest/v1 Data API URL.",
    );
  }

  return url.origin;
}

export function isMissingAnswerError(error: unknown): boolean {
  return (
    error instanceof SupabasePersistenceError &&
    (error.code === "23503" || error.code === "P0002")
  );
}

export class SupabaseService {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(normalizeSupabaseUrl(url), serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  async checkConnection(): Promise<void> {
    await this.getVoteTotals("00000000-0000-0000-0000-000000000000");

    const { error } = await this.client
      .from("guild_question_limits")
      .select("discord_guild_id")
      .limit(1);

    if (error) {
      throw persistenceError("check V5 schema", error);
    }
  }

  async saveQuestion(input: SaveQuestionInput): Promise<string> {
    const { data, error } = await this.client
      .from("questions")
      .upsert(
        {
          discord_message_id: input.discordMessageId,
          discord_guild_id: input.discordGuildId,
          discord_user_id: input.discordUserId,
          question_text: input.questionText,
        },
        { onConflict: "discord_message_id" },
      )
      .select("id")
      .single();

    if (error || typeof data?.id !== "string") {
      throw persistenceError("save question", error);
    }

    return data.id;
  }

  async createAnswer(input: CreateAnswerInput): Promise<void> {
    const { error } = await this.client.from("answers").insert({
      id: input.id,
      question_id: input.questionId,
      discord_message_id: null,
      answer_text: input.answerText,
      original_answer_text: input.answerText,
    });

    if (error) {
      throw persistenceError("save answer", error);
    }
  }

  async attachDiscordMessageId(
    answerId: string,
    discordMessageId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from("answers")
      .update({ discord_message_id: discordMessageId })
      .eq("id", answerId)
      .select("id")
      .single();

    if (error || typeof data?.id !== "string") {
      throw persistenceError("attach answer Discord message", error);
    }
  }

  async deleteAnswer(answerId: string): Promise<void> {
    const { error } = await this.client.from("answers").delete().eq("id", answerId);

    if (error) {
      throw persistenceError("roll back unsent answer", error);
    }
  }

  async getVoteTotals(answerId: string): Promise<VoteTotals> {
    const { data, error } = await this.client
      .rpc("get_answer_vote_totals", { target_answer_id: answerId })
      .single();

    if (error || !data) {
      throw persistenceError("read vote totals", error);
    }

    return parseTotals(data as VoteTotalsRow);
  }

  async recordVote(
    answerId: string,
    discordUserId: string,
    vote: VoteType,
  ): Promise<RecordedVote> {
    const { data, error } = await this.client
      .rpc("record_answer_vote", {
        target_answer_id: answerId,
        target_discord_user_id: discordUserId,
        target_vote_type: vote,
      })
      .single();

    if (error || !data) {
      throw persistenceError("record vote", error);
    }

    const row = data as RecordedVoteRow;

    if (row.previous_vote !== null && !isVoteType(row.previous_vote)) {
      throw persistenceError("record vote", {
        code: "INVALID_RESPONSE",
        message: "Invalid previous vote returned by the database.",
      });
    }

    return {
      previousVote: row.previous_vote ?? undefined,
      vote,
      totals: parseTotals(row),
    };
  }

  async getAnswerVerification(answerId: string): Promise<AnswerVerification> {
    const { data, error } = await this.client
      .from("answers")
      .select("is_verified, verified_by_discord_user_id, verified_at")
      .eq("id", answerId)
      .single();

    if (error || !data) {
      throw persistenceError("read answer verification", error);
    }

    return parseVerification(data as AnswerVerificationRow);
  }

  async setAnswerVerification(
    answerId: string,
    discordModeratorUserId: string,
    isVerified: boolean,
  ): Promise<AnswerVerification> {
    const { data, error } = await this.client
      .rpc("set_answer_verification", {
        target_answer_id: answerId,
        target_is_verified: isVerified,
        target_discord_user_id: discordModeratorUserId,
      })
      .single();

    if (error || !data) {
      throw persistenceError(
        isVerified ? "verify answer" : "unverify answer",
        error,
      );
    }

    return parseVerification(data as AnswerVerificationRow);
  }

  async searchVerifiedKnowledge(
    query: string,
    limit = 3,
  ): Promise<VerifiedKnowledge[]> {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5));
    const { data, error } = await this.client.rpc("search_verified_knowledge", {
      search_query: query,
      result_limit: safeLimit,
    });

    if (error || !Array.isArray(data)) {
      throw persistenceError("search verified knowledge", error);
    }

    return (data as VerifiedKnowledgeRow[]).map((row) => {
      const relevance = Number(row.relevance);

      if (
        typeof row.answer_id !== "string" ||
        typeof row.question_text !== "string" ||
        typeof row.answer_text !== "string" ||
        !Number.isFinite(relevance) ||
        relevance < 0
      ) {
        throw persistenceError("search verified knowledge", {
          code: "INVALID_RESPONSE",
          message: "Invalid verified knowledge returned by the database.",
        });
      }

      return {
        answerId: row.answer_id,
        questionText: row.question_text,
        answerText: row.answer_text,
        relevance,
      };
    });
  }

  async getConversationHistory(
    discordGuildId: string,
    discordUserId: string,
    fetchLimit: number,
  ): Promise<ConversationMessage[]> {
    const safeLimit = Math.max(2, Math.min(Math.trunc(fetchLimit), 60));
    const { data, error } = await this.client
      .from("conversation_messages")
      .select("discord_guild_id, discord_user_id, role, content, created_at")
      .eq("discord_guild_id", discordGuildId)
      .eq("discord_user_id", discordUserId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(safeLimit);

    if (error || !Array.isArray(data)) {
      throw persistenceError("read conversation history", error);
    }

    return (data as ConversationMessageRow[]).map((row) => {
      if (
        typeof row.discord_guild_id !== "string" ||
        typeof row.discord_user_id !== "string" ||
        (row.role !== "user" && row.role !== "assistant") ||
        typeof row.content !== "string" ||
        typeof row.created_at !== "string"
      ) {
        throw persistenceError("read conversation history", {
          code: "INVALID_RESPONSE",
          message: "Invalid conversation message returned by the database.",
        });
      }

      return {
        discordGuildId: row.discord_guild_id,
        discordUserId: row.discord_user_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
      };
    });
  }

  async appendConversationExchange(input: {
    discordGuildId: string;
    discordUserId: string;
    questionId: string;
    answerId: string;
    questionText: string;
    answerText: string;
  }): Promise<void> {
    const { error } = await this.client.rpc("append_conversation_exchange", {
      target_discord_guild_id: input.discordGuildId,
      target_discord_user_id: input.discordUserId,
      target_question_id: input.questionId,
      target_answer_id: input.answerId,
      target_question_text: input.questionText,
      target_answer_text: input.answerText,
    });

    if (error) {
      throw persistenceError("append conversation exchange", error);
    }
  }

  async clearConversation(
    discordGuildId: string,
    discordUserId: string,
  ): Promise<number> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .delete()
      .eq("discord_guild_id", discordGuildId)
      .eq("discord_user_id", discordUserId)
      .select("id");

    if (error || !Array.isArray(data)) {
      throw persistenceError("clear conversation history", error);
    }

    return data.length;
  }

  async deleteConversationExchange(
    questionId: string,
    answerId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("conversation_messages")
      .delete()
      .or(`question_id.eq.${questionId},answer_id.eq.${answerId}`);

    if (error) {
      throw persistenceError("roll back conversation exchange", error);
    }
  }

  async setGuildDailyQuestionLimit(
    discordGuildId: string,
    dailyLimit: number | null,
    discordModeratorUserId: string,
  ): Promise<number | undefined> {
    const { data, error } = await this.client
      .rpc("set_guild_question_limit", {
        target_discord_guild_id: discordGuildId,
        target_daily_limit: dailyLimit,
        target_discord_moderator_user_id: discordModeratorUserId,
      })
      .single();

    if (error || !data) {
      throw persistenceError("set guild question limit", error);
    }

    const value = (data as { daily_limit: number | null }).daily_limit;
    return value ?? undefined;
  }

  async reserveDailyQuestion(
    discordGuildId: string,
    discordUserId: string,
  ): Promise<DailyQuestionReservation> {
    const { data, error } = await this.client
      .rpc("reserve_daily_question", {
        target_discord_guild_id: discordGuildId,
        target_discord_user_id: discordUserId,
      })
      .single();

    if (error || !data) {
      throw persistenceError("reserve daily question", error);
    }

    const row = data as DailyQuestionReservationRow;

    if (
      typeof row.allowed !== "boolean" ||
      !Number.isSafeInteger(row.used) ||
      row.used < 0 ||
      (row.daily_limit !== null &&
        (!Number.isSafeInteger(row.daily_limit) || row.daily_limit <= 0)) ||
      (row.remaining !== null &&
        (!Number.isSafeInteger(row.remaining) || row.remaining < 0))
    ) {
      throw persistenceError("reserve daily question", {
        code: "INVALID_RESPONSE",
        message: "Invalid daily usage result returned by the database.",
      });
    }

    return {
      allowed: row.allowed,
      dailyLimit: row.daily_limit ?? undefined,
      used: row.used,
      remaining: row.remaining ?? undefined,
    };
  }

  async releaseDailyQuestion(
    discordGuildId: string,
    discordUserId: string,
  ): Promise<void> {
    const { error } = await this.client.rpc("release_daily_question", {
      target_discord_guild_id: discordGuildId,
      target_discord_user_id: discordUserId,
    });

    if (error) {
      throw persistenceError("release daily question", error);
    }
  }

  async completeDailyQuestion(
    discordGuildId: string,
    discordUserId: string,
  ): Promise<void> {
    const { error } = await this.client.rpc("complete_daily_question", {
      target_discord_guild_id: discordGuildId,
      target_discord_user_id: discordUserId,
    });

    if (error) {
      throw persistenceError("complete daily question", error);
    }
  }

  async searchStructuredKnowledge(
    query: string,
    limit = 4,
  ): Promise<StructuredKnowledge[]> {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 8));
    const { data, error } = await this.client.rpc(
      "search_structured_knowledge",
      { search_query: query, result_limit: safeLimit },
    );

    if (error || !Array.isArray(data)) {
      throw persistenceError("search structured knowledge", error);
    }

    return (data as StructuredKnowledgeRow[]).map(parseStructuredKnowledge);
  }

  async createStructuredKnowledge(
    input: CreateStructuredKnowledgeInput,
  ): Promise<StructuredKnowledge> {
    const { data, error } = await this.client
      .from("structured_knowledge")
      .insert({
        title: input.title,
        category: input.category,
        content: input.content,
        url: input.url ?? null,
        created_by: input.discordModeratorUserId,
        updated_by: input.discordModeratorUserId,
      })
      .select("id, title, category, content, url, active")
      .single();

    if (error || !data) {
      throw persistenceError("create structured knowledge", error);
    }

    return parseStructuredKnowledge(data as StructuredKnowledgeRow);
  }

  async getStructuredKnowledge(id: string): Promise<StructuredKnowledge> {
    const { data, error } = await this.client
      .from("structured_knowledge")
      .select("id, title, category, content, url, active")
      .eq("id", id)
      .single();

    if (error || !data) {
      throw persistenceError("read structured knowledge", error);
    }

    return parseStructuredKnowledge(data as StructuredKnowledgeRow);
  }

  async listStructuredKnowledge(
    category?: KnowledgeCategory,
    limit = 10,
  ): Promise<StructuredKnowledge[]> {
    let query = this.client
      .from("structured_knowledge")
      .select("id, title, category, content, url, active")
      .order("updated_at", { ascending: false })
      .limit(Math.max(1, Math.min(Math.trunc(limit), 20)));

    if (category) {
      query = query.eq("category", category);
    }

    const { data, error } = await query;

    if (error || !Array.isArray(data)) {
      throw persistenceError("list structured knowledge", error);
    }

    return (data as StructuredKnowledgeRow[]).map(parseStructuredKnowledge);
  }

  async updateStructuredKnowledge(
    id: string,
    changes: UpdateStructuredKnowledgeInput,
    discordModeratorUserId: string,
  ): Promise<StructuredKnowledge> {
    const update: Record<string, unknown> = {
      updated_by: discordModeratorUserId,
      updated_at: new Date().toISOString(),
    };

    if (changes.title !== undefined) update.title = changes.title;
    if (changes.category !== undefined) update.category = changes.category;
    if (changes.content !== undefined) update.content = changes.content;
    if (changes.url !== undefined) update.url = changes.url;

    const { data, error } = await this.client
      .from("structured_knowledge")
      .update(update)
      .eq("id", id)
      .select("id, title, category, content, url, active")
      .single();

    if (error || !data) {
      throw persistenceError("update structured knowledge", error);
    }

    return parseStructuredKnowledge(data as StructuredKnowledgeRow);
  }

  async deactivateStructuredKnowledge(
    id: string,
    discordModeratorUserId: string,
  ): Promise<StructuredKnowledge> {
    const { data, error } = await this.client
      .from("structured_knowledge")
      .update({
        active: false,
        updated_by: discordModeratorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id, title, category, content, url, active")
      .single();

    if (error || !data) {
      throw persistenceError("deactivate structured knowledge", error);
    }

    return parseStructuredKnowledge(data as StructuredKnowledgeRow);
  }

  async getAnswerForEditing(answerId: string): Promise<EditableAnswer> {
    const { data, error } = await this.client
      .from("answers")
      .select("answer_text, discord_message_id, is_verified")
      .eq("id", answerId)
      .single();

    if (error || !data) {
      throw persistenceError("read answer for editing", error);
    }

    const row = data as EditableAnswerRow;

    if (
      typeof row.answer_text !== "string" ||
      (row.discord_message_id !== null &&
        typeof row.discord_message_id !== "string") ||
      typeof row.is_verified !== "boolean"
    ) {
      throw persistenceError("read answer for editing", {
        code: "INVALID_RESPONSE",
        message: "Invalid editable answer returned by the database.",
      });
    }

    return {
      answerText: row.answer_text,
      discordMessageId: row.discord_message_id ?? undefined,
      isVerified: row.is_verified,
    };
  }

  async editAnswer(
    answerId: string,
    answerText: string,
    discordModeratorUserId: string,
  ): Promise<EditedAnswer> {
    const { data, error } = await this.client
      .rpc("edit_oracle_answer", {
        target_answer_id: answerId,
        target_answer_text: answerText,
        target_discord_moderator_user_id: discordModeratorUserId,
      })
      .single();

    if (error || !data) {
      throw persistenceError("edit answer", error);
    }

    const row = data as EditedAnswerRow;

    if (
      typeof row.answer_text !== "string" ||
      typeof row.is_verified !== "boolean" ||
      typeof row.edited_by_discord_user_id !== "string" ||
      typeof row.edited_at !== "string"
    ) {
      throw persistenceError("edit answer", {
        code: "INVALID_RESPONSE",
        message: "Invalid edited answer returned by the database.",
      });
    }

    return {
      answerText: row.answer_text,
      isVerified: row.is_verified,
      editedByDiscordUserId: row.edited_by_discord_user_id,
      editedAt: row.edited_at,
    };
  }
}
