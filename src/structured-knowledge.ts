export const KNOWLEDGE_CATEGORIES = [
  "discount_codes",
  "recommended_gear",
  "brads_gear",
  "events_schedule",
  "links",
  "general_karting",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export interface StructuredKnowledge {
  id: string;
  title: string;
  category: KnowledgeCategory;
  content: string;
  url: string | undefined;
  isActive?: boolean;
  relevance?: number;
}

export const KNOWLEDGE_CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  discount_codes: "Discount codes",
  recommended_gear: "Recommended gear",
  brads_gear: "Brad's gear",
  events_schedule: "Events / schedule",
  links: "Links",
  general_karting: "General karting information",
};

export function isKnowledgeCategory(value: unknown): value is KnowledgeCategory {
  return (
    typeof value === "string" &&
    KNOWLEDGE_CATEGORIES.includes(value as KnowledgeCategory)
  );
}

export function normalizeOptionalKnowledgeUrl(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed || trimmed.toLowerCase() === "none") {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Knowledge URLs must be valid HTTP or HTTPS URLs.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Knowledge URLs must use HTTP or HTTPS.");
  }

  return url.toString();
}

export function renderKnowledgeItem(item: StructuredKnowledge): string {
  const status = item.isActive === false ? "Inactive" : "Active";
  const url = item.url ? `\nURL: ${item.url}` : "";

  return `**${item.title}** (${KNOWLEDGE_CATEGORY_LABELS[item.category]})\nID: \`${item.id}\`\nStatus: ${status}\n${item.content}${url}`;
}
