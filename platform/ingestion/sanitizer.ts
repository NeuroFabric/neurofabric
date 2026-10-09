export function sanitizeTelemetry<T = any>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  // Handle strings: redact credentials without consuming JSON delimiters
  if (typeof input === "string") {
    return input
      .replace(/(aws_access_key_id|aws_secret_access_key)(\s*[:=]\s*)[^\s,"'}\]&;]+/gi, "$1$2[REDACTED]")
      .replace(/("(?:aws_access_key_id|aws_secret_access_key)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2") as unknown as T;
  }

  // Handle arrays
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeTelemetry(item)) as unknown as T;
  }

  // Handle objects recursively
  if (typeof input === "object") {
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      if (/^(?:aws_access_key_id|aws_secret_access_key|password|token|secret)$/i.test(key)) {
        cleaned[key] = "[REDACTED]";
      } else {
        cleaned[key] = sanitizeTelemetry(value);
      }
    }
    return cleaned as T;
  }

  return input;
}