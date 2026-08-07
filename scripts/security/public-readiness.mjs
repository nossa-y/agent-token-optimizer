import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const forbiddenTrackedPathRules = [
  {
    name: "generated artifact directory",
    test: (filePath) =>
      filePath.startsWith("artifacts/") || filePath.startsWith("output/"),
  },
  {
    name: "coverage directory",
    test: (filePath) => filePath.startsWith("coverage/"),
  },
  {
    name: "compiled dist directory",
    test: (filePath) => filePath.includes("/dist/") || filePath.startsWith("dist/"),
  },
  {
    name: "environment file",
    test: (filePath) =>
      /(^|\/)\.env(\.|$)/u.test(filePath) && !filePath.endsWith(".env.example"),
  },
  {
    name: "local database file",
    test: (filePath) => /\.(sqlite|sqlite3|db)$/iu.test(filePath),
  },
  {
    name: "packed package tarball",
    test: (filePath) => /\.(tgz|zip|tar|gz)$/iu.test(filePath),
  },
  {
    name: "private key file",
    test: (filePath) => /\.(pem|key)$/iu.test(filePath),
  },
  {
    name: "local tool output",
    test: (filePath) =>
      filePath.startsWith(".playwright-cli/") ||
      filePath.endsWith(".log") ||
      filePath.endsWith(".DS_Store"),
  },
];

const secretContentRules = [
  {
    name: "OpenAI-style API key",
    pattern: new RegExp(`${"sk"}-${"[A-Za-z0-9_-]{16,}"}`, "u"),
  },
  {
    name: "GitHub token",
    pattern: new RegExp(`${"ghp"}_${"[A-Za-z0-9_]{20,}"}`, "u"),
  },
  {
    name: "AWS access key",
    pattern: new RegExp(`${"AKIA"}${"[A-Z0-9]{16}"}`, "u"),
  },
  {
    name: "private key block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  },
];

const trackedFiles = await listCandidateFiles();
const errors = [];

for (const filePath of trackedFiles) {
  for (const rule of forbiddenTrackedPathRules) {
    if (rule.test(filePath)) {
      errors.push(`${filePath}: tracked ${rule.name}`);
    }
  }

  const content = await readFile(filePath, "utf8");
  for (const rule of secretContentRules) {
    if (rule.pattern.test(content)) {
      errors.push(`${filePath}: possible ${rule.name}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Public readiness check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Public readiness check passed for ${trackedFiles.length} tracked and untracked candidate files.`,
  );
}

async function listCandidateFiles() {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const candidates = stdout.split("\0").filter(Boolean);
  const existing = await Promise.all(
    candidates.map(async (filePath) => {
      try {
        return (await stat(filePath)).isFile() ? filePath : undefined;
      } catch {
        return undefined;
      }
    }),
  );

  return existing.filter((filePath) => filePath !== undefined);
}
