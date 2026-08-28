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

export const WEB_TEMPORAL_MODES = [
  "current",
  "historical",
  "historical_pattern",
] as const;

export type WebTemporalMode = (typeof WEB_TEMPORAL_MODES)[number];

export const WEB_TEMPORAL_ANSWER_TYPES = [
  "current_confirmed",
  "current_not_announced",
  "historical",
  "historical_pattern_estimate",
] as const;

export type WebTemporalAnswerType =
  (typeof WEB_TEMPORAL_ANSWER_TYPES)[number];

export interface WebRetrievalRequest {
  query: string;
  factType: WebFactType;
  temporalMode: WebTemporalMode;
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
  temporalAnswerType: WebTemporalAnswerType;
  historicalDataPoints: string[];
}

export interface WebEvidenceContext {
  question: string;
  query: string;
  factType: WebFactType;
  temporalMode: WebTemporalMode;
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
    "A concise karting answer grounded in authoritative current or historical web evidence.",
  strict: true,
  schema: {
    type: "object",
    properties: {
      answer: { type: "string", maxLength: 1800 },
      fact_summary: { type: "string", maxLength: 4000 },
      primary_source_title: { type: "string" },
      primary_source_url: { type: "string", maxLength: 1000 },
      subject_entity: { type: "string", maxLength: 300 },
      evidence_summary: { type: "string", maxLength: 1000 },
      temporal_answer_type: {
        type: "string",
        enum: WEB_TEMPORAL_ANSWER_TYPES,
      },
      historical_data_points: {
        type: "array",
        items: { type: "string", maxLength: 300 },
        maxItems: 8,
      },
      is_karting_related: { type: "boolean" },
      used_verified_knowledge: { type: "boolean" },
      used_structured_knowledge: { type: "boolean" },
    },
    required: [
      "answer",
      "fact_summary",
      "primary_source_title",
      "primary_source_url",
      "subject_entity",
      "evidence_summary",
      "temporal_answer_type",
      "historical_data_points",
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
const HISTORICAL_CACHE_TTL_MS = 180 * DAY_MS;
const HISTORICAL_PATTERN_CACHE_TTL_MS = 30 * DAY_MS;

const VENUE_LOCATION_PATTERN =
  /\b(where\s+(?:is|are)|where's|located|location|full\s+address|address|post\s*code)\b/i;
const VENUE_FLEET_PATTERN =
  /\b(?:karts?|fleet)\b[\s\S]{0,180}\b(?:petrol|gasoline|electric|engine|powered|four[ -]?stroke|two[ -]?stroke)\b|\b(?:petrol|gasoline|electric|engine|powered|four[ -]?stroke|two[ -]?stroke)\b[\s\S]{0,180}\b(?:karts?|fleet)\b/i;
const POSTAL_CODE_PATTERN =
  /\b(?:GIR\s*0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|[A-Z]\d[A-Z]\s*\d[A-Z]\d|\d{5}(?:-\d{4})?)\b|\b(?:postcode|postal\s+code|zip)\s*:?\s*[A-Z0-9][A-Z0-9 -]{2,10}\b/i;

export function isWebFactType(value: unknown): value is WebFactType {
  return (
    typeof value === "string" &&
    WEB_FACT_TYPES.includes(value as WebFactType)
  );
}

export function webCacheTtlMs(
  factType: WebFactType,
  temporalMode: WebTemporalMode = "current",
): number {
  if (temporalMode === "historical") return HISTORICAL_CACHE_TTL_MS;
  if (temporalMode === "historical_pattern") {
    return HISTORICAL_PATTERN_CACHE_TTL_MS;
  }
  return WEB_CACHE_TTL_MS[factType];
}

export function classifyWebTemporalIntent(
  question: string,
  currentYear = new Date().getUTCFullYear(),
): WebTemporalMode {
  if (
    /\b(?:based on past years?|past years?|normally|usually|typically|historical(?:ly)?|annual pattern|time of year|previous editions?)\b/i.test(
      question,
    )
  ) {
    return "historical_pattern";
  }

  const mentionedYears = [...question.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(
    (match) => Number(match[1]),
  );
  if (
    /\b(?:when was|history|past event|previous year|last year)\b/i.test(
      question,
    ) ||
    (mentionedYears.length > 0 &&
      mentionedYears.every((year) => year < currentYear))
  ) {
    return "historical";
  }

  return "current";
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
  temporalMode: WebTemporalMode = "current",
): string {
  return createHash("sha256")
    .update(`${temporalMode}:${factType}:${normalizeWebQuery(query)}`)
    .digest("hex");
}

function temporalEventSearchQuery(
  question: string,
  temporalMode: WebTemporalMode,
): string {
  const subject = question.trim().slice(0, 300);

  if (temporalMode === "historical_pattern") {
    return `${subject} official historical dates previous editions annual timing results`;
  }

  if (temporalMode === "historical") {
    return `${subject} official historical event date results archive`;
  }

  return `${subject} official confirmed event date announcement`;
}

function isEventTimingQuestion(question: string): boolean {
  return (
    /\bwhen\b/i.test(question) &&
    /\b(?:brkc|championship|event|race|round|finals?)\b/i.test(question)
  );
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

  const temporalMode = classifyWebTemporalIntent(question);

  if (answer.webRetrievalRequest) {
    return {
      ...answer.webRetrievalRequest,
      temporalMode,
    };
  }

  if (
    VENUE_LOCATION_PATTERN.test(question) &&
    !trustedKnowledgeHasCompleteLocation(trustedKnowledgeText)
  ) {
    return {
      factType: "location_address",
      query: venueSearchQuery(question),
      temporalMode: "current",
    };
  }

  if (
    VENUE_FLEET_PATTERN.test(question) &&
    /\boriginal question:/i.test(question) &&
    /\buser clarification:/i.test(question)
  ) {
    return {
      factType: "current_fleet",
      query: `${question.slice(0, 300).trim()} official venue fleet engine petrol electric`,
      temporalMode: "current",
    };
  }

  if (isEventTimingQuestion(question)) {
    return {
      factType: "events_schedule",
      query: temporalEventSearchQuery(question, temporalMode),
      temporalMode,
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

const GENERIC_ENTITY_WORDS = new Set([
  "about",
  "address",
  "circuit",
  "contact",
  "current",
  "electric",
  "events",
  "fleet",
  "hours",
  "kart",
  "karting",
  "karts",
  "located",
  "official",
  "opening",
  "past",
  "petrol",
  "postcode",
  "previous",
  "racing",
  "schedule",
  "source",
  "track",
  "venue",
  "website",
  "years",
]);

function distinctiveEntityWords(value: string): string[] {
  return normalizeWebQuery(value)
    .split(" ")
    .filter((word) => word.length >= 4 && !GENERIC_ENTITY_WORDS.has(word));
}

export function isLikelyFirstPartySourceForRequest(
  source: WebSource,
  context: WebEvidenceContext,
  subjectEntity = "",
): boolean {
  const requestText = normalizeWebQuery(`${context.question} ${context.query}`);
  const declaredEntityWords = distinctiveEntityWords(subjectEntity);
  const requestEntityWords = distinctiveEntityWords(
    `${context.question} ${context.query}`,
  );
  const entityWords =
    declaredEntityWords.length > 0 ? declaredEntityWords : requestEntityWords;

  if (
    declaredEntityWords.length > 0 &&
    !declaredEntityWords.some((word) => requestText.includes(word))
  ) {
    return false;
  }

  const hostname = normalizeWebQuery(new URL(source.url).hostname);
  return entityWords.some((word) => hostname.includes(word));
}

const RELIABLE_HISTORICAL_HOST_PATTERN =
  /(?:^|[.-])(?:archive|archives|results|result|timing|speedhive|alphatiming|race-monitor)(?:[.-]|$)/i;

export function isAcceptableWebSourceForRequest(
  source: WebSource,
  context: WebEvidenceContext,
  subjectEntity = "",
): boolean {
  if (isLikelyFirstPartySourceForRequest(source, context, subjectEntity)) {
    return true;
  }

  if (context.temporalMode === "current") {
    return false;
  }

  const entityWords = distinctiveEntityWords(
    subjectEntity || `${context.question} ${context.query}`,
  );
  const url = new URL(source.url);
  const sourceIdentity = normalizeWebQuery(
    `${url.hostname} ${url.pathname} ${source.title}`,
  );

  return (
    RELIABLE_HISTORICAL_HOST_PATTERN.test(url.hostname) &&
    entityWords.some((word) => sourceIdentity.includes(word))
  );
}

function evidenceAddressesFactType(
  factType: WebFactType,
  factText: string,
  evidenceSummary: string,
): boolean {
  const evidence = `${factText} ${evidenceSummary}`;
  const patterns: Partial<Record<WebFactType, RegExp>> = {
    location_address: /\b(address|postcode|postal|located|road|street|lane)\b/i,
    official_website: /\b(official|website|site|url)\b/i,
    contact_information: /\b(contact|phone|telephone|email|call)\b/i,
    opening_hours: /\b(open|opening|hours|closed|am|pm)\b/i,
    events_schedule:
      /\b(event|schedule|dates?|time|championship|race|editions?|annual|january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
    current_fleet:
      /\b(petrol|gasoline|electric|combustion|engine|four[ -]?stroke|two[ -]?stroke|fleet|kart model)\b/i,
    current_product: /\b(product|model|price|stock|available|specification)\b/i,
  };

  return patterns[factType]?.test(evidence) ?? evidence.trim().length > 0;
}

function temporalEvidenceIsValid(
  temporalMode: WebTemporalMode,
  temporalAnswerType: WebTemporalAnswerType,
  historicalDataPoints: string[],
  answerText: string,
): boolean {
  const datedHistoricalPoints = historicalDataPoints.filter((point) =>
    /\b(?:19|20)\d{2}\b/.test(point),
  );
  const distinctDatedPoints = new Set(
    datedHistoricalPoints.map((point) => normalizeWebQuery(point)),
  );

  if (temporalMode === "current") {
    return (
      (temporalAnswerType === "current_confirmed" ||
        temporalAnswerType === "current_not_announced") &&
      historicalDataPoints.length === 0
    );
  }

  if (temporalMode === "historical") {
    return (
      temporalAnswerType === "historical" && distinctDatedPoints.size >= 1
    );
  }

  return (
    temporalAnswerType === "historical_pattern_estimate" &&
    distinctDatedPoints.size >= 2 &&
    /\b(?:estimate|estimated|likely|typically|normally|pattern|not confirmed|unconfirmed)\b/i.test(
      answerText,
    )
  );
}

export function webRetrievalFailureMessage(
  temporalMode: WebTemporalMode,
): string {
  if (temporalMode === "historical") {
    return "I couldn't verify that historical karting information from an authoritative source, so I won't invent a date.";
  }

  if (temporalMode === "historical_pattern") {
    return "I couldn't find enough reliable historical dates to make a responsible estimate. That does not mean a future date has been ruled out; it means the past pattern could not be established.";
  }

  return "I couldn't verify that current information from an official source right now, so I won't guess. Please try again shortly.";
}

export function extractCitedWebSources(output: readonly unknown[]): WebSource[] {
  const citations: WebSource[] = [];

  for (const item of output) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("type" in item) ||
      item.type !== "message" ||
      !("content" in item) ||
      !Array.isArray(item.content)
    ) {
      continue;
    }

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
          citations.push({ title: sourceTitle(url, record.title), url });
        }
      }
    }
  }

  return deduplicateSources(citations);
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
  evidenceContext?: WebEvidenceContext,
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
  const temporalAnswerType = row.temporal_answer_type;
  const historicalDataPoints = row.historical_data_points;

  if (
    typeof row.answer !== "string" ||
    row.answer.trim().length === 0 ||
    typeof row.fact_summary !== "string" ||
    row.fact_summary.trim().length === 0 ||
    typeof row.primary_source_title !== "string" ||
    row.primary_source_title.trim().length === 0 ||
    !requestedSourceUrl ||
    requestedSourceUrl.length > 1_000 ||
    typeof row.subject_entity !== "string" ||
    row.subject_entity.trim().length === 0 ||
    typeof row.evidence_summary !== "string" ||
    row.evidence_summary.trim().length === 0 ||
    !WEB_TEMPORAL_ANSWER_TYPES.includes(
      temporalAnswerType as WebTemporalAnswerType,
    ) ||
    !Array.isArray(historicalDataPoints) ||
    historicalDataPoints.some(
      (dataPoint) =>
        typeof dataPoint !== "string" ||
        dataPoint.trim().length === 0 ||
        dataPoint.length > 300,
    ) ||
    row.is_karting_related !== true ||
    typeof row.used_verified_knowledge !== "boolean" ||
    typeof row.used_structured_knowledge !== "boolean"
  ) {
    throw new Error("OpenAI returned an invalid web-grounded response.");
  }

  const citedSources = extractCitedWebSources(outputItems);
  const selectedSource =
    citedSources.find((source) =>
      equivalentUrl(source.url, requestedSourceUrl),
    ) ??
    citedSources.find((source) =>
      sameAuthorityDomain(source.url, requestedSourceUrl),
    );

  if (!selectedSource) {
    throw new Error(
      "OpenAI did not cite its selected source as evidence for the answer.",
    );
  }

  if (
    evidenceContext &&
    !isAcceptableWebSourceForRequest(
      selectedSource,
      evidenceContext,
      row.subject_entity,
    )
  ) {
    throw new Error(
      evidenceContext.temporalMode === "current"
        ? "OpenAI selected a source that is not first-party for the requested entity."
        : "OpenAI selected a source that is not authoritative historical evidence for the requested entity.",
    );
  }

  if (
    evidenceContext &&
    !temporalEvidenceIsValid(
      evidenceContext.temporalMode,
      temporalAnswerType as WebTemporalAnswerType,
      historicalDataPoints as string[],
      row.answer,
    )
  ) {
    throw new Error(
      "OpenAI's response did not satisfy the requested temporal evidence standard.",
    );
  }

  if (
    evidenceContext &&
    !evidenceAddressesFactType(
      evidenceContext.factType,
      row.fact_summary,
      row.evidence_summary,
    )
  ) {
    throw new Error(
      "OpenAI's cited evidence does not address the requested factual claim.",
    );
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
    temporalAnswerType: temporalAnswerType as WebTemporalAnswerType,
    historicalDataPoints: (historicalDataPoints as string[]).map((point) =>
      point.trim(),
    ),
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
