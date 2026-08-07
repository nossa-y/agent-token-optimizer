import { realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspacePathPolicy {
  readonly rootPath: string;
  readonly rootRealPath: string;
  assertInsideWorkspace: (targetPath: string) => void;
  isInsideWorkspace: (targetPath: string) => boolean;
  resolveWorkspacePath: (relativePath: string) => string;
  toWorkspaceRelativePath: (absolutePath: string) => string;
}

export async function createWorkspacePathPolicy(
  rootPath: string,
): Promise<WorkspacePathPolicy> {
  const resolvedRootPath = path.resolve(rootPath);
  const rootRealPath = await realpath(resolvedRootPath);

  const isInsideWorkspace = (targetPath: string): boolean => {
    const resolvedTargetPath = path.resolve(targetPath);
    const relativePath = path.relative(rootRealPath, resolvedTargetPath);

    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    );
  };

  const assertInsideWorkspace = (targetPath: string): void => {
    if (!isInsideWorkspace(targetPath)) {
      throw new Error(`Path is outside the workspace: ${targetPath}`);
    }
  };

  const resolveWorkspacePath = (relativePath: string): string => {
    const segments = relativePath.split(/[\\/]+/u);

    if (
      path.isAbsolute(relativePath) ||
      relativePath.includes("\0") ||
      segments.includes("..")
    ) {
      throw new Error(`Workspace path must be a safe relative path: ${relativePath}`);
    }

    const resolvedTargetPath = path.resolve(rootRealPath, relativePath);
    assertInsideWorkspace(resolvedTargetPath);

    return resolvedTargetPath;
  };

  const toWorkspaceRelativePath = (absolutePath: string): string => {
    assertInsideWorkspace(absolutePath);

    const relativePath = path.relative(rootRealPath, path.resolve(absolutePath));

    return relativePath.split(path.sep).join("/");
  };

  return {
    rootPath: resolvedRootPath,
    rootRealPath,
    assertInsideWorkspace,
    isInsideWorkspace,
    resolveWorkspacePath,
    toWorkspaceRelativePath,
  };
}
