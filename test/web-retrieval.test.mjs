import assert from "node:assert/strict";
import test from "node:test";

import {
  appendWebSourceCitation,
  createWebCacheKey,
  getWebSearchDiagnostics,
  parseWebSourcedAnswer,
  resolveWebRetrievalRequest,
  webCacheTtlMs,
  isLikelyFirstPartySourceForRequest,
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

test("routes a resolved venue petrol-or-electric fleet question to the web", () => {
  const request = resolveWebRetrievalRequest(
    "Original question: Are the karts at Silverton petrol or electric?\nUser clarification: Silverstone Karting at Silverstone Circuit",
    { isKartingRelated: true },
    "",
  );

  assert.equal(request?.factType, "current_fleet");
  assert.match(request?.query ?? "", /Silverstone/i);
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
      subject_entity: "Buckmore Park",
      evidence_summary:
        "Buckmore Park's official contact page gives its full address and postcode.",
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
      {
        type: "message",
        content: [
          {
            type: "output_text",
            annotations: [
              {
                type: "url_citation",
                title: "Buckmore Park",
                url: sourceUrl,
              },
            ],
          },
        ],
      },
    ],
    false,
    false,
    {
      question: "Where is Buckmore Park located?",
      query: "Buckmore Park official address postcode",
      factType: "location_address",
    },
  );

  assert.equal(parsed.source.url, sourceUrl);
  assert.match(
    appendWebSourceCitation(parsed.answerText, parsed.source),
    /📎 Source: <https:\/\/www\.buckmore\.co\.uk\/contact\/>/,
  );
});

test("accepts Silverstone first-party citations across official subdomains", () => {
  const citedUrl =
    "https://www.kart.silverstone.co.uk/the-experience?utm_source=openai";
  const parsed = parseWebSourcedAnswer(
    JSON.stringify({
      answer:
        "They are petrol-powered combustion karts, not electric. Silverstone identifies the fleet and the manufacturer specifies four-stroke combustion power, which supports that straightforward conclusion.",
      fact_summary:
        "Kart Silverstone uses petrol-powered four-stroke combustion rental karts.",
      primary_source_title: "Kart Silverstone",
      primary_source_url: "https://www.silverstone.co.uk/karting",
      subject_entity: "Silverstone Karting",
      evidence_summary:
        "The official Silverstone karting page identifies the combustion-powered rental fleet.",
      is_karting_related: true,
      used_verified_knowledge: false,
      used_structured_knowledge: false,
    }),
    [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          sources: [
            { type: "url", url: "https://www.kart.silverstone.co.uk/" },
            { type: "url", url: citedUrl },
            {
              type: "url",
              url: "https://www.sodikart.com/en-gb/karts/rental/rt10-42.html",
            },
          ],
        },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "structured response",
            annotations: [
              {
                type: "url_citation",
                title: "The Experience | Kart Silverstone",
                url: citedUrl,
                start_index: 0,
                end_index: 10,
              },
            ],
          },
        ],
      },
    ],
    false,
    false,
    {
      question:
        "Are the karts at Silverstone Karting at Silverstone Circuit petrol or electric?",
      query: "Silverstone Karting official fleet petrol electric",
      factType: "current_fleet",
    },
  );

  assert.match(parsed.answerText, /petrol-powered combustion karts/i);
  assert.equal(parsed.source.url, citedUrl);
  assert.equal(parsed.source.title, "The Experience | Kart Silverstone");
});

test("reports web tool status and sanitized cited sources", () => {
  const diagnostics = getWebSearchDiagnostics([
    {
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        sources: [
          {
            type: "url",
            url: "https://www.kart.silverstone.co.uk/the-experience?utm_source=openai",
          },
        ],
      },
    },
  ]);

  assert.equal(diagnostics.triggered, true);
  assert.equal(diagnostics.completedCallCount, 1);
  assert.deepEqual(diagnostics.statuses, ["completed"]);
  assert.deepEqual(diagnostics.actions, ["search"]);
  assert.equal(diagnostics.sourceCount, 1);
  assert.deepEqual(diagnostics.sourceDomains, [
    "www.kart.silverstone.co.uk",
  ]);
  assert.deepEqual(diagnostics.sourceUrls, [
    "https://www.kart.silverstone.co.uk/the-experience",
  ]);
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
          subject_entity: "Official Example",
          evidence_summary: "The page gives the venue address.",
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
    /did not cite/,
  );
});

test("rejects a generic karting source for a Silverstone venue claim", () => {
  const weakSource = "https://thegrid-racing.com/karting-guide";
  const context = {
    question:
      "Are the karts at Silverstone Karting at Silverstone Circuit petrol or electric?",
    query: "Silverstone Karting official fleet petrol electric",
    factType: "current_fleet",
  };

  assert.equal(
    isLikelyFirstPartySourceForRequest(
      { title: "Karting guide", url: weakSource },
      context,
      "Silverstone Karting",
    ),
    false,
  );

  assert.throws(
    () =>
      parseWebSourcedAnswer(
        JSON.stringify({
          answer: "The karts are petrol powered.",
          fact_summary: "The venue uses petrol karts.",
          primary_source_title: "Karting guide",
          primary_source_url: weakSource,
          subject_entity: "Silverstone Karting",
          evidence_summary:
            "This generic guide discusses petrol-powered rental karts.",
          is_karting_related: true,
          used_verified_knowledge: false,
          used_structured_knowledge: false,
        }),
        [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                annotations: [
                  {
                    type: "url_citation",
                    title: "Karting guide",
                    url: weakSource,
                  },
                ],
              },
            ],
          },
        ],
        false,
        false,
        context,
      ),
    /not first-party/,
  );
});

test("keeps the source citation when a long answer must be shortened", () => {
  const source = {
    title: "Official venue",
    url: "https://official.example/venue/address",
  };
  const displayed = appendWebSourceCitation("A".repeat(1_800), source);

  assert.ok(displayed.length <= 1_800);
  assert.ok(!displayed.includes("..."));
  assert.ok(displayed.endsWith(`📎 Source: <${source.url}>`));
});
