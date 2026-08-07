import type { Redaction } from "../contracts";

export interface RedactTextResult {
  readonly text: string;
  readonly redactions: Redaction[];
}

const SECRET_PATTERNS = [
  /\b((?:[A-Z0-9_]*SECRET[A-Z0-9_]*|[A-Z0-9_]*TOKEN[A-Z0-9_]*|[A-Z0-9_]*PASSWORD[A-Z0-9_]*)\s*=\s*)([^\s"'`]+)/giu,
  /\b(sk-[A-Za-z0-9_-]{16,})\b/gu,
] as const;

export function redactText(value: string): RedactTextResult {
  let redactedText = value;
  let redactionCount = 0;

  for (const pattern of SECRET_PATTERNS) {
    redactedText = redactedText.replace(pattern, (...matches: string[]) => {
      redactionCount += 1;

      if (matches.length >= 3 && matches[1]?.includes("=")) {
        return `${matches[1]}[REDACTED]`;
      }

      return "[REDACTED]";
    });
  }

  return {
    text: redactedText,
    redactions:
      redactionCount > 0
        ? [
            {
              redacted: true,
              reason: "secret_pattern",
              replacement: "[REDACTED]",
            },
          ]
        : [],
  };
}
