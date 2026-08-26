import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { RecordedVote, VoteTotals, VoteType } from "./feedback-types.js";

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

export interface SaveQuestionInput {
  discordMessageId: string;
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
  }

  async saveQuestion(input: SaveQuestionInput): Promise<string> {
    const { data, error } = await this.client
      .from("questions")
      .upsert(
        {
          discord_message_id: input.discordMessageId,
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
}
