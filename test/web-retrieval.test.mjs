import assert from "node:assert/strict";
import test from "node:test";

import {
  appendWebSourceCitation,
  createWebCacheKey,
  parseWebSourcedAnswer,
  resolveWebRetrievalRequest,
  webCacheTtlMs,
} from "../dist/web-retrieval.js";

test("forces incomplete karting venue locations through web retrieval", () => {
  const request = resolveWebRetrievalRequest(
    "Where is Buckmore located?",
    { isKartingRelated: true },
    "",
  );

  assert.equal(request?.factType, "location_address");
  assert.match(request?.query ?? "", /Buckmore/i);
  assert.match(request?.query ?? "", /official karting venue/i);
});

test("does not route an off-topic location question to the web", () => {
  assert.equal(
    resolveWebRetrievalRequest(
      "Where is Buckingham Palace located?",
      { isKartingRelated: false },
      "",
    ),
    undefined,
  );
});

test("does not route ordinary karting advice without a model request", () => {
  assert.equal(
    resolveWebRetrievalRequest(
      "How can I improve my braking consistency?",
      { isKartingRelated: true },
      "",
    ),
    undefined,
  );
});

test("does not retrieve a venue location already complete in trusted knowledge", () => {
  assert.equal(
    resolveWebRetrievalRequest(
      "Where is Buckmore located?",
      {
        isKartingRelated: true,
        webRetrievalRequest: {
          query: "Buckmore Park official address postcode",
          factType: "location_address",
        },
      },
      "Buckmore Park, Maidstone Road, Chatham, Kent, ME5 9QG",
    ),
    undefined,
  );
});

test("normalizes equivalent queries into the same cache key", () => {
  assert.equal(
    createWebCacheKey(
      "  Buckmore PARK -- official address postcode ",
      "location_address",
    ),
    createWebCacheKey(
      "buckmore park official address postcode",
      "location_address",
    ),
  );
});

test("uses long TTLs for addresses and short TTLs for schedules", () => {
  assert.ok(
    webCacheTtlMs("location_address") > webCacheTtlMs("current_fleet"),
  );
  assert.ok(
    webCacheTtlMs("opening_hours") > webCacheTtlMs("events_schedule"),
  );
});

test("accepts only a source actually returned by the web tool", () => {
  const sourceUrl = "https://www.buckmore.co.uk/contact/";
  const parsed = parseWebSourcedAnswer(
    JSON.stringify({
      answer: "Buckmore Park is at Maidstone Road, Chatham, Kent, ME5 9QG.",
      fact_summary: "Maidstone Road, Chatham, Kent, ME5 9QG",
      primary_source_title: "Buckmore Park",
      primary_source_url: sourceUrl,
      is_karting_related: true,
      used_verified_knowledge: false,
      used_structured_knowledge: false,
    }),
    [
      {
        type: "web_search_call",
        action: {
          type: "search",
          sources: [{ type: "url", url: sourceUrl }],
        },
      },
    ],
    false,
    false,
  );

  assert.equal(parsed.source.url, sourceUrl);
  assert.match(
    appendWebSourceCitation(parsed.answerText, parsed.source),
    /📎 Source: <https:\/\/www\.buckmore\.co\.uk\/contact\/>/,
  );
});

test("rejects a model-selected source that the web tool did not consult", () => {
  assert.throws(
    () =>
      parseWebSourcedAnswer(
        JSON.stringify({
          answer: "An unsupported answer.",
          fact_summary: "Unsupported fact",
          primary_source_title: "Invented",
          primary_source_url: "https://invented.example/address",
          is_karting_related: true,
          used_verified_knowledge: false,
          used_structured_knowledge: false,
        }),
        [
          {
            type: "web_search_call",
            action: {
              type: "search",
              sources: [
                { type: "url", url: "https://official.example/address" },
              ],
            },
          },
        ],
        false,
        false,
      ),
    /did not substantiate/,
  );
});

test("keeps the source citation when a long answer must be shortened", () => {
  const source = {
    title: "Official venue",
    url: "https://official.example/venue/address",
  };
  const displayed = appendWebSourceCitation("A".repeat(1_800), source);

  assert.ok(displayed.length <= 1_850);
  assert.ok(displayed.endsWith(`📎 Source: <${source.url}>`));
});
