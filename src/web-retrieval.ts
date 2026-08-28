import { createHash } from "node:crypto";

import {
  condenseAnswerForDiscord,
  MAX_ORACLE_ANSWER_CHARACTERS,
} from "./answer-length.js";

export const WEB_FACT_TYPES = [
  "location_address",
  "official_website",
  "contact_information",
  "opening_hours",
  "events_schedule",
  "current_fleet",
  "current_product",
  "other_current",
] as const;

export type WebFactType = (typeof WEB_FACT_TYPES)[number];

export interface WebRetrievalRequest {
  query: string;
  factType: WebFactType;
}

export interface WebSource {
  title: string;
  url: string;
}

export interface WebRetrievalCacheEntry {
  cacheKey: string;
  canonicalQuery: string;
  factType: WebFactType;
  factText: string;
  answerText: string;
  sources: WebSource[];
  usedVerifiedKnowledge: boolean;
  usedStructuredKnowledge: boolean;
  fetchedAt: string;
  expiresAt: string;
}

export interface WebSourcedAnswer {
  answerText: string;
  factText: string;
  source: WebSource;
  usedVerifiedKnowledge: boolean;
  usedStructuredKnowledge: boolean;
}

export interface WebSearchDiagnostics {
  triggered: boolean;
  callCount: number;
  completedCallCount: number;
  failedCallCount: number;
  statuses: string[];
  actions: string[];
  sourceCount: number;
  sourceDomains: string[];
  sourceUrls: string[];
}

export const WEB_ORACLE_RESPONSE_FORMAT = {
  type: "json_schema",
  name: "karting_oracle_web_answer",
  description:
    "A concise karting answer grounded in a current public web source.",
  strict: true,
  schema: {
    type: "object",
    properties: {
      answer: { type: "string", maxLength: 1800 },
      fact_summary: { type: "string", maxLength: 4000 },
      primary_source_title: { type: "string" },
      primary_source_url: { type: "string", maxLength: 1000 },
      is_karting_related: { type: "boolean" },
      used_verified_knowledge: { type: "boolean" },
      used_structured_knowledge: { type: "boolean" },
    },
    required: [
      "answer",
      "fact_summary",
      "primary_source_title",
      "primary_source_url",
      "is_karting_related",
      "used_verified_knowledge",
      "used_structured_knowledge",
    ],
    additionalProperties: false,
  },
} as const;

const DAY_MS = 24 * 60 * 60 * 1_000;

const WEB_CACHE_TTL_MS: Record<WebFactType, number> = {
  location_address: 180 * DAY_MS,
  official_website: 90 * DAY_MS,
  contact_information: 30 * DAY_MS,
  opening_hours: DAY_MS,
  events_schedule: 6 * 60 * 60 * 1_000,
  current_fleet: 7 * DAY_MS,
  current_product: DAY_MS,
  other_current: DAY_MS,
};

const VENUE_LOCATION_PATTERN =
  /\b(where\s+(?:is|are)|where's|located|location|full\s+address|address|post\s*code)\b/i;
const POSTAL_CODE_PATTERN =
  /\b(?:GIR\s*0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|[A-Z]\d[A-Z]\s*\d[A-Z]\d|\d{5}(?:-\d{4})?)\b|\b(?:postcode|postal\s+code|zip)\s*:?\s*[A-Z0-9][A-Z0-9 -]{2,10}\b/i;

export function isWebFactType(value: unknown): value is WebFactType {
  return (
    typeof value === "string" &&
    WEB_FACT_TYPES.includes(value as WebFactType)
  );
}

export function webCacheTtlMs(factType: WebFactType): number {
  return WEB_CACHE_TTL_MS[factType];
}

export function normalizeWebQuery(query: string): string {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function createWebCacheKey(
  query: string,
  factType: WebFactType,
): string {
  return createHash("sha256")
    .update(`${factType}:${normalizeWebQuery(query)}`)
    .digest("hex");
}

export function trustedKnowledgeHasCompleteLocation(
  trustedKnowledgeText: string,
): boolean {
  return POSTAL_CODE_PATTERN.test(trustedKnowledgeText);
}

function venueSearchQuery(question: string): string {
  const stripped = question
    .replace(
      /\b(?:can\s+you\s+)?(?:please\s+)?(?:check|search|google|look\s+up)\b/gi,
      " ",
    )
    .replace(/\bwhere\s+(?:is|are)\b/gi, " ")
    .replace(
      /\b(?:located|location|full\s+address|address|post\s*code|for|of)\b/gi,
      " ",
    )
    .replace(/[^\p{L}\p{N}'&-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

  const subject = (stripped || question.trim()).slice(0, 350).trim();
  return `${subject} official karting venue full address postcode`;
}

export function resolveWebRetrievalRequest(
  question: string,
  answer: {
    isKartingRelated: boolean;
    webRetrievalRequest?: WebRetrievalRequest;
  },
  trustedKnowledgeText: string,
): WebRetrievalRequest | undefined {
  if (!answer.isKartingRelated) {
    return undefined;
  }

  if (
    answer.webRetrievalRequest?.factType === "location_address" &&
    trustedKnowledgeHasCompleteLocation(trustedKnowledgeText)
  ) {
    return undefined;
  }

  if (answer.webRetrievalRequest) {
    return answer.webRetrievalRequest;
  }

  if (
    VENUE_LOCATION_PATTERN.test(question) &&
    !trustedKnowledgeHasCompleteLocation(trustedKnowledgeText)
  ) {
    return {
      factType: "location_address",
      query: venueSearchQuery(question),
    };
  }

  return undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function sourceTitle(url: string, title?: unknown): string {
  if (typeof title === "string" && title.trim()) return title.trim();
  return new URL(url).hostname.replace(/^www\./, "");
}

function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function registrableDomain(value: string): string {
  const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  const parts = hostname.split(".");
  const countrySecondLevel = new Set([
    "co.uk",
    "org.uk",
    "com.au",
    "co.nz",
    "co.za",
  ]);
  const finalTwo = parts.slice(-2).join(".");

  return countrySecondLevel.has(finalTwo) && parts.length >= 3
    ? parts.slice(-3).join(".")
    : finalTwo;
}

function equivalentUrl(left: string, right: string): boolean {
  return canonicalSourceUrl(left) === canonicalSourceUrl(right);
}

function sameAuthorityDomain(left: string, right: string): boolean {
  return registrableDomain(left) === registrableDomain(right);
}

function deduplicateSources(sources: WebSource[]): WebSource[] {
  const seen = new Set<string>();

  return sources.filter((source) => {
    const key = canonicalSourceUrl(source.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractWebSources(output: readonly unknown[]): WebSource[] {
  const citations: WebSource[] = [];
  const consulted: WebSource[] = [];

  for (const item of output) {
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "message" &&
      "content" in item &&
      Array.isArray(item.content)
    ) {
      for (const part of item.content) {
        if (
          typeof part !== "object" ||
          part === null ||
          !("annotations" in part) ||
          !Array.isArray(part.annotations)
        ) {
          continue;
        }

        for (const annotation of part.annotations) {
          if (
            typeof annotation !== "object" ||
            annotation === null ||
            !("type" in annotation) ||
            annotation.type !== "url_citation"
          ) {
            continue;
          }

          const record = annotation as Record<string, unknown>;
          const url = httpUrl(record.url);
          if (url) {
            citations.push({
              title: sourceTitle(url, record.title),
              url,
            });
          }
        }
      }
    }

    if (
      typeof item !== "object" ||
      item === null ||
      !("type" in item) ||
      item.type !== "web_search_call" ||
      !("action" in item) ||
      typeof item.action !== "object" ||
      item.action === null
    ) {
      continue;
    }

    const action = item.action as Record<string, unknown>;
    const directUrl = httpUrl(action.url);
    if (directUrl) {
      consulted.push({ title: sourceTitle(directUrl), url: directUrl });
    }

    if (Array.isArray(action.sources)) {
      for (const source of action.sources) {
        if (typeof source !== "object" || source === null) continue;
        const record = source as Record<string, unknown>;
        const sourceUrl = httpUrl(record.url);
        if (sourceUrl) {
          consulted.push({
            title: sourceTitle(sourceUrl, record.title),
            url: sourceUrl,
          });
        }
      }
    }
  }

  return deduplicateSources([...citations, ...consulted]);
}

function diagnosticUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function getWebSearchDiagnostics(
  output: readonly unknown[],
): WebSearchDiagnostics {
  const calls = output.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "web_search_call",
  );
  const sources = extractWebSources(output);
  const statuses = calls.map((call) => call.status);
  const actions = calls
    .map((call) =>
      typeof call.action === "object" &&
      call.action !== null &&
      "type" in call.action &&
      typeof call.action.type === "string"
        ? call.action.type
        : "unknown",
    );

  return {
    triggered: calls.length > 0,
    callCount: calls.length,
    completedCallCount: statuses.filter((status) => status === "completed")
      .length,
    failedCallCount: statuses.filter((status) => status === "failed").length,
    statuses: statuses.map((status) =>
      typeof status === "string" ? status : "unknown",
    ),
    actions,
    sourceCount: sources.length,
    sourceDomains: [
      ...new Set(sources.map((source) => new URL(source.url).hostname)),
    ],
    sourceUrls: sources
      .slice(0, 25)
      .map((source) => diagnosticUrl(source.url)),
  };
}

export function parseWebSourcedAnswer(
  outputText: string,
  outputItems: readonly unknown[],
  verifiedKnowledgeWasAvailable: boolean,
  structuredKnowledgeWasAvailable: boolean,
): WebSourcedAnswer {
  let value: unknown;

  try {
    value = JSON.parse(outputText);
  } catch {
    throw new Error("OpenAI returned an invalid web-grounded response.");
  }

  if (typeof value !== "object" || value === null) {
    throw new Error("OpenAI returned an invalid web-grounded response.");
  }

  const row = value as Record<string, unknown>;
  const requestedSourceUrl = httpUrl(row.primary_source_url);

  if (
    typeof row.answer !== "string" ||
    row.answer.trim().length === 0 ||
    typeof row.fact_summary !== "string" ||
    row.fact_summary.trim().length === 0 ||
    typeof row.primary_source_title !== "string" ||
    row.primary_source_title.trim().length === 0 ||
    (requestedSourceUrl !== undefined && requestedSourceUrl.length > 1_000) ||
    row.is_karting_related !== true ||
    typeof row.used_verified_knowledge !== "boolean" ||
    typeof row.used_structured_knowledge !== "boolean"
  ) {
    throw new Error("OpenAI returned an invalid web-grounded response.");
  }

  const consultedSources = extractWebSources(outputItems);
  const selectedSource = requestedSourceUrl
    ? (consultedSources.find((source) =>
        equivalentUrl(source.url, requestedSourceUrl),
      ) ??
      consultedSources.find((source) =>
        sameAuthorityDomain(source.url, requestedSourceUrl),
      ))
    : consultedSources[0];

  if (!selectedSource) {
    throw new Error("OpenAI did not substantiate its selected web source.");
  }

  return {
    answerText: condenseAnswerForDiscord(row.answer),
    factText: row.fact_summary.trim(),
    source: {
      title: selectedSource.title || row.primary_source_title.trim(),
      url: selectedSource.url,
    },
    usedVerifiedKnowledge:
      verifiedKnowledgeWasAvailable && row.used_verified_knowledge,
    usedStructuredKnowledge:
      structuredKnowledgeWasAvailable && row.used_structured_knowledge,
  };
}

export function appendWebSourceCitation(
  answerText: string,
  source: WebSource,
): string {
  const cleanAnswer = condenseAnswerForDiscord(answerText);
  if (cleanAnswer.includes(source.url)) {
    return cleanAnswer;
  }

  const citation = `📎 Source: <${source.url}>`;
  const maximumLength = MAX_ORACLE_ANSWER_CHARACTERS;
  const availableAnswerLength = Math.max(
    0,
    maximumLength - citation.length - 2,
  );
  const displayedAnswer = condenseAnswerForDiscord(
    cleanAnswer,
    availableAnswerLength,
  );

  return `${displayedAnswer}\n\n${citation}`;
}
