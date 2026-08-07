export const DEFAULT_CONTEXT_RANKING_LIMIT = 12;
export const DEFAULT_CONTEXT_FALLBACK_LIMIT = 5;
export const DEFAULT_CONTEXT_RESPONSE_TOKEN_BUDGET = 2_000;
export const DEFAULT_RECOMMENDED_CONTENT_TOKEN_BUDGET = 8_000;
export const DEFAULT_CONTEXT_SELECTION_THRESHOLD = 0.18;
export const DEFAULT_CONTEXT_SUMMARY_MAX_CHARS = 600;
export const DEFAULT_RECENT_FILE_WINDOW_DAYS = 14;

export const DEFAULT_RANKING_WEIGHTS = {
  lexical: 0.23,
  bm25: 0.27,
  dependency: 0.16,
  testRelation: 0.1,
  ownership: 0.06,
  kind: 0.08,
  recency: 0.04,
  cost: 0.06,
} as const;

export type RankingSignalName = keyof typeof DEFAULT_RANKING_WEIGHTS;
