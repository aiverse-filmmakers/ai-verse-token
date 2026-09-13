import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { TokenNativeError } from "./types.js";

function nodeExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

export function safeRootPath(rootPath: string): string {
  if (rootPath.length === 0 || rootPath.includes("\u0000")) {
    throw new TokenNativeError("UNSAFE_PATH", "Root path must be non-empty and must not contain NUL.");
  }
  return resolve(rootPath);
}

export function safeRelativePath(rootPath: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\u0000") ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new TokenNativeError("UNSAFE_PATH", `Unsafe repository-relative path '${relativePath}'.`);
  }
  const root = safeRootPath(rootPath);
  const candidate = resolve(root, relativePath);
  if (!inside(root, candidate)) {
    throw new TokenNativeError("UNSAFE_PATH", `Path '${relativePath}' resolves outside the AI-Verse root.`);
  }
  return candidate;
}

export function assertExistingRoot(rootPath: string): string {
  const root = safeRootPath(rootPath);
  if (!existsSync(root)) throw new TokenNativeError("AI_VERSE_OS_NOT_FOUND", `Root '${root}' does not exist.`);
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TokenNativeError("SYMLINK_PATH_REJECTED", "AI-Verse root must be a real directory and not a symbolic link.");
  }
  return root;
}

export function ensureSafeDirectory(rootPath: string, relativePath: string): string {
  const root = assertExistingRoot(rootPath);
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (nodeExists(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        throw new TokenNativeError("SYMLINK_PATH_REJECTED", `Path component '${relative(root, current)}' is a symbolic link.`);
      }
      if (!info.isDirectory()) {
        throw new TokenNativeError("UNSAFE_PATH", `Path component '${relative(root, current)}' is not a directory.`);
      }
    } else {
      mkdirSync(current);
    }
  }
  return current;
}

export function assertSafeExistingFile(rootPath: string, relativePath: string): string {
  const root = assertExistingRoot(rootPath);
  const path = safeRelativePath(root, relativePath);
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!nodeExists(current)) break;
    const parentInfo = lstatSync(current);
    if (parentInfo.isSymbolicLink()) throw new TokenNativeError("SYMLINK_PATH_REJECTED", `Path component '${relative(root, current)}' is a symbolic link.`);
    if (!parentInfo.isDirectory()) throw new TokenNativeError("UNSAFE_PATH", `Path component '${relative(root, current)}' is not a directory.`);
  }
  if (!nodeExists(path)) return path;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new TokenNativeError("SYMLINK_PATH_REJECTED", `'${relativePath}' must not be a symbolic link.`);
  if (!info.isFile()) throw new TokenNativeError("UNSAFE_PATH", `'${relativePath}' must be a regular file.`);
  return path;
}
