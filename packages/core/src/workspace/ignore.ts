import { readFile } from "node:fs/promises";
import path from "node:path";

export type IgnoreOrigin = "gitignore" | "optimizer_config";

export interface IgnoreMatch {
  readonly ignored: boolean;
  readonly origin?: IgnoreOrigin;
}

interface IgnoreRule {
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly origin: IgnoreOrigin;
}

export interface WorkspaceIgnoreMatcher {
  readonly rules: readonly IgnoreRule[];
  match: (relativePath: string, isDirectory: boolean) => IgnoreMatch;
}

export const DEFAULT_OPTIMIZER_IGNORE_PATTERNS = [
  ".git/",
  "node_modules/",
  "dist/",
  "coverage/",
  ".DS_Store",
] as const;

export async function loadWorkspaceIgnoreMatcher(
  rootPath: string,
  extraIgnorePatterns: readonly string[] = [],
): Promise<WorkspaceIgnoreMatcher> {
  const rules: IgnoreRule[] = [
    ...parseIgnorePatterns(DEFAULT_OPTIMIZER_IGNORE_PATTERNS, "optimizer_config"),
    ...parseIgnorePatterns(extraIgnorePatterns, "optimizer_config"),
  ];

  try {
    const gitignore = await readFile(path.join(rootPath, ".gitignore"), "utf8");
    rules.push(...parseIgnorePatterns(gitignore.split(/\r?\n/u), "gitignore"));
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return {
    rules,
    match(relativePath, isDirectory) {
      return matchIgnoreRules(rules, relativePath, isDirectory);
    },
  };
}

function parseIgnorePatterns(
  patterns: readonly string[],
  origin: IgnoreOrigin,
): IgnoreRule[] {
  return patterns.flatMap((rawPattern) => {
    const trimmedPattern = rawPattern.trim();

    if (trimmedPattern === "" || trimmedPattern.startsWith("#")) {
      return [];
    }

    const negated = trimmedPattern.startsWith("!");
    const unprefixedPattern = negated ? trimmedPattern.slice(1) : trimmedPattern;
    const directoryOnly = unprefixedPattern.endsWith("/");
    const patternWithoutSlash = directoryOnly
      ? unprefixedPattern.slice(0, -1)
      : unprefixedPattern;
    const pattern = patternWithoutSlash.replace(/^\/+/u, "");

    if (pattern === "") {
      return [];
    }

    return [
      {
        pattern,
        negated,
        directoryOnly,
        origin,
      },
    ];
  });
}

function matchIgnoreRules(
  rules: readonly IgnoreRule[],
  relativePath: string,
  isDirectory: boolean,
): IgnoreMatch {
  const normalizedPath = normalizeRelativePath(relativePath);
  let match: IgnoreMatch = { ignored: false };

  for (const rule of rules) {
    if (matchesPattern(rule, normalizedPath, isDirectory)) {
      match = rule.negated ? { ignored: false } : { ignored: true, origin: rule.origin };
    }
  }

  return match;
}

function matchesPattern(
  rule: IgnoreRule,
  relativePath: string,
  isDirectory: boolean,
): boolean {
  if (
    rule.directoryOnly &&
    !isDirectory &&
    !relativePath.startsWith(`${rule.pattern}/`)
  ) {
    return false;
  }

  if (rule.pattern.includes("*")) {
    return globToRegExp(rule.pattern).test(relativePath);
  }

  if (rule.pattern.includes("/")) {
    return relativePath === rule.pattern || relativePath.startsWith(`${rule.pattern}/`);
  }

  const segments = relativePath.split("/");
  const basename = segments[segments.length - 1];

  return (
    basename === rule.pattern ||
    segments.includes(rule.pattern) ||
    (rule.directoryOnly && isDirectory && relativePath === rule.pattern)
  );
}

function globToRegExp(pattern: string): RegExp {
  const escapedPattern = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, ".*")
    .replace(/\*/gu, "[^/]*");

  return new RegExp(`(^|/)${escapedPattern}($|/)`, "u");
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
