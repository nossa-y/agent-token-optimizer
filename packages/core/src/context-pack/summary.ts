import type { WorkspaceFile } from "../contracts";

export interface StructuralFileSummary {
  readonly summary: string;
  readonly symbols: string[];
  readonly declarations: string[];
  readonly imports: string[];
  readonly testNames: string[];
  readonly snippet?: string;
}

export interface BuildStructuralSummaryOptions {
  readonly content: string;
  readonly file: Pick<WorkspaceFile, "language" | "path">;
  readonly maxChars: number;
  readonly task?: string;
}

const MAX_SYMBOLS = 6;
const MAX_DECLARATIONS = 6;
const MAX_IMPORTS = 6;
const MAX_TEST_NAMES = 6;
const MAX_SIGNATURE_CHARS = 160;
const MAX_SNIPPET_CHARS = 280;
const TASK_STOP_WORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "and",
  "are",
  "behaviour",
  "behavior",
  "build",
  "code",
  "for",
  "from",
  "into",
  "make",
  "the",
  "this",
  "that",
  "then",
  "update",
  "with",
]);

export function buildStructuralSummary(
  options: BuildStructuralSummaryOptions,
): StructuralFileSummary {
  const declarations = extractDeclarations(
    options.content,
    options.file.language ?? "unknown",
  );
  const symbols = declarations
    .filter((declaration) => declaration.exported)
    .map((declaration) => declaration.signature);
  const testNames = extractTestNames(options.content);
  const imports = extractImports(options.content);
  const snippet = options.task
    ? extractTaskMatchedSnippet(options.content, options.task)
    : undefined;

  return applyCharacterBudget(
    {
      symbols,
      declarations: selectRelevantDeclarations(declarations, options.task).map(
        (declaration) => declaration.signature,
      ),
      imports,
      testNames,
      ...(snippet ? { snippet } : {}),
    },
    options.maxChars,
  );
}

interface Declaration {
  readonly name: string;
  readonly signature: string;
  readonly exported: boolean;
}

function extractDeclarations(content: string, language: string): Declaration[] {
  if (language !== "typescript" && language !== "javascript") {
    return [];
  }

  const declarations: Declaration[] = [];

  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/u,
    );

    if (!match?.[2]) {
      continue;
    }

    declarations.push({
      name: match[2],
      signature: compactLine(line, MAX_SIGNATURE_CHARS),
      exported: Boolean(match[1]),
    });
  }

  return uniqueDeclarations(declarations);
}

function uniqueDeclarations(declarations: readonly Declaration[]): Declaration[] {
  const knownNames = new Set<string>();

  return declarations.filter((declaration) => {
    if (knownNames.has(declaration.name)) {
      return false;
    }

    knownNames.add(declaration.name);
    return true;
  });
}

function selectRelevantDeclarations(
  declarations: readonly Declaration[],
  task?: string,
): Declaration[] {
  const taskTerms = task ? extractTaskTerms(task) : [];
  const matching = declarations.filter((declaration) =>
    taskTerms.some((term) => declaration.signature.toLowerCase().includes(term)),
  );

  return [...matching, ...declarations.filter((item) => !matching.includes(item))].slice(
    0,
    MAX_DECLARATIONS,
  );
}

function extractImports(content: string): string[] {
  const dependencies = new Set<string>();

  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(?:import|export)\b.*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/u,
    );
    const dependency = match?.[1] ?? match?.[2] ?? match?.[3];

    if (dependency) {
      dependencies.add(dependency);
    }
  }

  return [...dependencies].slice(0, MAX_IMPORTS);
}

function extractTestNames(content: string): string[] {
  const testNames = new Set<string>();

  for (const match of content.matchAll(
    /\b(?:it|test|describe)\s*\(\s*["'`]([^"'`]+)["'`]/gu,
  )) {
    if (match[1]) {
      testNames.add(compactLine(match[1], MAX_SIGNATURE_CHARS));
    }
  }

  return [...testNames].slice(0, MAX_TEST_NAMES);
}

function extractTaskMatchedSnippet(content: string, task: string): string | undefined {
  const taskTerms = extractTaskTerms(task);

  if (taskTerms.length === 0) {
    return undefined;
  }

  const lines = content.split(/\r?\n/u);
  let bestIndex = -1;
  let bestScore = 0;

  for (const [index, line] of lines.entries()) {
    const normalized = line.toLowerCase();
    const score = taskTerms.reduce(
      (total, term) => total + Number(normalized.includes(term)),
      0,
    );

    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestIndex < 0) {
    return undefined;
  }

  const snippet = lines
    .slice(Math.max(0, bestIndex - 1), Math.min(lines.length, bestIndex + 3))
    .join("\n")
    .trim();

  return snippet.length > 0 ? compactText(snippet, MAX_SNIPPET_CHARS) : undefined;
}

function extractTaskTerms(task: string): string[] {
  return [...new Set(task.toLowerCase().match(/[a-z0-9_$-]{3,}/gu) ?? [])].filter(
    (term) => !TASK_STOP_WORDS.has(term),
  );
}

function applyCharacterBudget(
  source: Omit<StructuralFileSummary, "summary">,
  maxChars: number,
): StructuralFileSummary {
  const budget = Math.max(80, maxChars);
  let remaining = Math.max(0, budget - 96);
  const snippet = source.snippet
    ? takeSnippet(source.snippet, Math.min(MAX_SNIPPET_CHARS, remaining), (used) => {
        remaining -= used;
      })
    : undefined;
  const testNames = takeStrings(
    source.testNames,
    MAX_TEST_NAMES,
    () => remaining,
    (used) => {
      remaining -= used;
    },
  );
  const imports = takeStrings(
    source.imports,
    MAX_IMPORTS,
    () => remaining,
    (used) => {
      remaining -= used;
    },
  );
  const symbols = takeStrings(
    source.symbols,
    MAX_SYMBOLS,
    () => remaining,
    (used) => {
      remaining -= used;
    },
  );
  const declarations = takeStrings(
    source.declarations.filter((item) => !symbols.includes(item)),
    MAX_DECLARATIONS,
    () => remaining,
    (used) => {
      remaining -= used;
    },
  );
  const summary = compactText(
    describeStructure({
      symbols,
      declarations,
      imports,
      testNames,
      ...(snippet ? { snippet } : {}),
    }),
    budget,
  );

  return {
    summary,
    symbols,
    declarations,
    imports,
    testNames,
    ...(snippet ? { snippet } : {}),
  };
}

function takeStrings(
  values: readonly string[],
  maxItems: number,
  getRemaining: () => number,
  consume: (used: number) => void,
): string[] {
  const selected: string[] = [];

  for (const value of values.slice(0, maxItems)) {
    const remaining = getRemaining();

    if (remaining <= 0) {
      break;
    }

    const compact = compactText(value, Math.min(MAX_SIGNATURE_CHARS, remaining));
    selected.push(compact);
    consume(compact.length + 1);
  }

  return selected;
}

function takeSnippet(
  snippet: string,
  remaining: number,
  consume: (used: number) => void,
): string | undefined {
  if (remaining < 24) {
    return undefined;
  }

  const compact = compactText(snippet, Math.min(MAX_SNIPPET_CHARS, remaining));
  consume(compact.length);
  return compact;
}

function describeStructure(input: {
  readonly symbols: readonly string[];
  readonly declarations: readonly string[];
  readonly imports: readonly string[];
  readonly testNames: readonly string[];
  readonly snippet?: string;
}): string {
  const parts = [
    input.symbols.length > 0 ? `${input.symbols.length} export(s)` : undefined,
    input.declarations.length > 0
      ? `${input.declarations.length} declaration(s)`
      : undefined,
    input.imports.length > 0 ? `${input.imports.length} dependency(ies)` : undefined,
    input.testNames.length > 0 ? `${input.testNames.length} test name(s)` : undefined,
    input.snippet ? "task-matched snippet included" : undefined,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0
    ? `Structural outline: ${parts.join(", ")}.`
    : "No code structure detected.";
}

function compactLine(value: string, maxChars: number): string {
  return compactText(value.replace(/\s+/gu, " ").trim(), maxChars);
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 12)).trimEnd()} [truncated]`;
}
