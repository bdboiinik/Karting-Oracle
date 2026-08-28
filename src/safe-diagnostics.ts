const SECRET_ENVIRONMENT_VARIABLES = [
  "DISCORD_TOKEN",
  "OPENAI_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export function redactSensitiveText(value: string): string {
  let redacted = value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bsb_secret_[A-Za-z0-9_-]+\b/g, "[REDACTED_SUPABASE_KEY]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");

  for (const name of SECRET_ENVIRONMENT_VARIABLES) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) {
      redacted = redacted.replaceAll(secret, `[REDACTED_${name}]`);
    }
  }

  return redacted;
}

export function safeErrorDetails(error: unknown): string {
  const details: Record<string, string | number> = {};

  if (error instanceof Error) {
    details.name = error.name;
    details.message = redactSensitiveText(error.message);
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;

    for (const field of [
      "status",
      "code",
      "type",
      "param",
      "message",
      "requestID",
      "request_id",
    ]) {
      const value = record[field];
      if (typeof value === "string" || typeof value === "number") {
        details[field] =
          typeof value === "string" ? redactSensitiveText(value) : value;
      }
    }

    if (typeof record.cause === "object" && record.cause !== null) {
      const cause = record.cause as Record<string, unknown>;
      if (typeof cause.code === "string") details.causeCode = cause.code;
      if (typeof cause.message === "string") {
        details.causeMessage = redactSensitiveText(cause.message);
      }
    }
  }

  return JSON.stringify(
    Object.keys(details).length > 0 ? details : { name: "UnknownError" },
  );
}
