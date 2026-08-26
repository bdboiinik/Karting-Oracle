export type VoteType = "helpful" | "not_helpful";

export interface VoteTotals {
  helpful: number;
  notHelpful: number;
}

export interface RecordedVote {
  previousVote: VoteType | undefined;
  vote: VoteType;
  totals: VoteTotals;
}
