import assert from "node:assert/strict";
import test from "node:test";

import {
  appendWebSourceCitation,
  classifyWebTemporalIntent,
  createWebCacheKey,
  getWebSearchDiagnostics,
  isAcceptableWebSourceForRequest,
  parseWebSourcedAnswer,
  resolveWebRetrievalRequest,
  webCacheTtlMs,
  isLikelyFirstPartySourceForRequest,
  webRetrievalFailureMessage,
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
  assert.equal(request?.temporalMode, "current");
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
          temporalMode: "current",
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
  assert.ok(
    webCacheTtlMs("events_schedule", "historical_pattern") >
      webCacheTtlMs("events_schedule", "current"),
  );
  assert.notEqual(
    createWebCacheKey("BRKC dates", "events_schedule", "current"),
    createWebCacheKey(
      "BRKC dates",
      "events_schedule",
      "historical_pattern",
    ),
  );
});

test("When is BRKC 2027 remains a current confirmation question", () => {
  const question = "When is BRKC 2027?";
  const request = resolveWebRetrievalRequest(
    question,
    { isKartingRelated: true },
    "",
  );

  assert.equal(classifyWebTemporalIntent(question, 2026), "current");
  assert.equal(request?.factType, "events_schedule");
  assert.equal(request?.temporalMode, "current");
  assert.match(request?.query ?? "", /confirmed event date announcement/i);
});

test("When is BRKC normally held routes to historical pattern research", () => {
  const question = "When is BRKC normally held?";
  const request = resolveWebRetrievalRequest(
    question,
    { isKartingRelated: true },
    "",
  );

  assert.equal(classifyWebTemporalIntent(question), "historical_pattern");
  assert.equal(request?.temporalMode, "historical_pattern");
  assert.match(request?.query ?? "", /historical dates previous editions/i);
});

test("BRKC past-years requests accept several dates and a labelled estimate", () => {
  const question = "When is BRKC held based on past years?";
  const request = resolveWebRetrievalRequest(
    question,
    { isKartingRelated: true },
    "",
  );
  const sourceUrl = "https://brkc.co.uk/history";

  assert.equal(request?.temporalMode, "historical_pattern");
  const parsed = parseWebSourcedAnswer(
    JSON.stringify({
      answer:
        "**Estimate — not confirmed:** BRKC would most likely be held in mid-to-late January. Recent editions were held on similar January weekends, but wait for the organiser's announcement before making plans.",
      fact_summary:
        "BRKC has historically run in January; a future unannounced edition is most likely in mid-to-late January.",
      primary_source_title: "BRKC history",
      primary_source_url: sourceUrl,
      subject_entity: "BRKC",
      evidence_summary:
        "The official BRKC history lists January dates for multiple previous editions.",
      temporal_answer_type: "historical_pattern_estimate",
      historical_data_points: [
        "BRKC 2024: 19–21 January 2024",
        "BRKC 2025: 17–19 January 2025",
        "BRKC 2026: 16–18 January 2026",
      ],
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
                title: "BRKC history",
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
      question,
      query: request?.query ?? "",
      factType: "events_schedule",
      temporalMode: "historical_pattern",
    },
  );

  assert.equal(parsed.temporalAnswerType, "historical_pattern_estimate");
  assert.equal(parsed.historicalDataPoints.length, 3);
  assert.match(parsed.answerText, /Estimate/i);
  assert.doesNotMatch(
    webRetrievalFailureMessage("historical_pattern"),
    /current information/i,
  );
});

test("current event questions cannot be answered with an unlabelled estimate", () => {
  const sourceUrl = "https://brkc.co.uk/";

  assert.throws(
    () =>
      parseWebSourcedAnswer(
        JSON.stringify({
          answer: "BRKC 2027 will probably be in January.",
          fact_summary: "BRKC 2027 may be in January.",
          primary_source_title: "BRKC",
          primary_source_url: sourceUrl,
          subject_entity: "BRKC",
          evidence_summary: "The official site describes the annual event.",
          temporal_answer_type: "historical_pattern_estimate",
          historical_data_points: [
            "BRKC 2025 was in January",
            "BRKC 2026 was in January",
          ],
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
                  { type: "url_citation", title: "BRKC", url: sourceUrl },
                ],
              },
            ],
          },
        ],
        false,
        false,
        {
          question: "When is BRKC 2027?",
          query: "BRKC 2027 official confirmed event date announcement",
          factType: "events_schedule",
          temporalMode: "current",
        },
      ),
    /temporal evidence standard/,
  );
});

test("entity-matched timing sources are historical support, not current authority", () => {
  const source = {
    title: "BRKC 2025 results",
    url: "https://results.alphatiming.co.uk/brkc/2025",
  };
  const baseContext = {
    question: "When was BRKC 2025 held?",
    query: "BRKC 2025 historical event date results archive",
    factType: "events_schedule",
  };

  assert.equal(
    isAcceptableWebSourceForRequest(
      source,
      { ...baseContext, temporalMode: "historical" },
      "BRKC",
    ),
    true,
  );
  assert.equal(
    isAcceptableWebSourceForRequest(
      source,
      { ...baseContext, temporalMode: "current" },
      "BRKC",
    ),
    false,
  );
});

test("a future BRKC question may clearly report that the date is not announced", () => {
  const sourceUrl = "https://brkc.co.uk/";
  const parsed = parseWebSourcedAnswer(
    JSON.stringify({
      answer:
        "BRKC 2027 has not been officially announced yet, so there is no confirmed date to report.",
      fact_summary: "No official BRKC 2027 event date has been announced.",
      primary_source_title: "BRKC",
      primary_source_url: sourceUrl,
      subject_entity: "BRKC",
      evidence_summary:
        "The official BRKC site does not list a confirmed 2027 event date.",
      temporal_answer_type: "current_not_announced",
      historical_data_points: [],
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
              { type: "url_citation", title: "BRKC", url: sourceUrl },
            ],
          },
        ],
      },
    ],
    false,
    false,
    {
      question: "When is BRKC 2027?",
      query: "BRKC 2027 official confirmed event date announcement",
      factType: "events_schedule",
      temporalMode: "current",
    },
  );

  assert.equal(parsed.temporalAnswerType, "current_not_announced");
  assert.match(parsed.answerText, /not been officially announced/i);
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
      temporal_answer_type: "current_confirmed",
      historical_data_points: [],
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
      temporalMode: "current",
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
      temporal_answer_type: "current_confirmed",
      historical_data_points: [],
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
      temporalMode: "current",
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
          temporal_answer_type: "current_confirmed",
          historical_data_points: [],
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
    temporalMode: "current",
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
          temporal_answer_type: "current_confirmed",
          historical_data_points: [],
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
