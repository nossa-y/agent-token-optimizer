import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import type {
  AnalyzedSymbol,
  WorkspaceAnalysisIndex,
  WorkspaceFile,
  WorkspaceFileAnalysis,
  WorkspaceIndex,
} from "../contracts";
import {
  WORKSPACE_ANALYSIS_INDEX_VERSION,
  WorkspaceAnalysisIndexSchema,
} from "../contracts";
import { createWorkspacePathPolicy } from "../security";

export interface WorkspaceAnalyzer {
  readonly id: string;
  supports: (language: string | undefined) => boolean;
  analyze: (input: {
    readonly content: string;
    readonly file: WorkspaceFile;
  }) => Omit<WorkspaceFileAnalysis, "internalDependencies" | "ownership" | "policy">;
}

export interface AnalyzeWorkspaceOptions {
  readonly workspaceIndex: WorkspaceIndex;
  readonly packageVersion?: string;
  readonly operationId?: string;
  readonly previousIndex?: WorkspaceAnalysisIndex;
  readonly analyzers?: readonly WorkspaceAnalyzer[];
  readonly now?: Date;
}

interface PackageOwner {
  readonly path: string;
  readonly name?: string;
}

const DEFAULT_ANALYZERS: readonly WorkspaceAnalyzer[] = [
  createTypeScriptJavaScriptAnalyzer(),
];

export async function analyzeWorkspace(
  options: AnalyzeWorkspaceOptions,
): Promise<WorkspaceAnalysisIndex> {
  const pathPolicy = await createWorkspacePathPolicy(
    options.workspaceIndex.workspace.rootPath,
  );
  const analyzers = options.analyzers ?? DEFAULT_ANALYZERS;
  const previousByPath = getReusablePreviousAnalyses(
    options.previousIndex,
    options.workspaceIndex.workspace.rootHash,
  );
  const packageOwners = await findPackageOwners(options.workspaceIndex, pathPolicy);
  const files: WorkspaceFileAnalysis[] = [];
  let reusedFiles = 0;
  let changedFiles = 0;

  for (const file of options.workspaceIndex.files) {
    const previous = previousByPath.get(file.path);

    if (previous && canReuseAnalysis(previous, file)) {
      files.push({
        ...previous,
        ownership: ownershipForFile(file.path, packageOwners, options.workspaceIndex),
        policy: policyForFile(file),
      });
      reusedFiles += 1;
      continue;
    }

    changedFiles += 1;
    files.push(
      await analyzeFile({
        file,
        pathPolicy,
        analyzers,
        ownership: ownershipForFile(file.path, packageOwners, options.workspaceIndex),
      }),
    );
  }

  const withRelationships = addRelationships(files, options.workspaceIndex.files);
  const statistics = summarizeAnalysisStatistics(
    withRelationships,
    reusedFiles,
    changedFiles,
    previousByPath,
  );

  return WorkspaceAnalysisIndexSchema.parse({
    metadata: {
      contractVersion: "1.0",
      generatedAt: (options.now ?? new Date()).toISOString(),
      generator: {
        name: "agent-token-optimizer",
        version: options.packageVersion ?? "0.1.0",
      },
      ...(options.operationId ? { operationId: options.operationId } : {}),
    },
    indexVersion: WORKSPACE_ANALYSIS_INDEX_VERSION,
    workspace: {
      rootHash: options.workspaceIndex.workspace.rootHash,
      ...(options.workspaceIndex.workspace.name
        ? { name: options.workspaceIndex.workspace.name }
        : {}),
    },
    files: withRelationships,
    documentFrequencies: calculateDocumentFrequencies(withRelationships),
    statistics,
  });
}

export function createTypeScriptJavaScriptAnalyzer(): WorkspaceAnalyzer {
  return {
    id: "typescript_ast",
    supports: (language) => language === "typescript" || language === "javascript",
    analyze: ({ content, file }) => analyzeTypeScriptJavaScript(content, file),
  };
}

async function analyzeFile(input: {
  readonly file: WorkspaceFile;
  readonly pathPolicy: Awaited<ReturnType<typeof createWorkspacePathPolicy>>;
  readonly analyzers: readonly WorkspaceAnalyzer[];
  readonly ownership: WorkspaceFileAnalysis["ownership"];
}): Promise<WorkspaceFileAnalysis> {
  if (input.file.ignored || input.file.generated) {
    return createSkippedAnalysis(input.file, input.ownership);
  }

  try {
    const content = await readFile(
      input.pathPolicy.resolveWorkspacePath(input.file.path),
      "utf8",
    );
    const analyzer = input.analyzers.find((item) => item.supports(input.file.language));
    const analyzed = analyzer
      ? analyzer.analyze({ content, file: input.file })
      : createLexicalFallback(content, input.file);

    return {
      ...analyzed,
      internalDependencies: [],
      ownership: input.ownership,
      policy: policyForFile(input.file),
    };
  } catch {
    return createSkippedAnalysis(input.file, input.ownership);
  }
}

function createSkippedAnalysis(
  file: WorkspaceFile,
  ownership: WorkspaceFileAnalysis["ownership"],
): WorkspaceFileAnalysis {
  return {
    path: file.path,
    ...(file.language ? { language: file.language } : {}),
    ...(file.contentHash ? { contentHash: file.contentHash } : {}),
    analysisMethod: "skipped",
    symbols: [],
    imports: [],
    internalDependencies: [],
    testTargets: [],
    lexicalTerms: [],
    ownership,
    policy: policyForFile(file),
  };
}

function createLexicalFallback(
  content: string,
  file: WorkspaceFile,
): Omit<WorkspaceFileAnalysis, "internalDependencies" | "ownership" | "policy"> {
  return {
    path: file.path,
    ...(file.language ? { language: file.language } : {}),
    ...(file.contentHash ? { contentHash: file.contentHash } : {}),
    analysisMethod: "lexical_fallback",
    symbols: [],
    imports: [],
    testTargets: [],
    lexicalTerms: extractLexicalTerms(`${file.path}\n${content}`),
  };
}

function analyzeTypeScriptJavaScript(
  content: string,
  file: WorkspaceFile,
): Omit<WorkspaceFileAnalysis, "internalDependencies" | "ownership" | "policy"> {
  const sourceFile = ts.createSourceFile(
    file.path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(file.path),
  );
  const symbols: AnalyzedSymbol[] = [];
  const imports = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.add(statement.moduleSpecifier.text);
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.add(statement.moduleSpecifier.text);
      continue;
    }

    symbols.push(...symbolsForStatement(statement, sourceFile));
  }

  return {
    path: file.path,
    ...(file.language ? { language: file.language } : {}),
    ...(file.contentHash ? { contentHash: file.contentHash } : {}),
    analysisMethod: "typescript_ast",
    symbols: uniqueSymbols(symbols),
    imports: [...imports].sort(),
    testTargets: [],
    lexicalTerms: extractLexicalTerms(`${file.path}\n${content}`),
  };
}

function symbolsForStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): AnalyzedSymbol[] {
  const exported = hasExportModifier(statement);
  const createSymbol = (
    name: ts.Identifier,
    kind: AnalyzedSymbol["kind"],
  ): AnalyzedSymbol => ({
    name: name.text,
    kind,
    exported,
    signature: compactSignature(statement.getText(sourceFile)),
  });

  if (ts.isFunctionDeclaration(statement) && statement.name) {
    return [createSymbol(statement.name, "function")];
  }

  if (ts.isClassDeclaration(statement) && statement.name) {
    return [createSymbol(statement.name, "class")];
  }

  if (ts.isInterfaceDeclaration(statement)) {
    return [createSymbol(statement.name, "interface")];
  }

  if (ts.isTypeAliasDeclaration(statement)) {
    return [createSymbol(statement.name, "type")];
  }

  if (ts.isEnumDeclaration(statement)) {
    return [createSymbol(statement.name, "enum")];
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name)
        ? [createSymbol(declaration.name, "variable")]
        : [],
    );
  }

  return [];
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export,
  );
}

function uniqueSymbols(symbols: readonly AnalyzedSymbol[]): AnalyzedSymbol[] {
  const known = new Set<string>();

  return symbols.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.name}`;

    if (known.has(key)) {
      return false;
    }

    known.add(key);
    return true;
  });
}

function scriptKindForFile(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".tsx") {
    return ts.ScriptKind.TSX;
  }

  if (extension === ".jsx") {
    return ts.ScriptKind.JSX;
  }

  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

function addRelationships(
  analyses: readonly WorkspaceFileAnalysis[],
  workspaceFiles: readonly WorkspaceFile[],
): WorkspaceFileAnalysis[] {
  const knownPaths = new Set(
    workspaceFiles.filter((file) => !file.ignored).map((file) => file.path),
  );
  const sourcePaths = workspaceFiles
    .filter((file) => !file.ignored && file.kind === "source")
    .map((file) => file.path);

  return analyses.map((analysis) => {
    const internalDependencies = analysis.imports
      .map((specifier) => resolveInternalDependency(analysis.path, specifier, knownPaths))
      .filter((dependency): dependency is string => dependency !== undefined);

    return {
      ...analysis,
      internalDependencies: [...new Set(internalDependencies)].sort(),
      testTargets:
        analysis.policy.kind === "test"
          ? findTestTargets(analysis, sourcePaths, internalDependencies)
          : [],
    };
  });
}

function resolveInternalDependency(
  importerPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const basePath = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerPath), specifier),
  );

  if (basePath === ".." || basePath.startsWith("../")) {
    return undefined;
  }

  const candidates = [
    basePath,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map(
      (extension) => `${basePath}${extension}`,
    ),
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => `${basePath}/index${extension}`),
  ];

  return candidates.find((candidate) => knownPaths.has(candidate));
}

function findTestTargets(
  analysis: WorkspaceFileAnalysis,
  sourcePaths: readonly string[],
  internalDependencies: readonly string[],
): string[] {
  const importedSources = internalDependencies.filter((dependency) =>
    sourcePaths.includes(dependency),
  );

  if (importedSources.length > 0) {
    return importedSources;
  }

  const testStem = normalizeTestStem(analysis.path);

  return sourcePaths.filter((sourcePath) => normalizeSourceStem(sourcePath) === testStem);
}

function normalizeTestStem(relativePath: string): string {
  return normalizeSourceStem(
    relativePath.replace(/\.(test|spec)\.[^.]+$/u, "").replace(/(^|\/)tests?\//u, "$1"),
  );
}

function normalizeSourceStem(relativePath: string): string {
  const parsed = path.posix.parse(relativePath);

  return path.posix.join(parsed.dir, parsed.name).replace(/^src\//u, "");
}

function extractLexicalTerms(content: string): string[] {
  const terms = content
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .match(/[a-z][a-z0-9_$-]{1,}/gu);

  return [...new Set(terms ?? [])].sort().slice(0, 200);
}

async function findPackageOwners(
  workspaceIndex: WorkspaceIndex,
  pathPolicy: Awaited<ReturnType<typeof createWorkspacePathPolicy>>,
): Promise<PackageOwner[]> {
  const packageFiles = workspaceIndex.files.filter(
    (file) => !file.ignored && path.posix.basename(file.path) === "package.json",
  );
  const owners = await Promise.all(
    packageFiles.map(async (file): Promise<PackageOwner> => {
      const packagePath = path.posix.dirname(file.path);

      try {
        const parsed = JSON.parse(
          await readFile(pathPolicy.resolveWorkspacePath(file.path), "utf8"),
        ) as { name?: unknown };

        return {
          path: packagePath,
          ...(typeof parsed.name === "string" && parsed.name.length > 0
            ? { name: parsed.name }
            : {}),
        };
      } catch {
        return { path: packagePath };
      }
    }),
  );

  return owners.sort((left, right) => right.path.length - left.path.length);
}

function ownershipForFile(
  filePath: string,
  packageOwners: readonly PackageOwner[],
  workspaceIndex: WorkspaceIndex,
): WorkspaceFileAnalysis["ownership"] {
  const packageOwner = packageOwners.find(
    (owner) => owner.path === "." || filePath.startsWith(`${owner.path}/`),
  );

  return {
    ...(workspaceIndex.workspace.name
      ? { workspaceName: workspaceIndex.workspace.name }
      : {}),
    ...(packageOwner ? { packagePath: packageOwner.path } : {}),
    ...(packageOwner?.name ? { packageName: packageOwner.name } : {}),
  };
}

function policyForFile(file: WorkspaceFile): WorkspaceFileAnalysis["policy"] {
  return {
    kind: file.kind,
    generated: file.generated,
    ignored: file.ignored,
    ...(file.ignoreReason ? { ignoreReason: file.ignoreReason } : {}),
  };
}

function getReusablePreviousAnalyses(
  previousIndex: WorkspaceAnalysisIndex | undefined,
  workspaceRootHash: string,
): Map<string, WorkspaceFileAnalysis> {
  if (
    !previousIndex ||
    previousIndex.indexVersion !== WORKSPACE_ANALYSIS_INDEX_VERSION ||
    previousIndex.workspace.rootHash !== workspaceRootHash
  ) {
    return new Map();
  }

  return new Map(previousIndex.files.map((file) => [file.path, file] as const));
}

function canReuseAnalysis(previous: WorkspaceFileAnalysis, file: WorkspaceFile): boolean {
  return (
    previous.contentHash === file.contentHash &&
    previous.language === file.language &&
    previous.policy.kind === file.kind &&
    previous.policy.generated === file.generated &&
    previous.policy.ignored === file.ignored &&
    previous.policy.ignoreReason === file.ignoreReason
  );
}

function calculateDocumentFrequencies(
  files: readonly WorkspaceFileAnalysis[],
): Record<string, number> {
  const counts = new Map<string, number>();

  for (const file of files) {
    for (const term of file.lexicalTerms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeAnalysisStatistics(
  files: readonly WorkspaceFileAnalysis[],
  reusedFiles: number,
  changedFiles: number,
  previousByPath: ReadonlyMap<string, WorkspaceFileAnalysis>,
): WorkspaceAnalysisIndex["statistics"] {
  const currentPaths = new Set(files.map((file) => file.path));

  return {
    analyzedFiles: files.filter((file) => file.analysisMethod === "typescript_ast")
      .length,
    fallbackFiles: files.filter((file) => file.analysisMethod === "lexical_fallback")
      .length,
    skippedFiles: files.filter((file) => file.analysisMethod === "skipped").length,
    reusedFiles,
    changedFiles,
    deletedFiles: [...previousByPath.keys()].filter(
      (filePath) => !currentPaths.has(filePath),
    ).length,
  };
}

function compactSignature(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();

  return compact.length <= 600
    ? compact
    : `${compact.slice(0, 588).trimEnd()} [truncated]`;
}
