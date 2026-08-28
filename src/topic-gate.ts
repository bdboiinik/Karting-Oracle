export type TopicClassification = "karting" | "obviously_off_topic" | "ambiguous";

export const OFF_TOPIC_RESPONSE =
  "🏁 I'm Karting Oracle — I can only help with karting-related questions.";

const KARTING_PATTERN =
  /\b(karts?|karting|go[ -]?kart|racecraft|races?|racing|tracks?|circuits?|racing line|apex|chassis|sprocket|tyre|tire|brake bias|steering|lap times?|paddock|grid|helmet|race suit|rib protector|rental kart|owner[ -]?driver|rotax|x30|iame|lo206|brkc|rental league|kart club|motorsport|discount codes?|brad(?:'s)? gear)\b/i;

const OBVIOUSLY_OFF_TOPIC_PATTERN =
  /\b(football|soccer|premier league|homework|algebra|calculus|write (?:me )?code|javascript|typescript|python|programming|general trivia|capital of|president of|prime minister|world war|photosynthesis|celebrity gossip|cryptocurrency|stock price|recipe|cooking|movie review|song lyrics)\b/i;

const GENERAL_WEATHER_PATTERN =
  /\b(?:weather|forecast|temperature)\b/i;

export function classifyTopic(
  question: string,
  hasConversationContext: boolean,
  hasRelevantKnowledge: boolean,
): TopicClassification {
  if (KARTING_PATTERN.test(question)) {
    return "karting";
  }

  if (
    OBVIOUSLY_OFF_TOPIC_PATTERN.test(question) ||
    GENERAL_WEATHER_PATTERN.test(question)
  ) {
    return "obviously_off_topic";
  }

  if (hasConversationContext) {
    return "karting";
  }

  if (hasRelevantKnowledge) {
    return "karting";
  }

  return "ambiguous";
}
