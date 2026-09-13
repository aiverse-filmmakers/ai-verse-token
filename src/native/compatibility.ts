import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AI_VERSE_EXTENSION_REGISTRY_PATH,
  AI_VERSE_REQUIRED_ARCHITECTURE,
  AI_VERSE_REQUIRED_SCHEMA_MAJOR
} from "./constants.js";
import { assertExistingRoot, safeRelativePath, safeRootPath } from "./paths.js";
import type { AiVerseCompatibilityIssue, AiVerseCompatibilityResult } from "./types.js";

const MAX_CONTRACT_BYTES = 1024 * 1024;

function issue(code: string, message: string, relative_path?: string): AiVerseCompatibilityIssue {
  return relative_path === undefined ? { code, message } : { code, message, relative_path };
}

function scalar(contents: string, key: string): string[] {
  const values: string[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue;
    const match = new RegExp(`^${key}\\s*:\\s*(.*?)\\s*(?:#.*)?$`).exec(raw);
    if (match === null) continue;
    let value = match[1]?.trim() ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.push(value);
  }
  return values;
}

function boundedFile(root: string, relativePath: string): string | null {
  const path = safeRelativePath(root, relativePath);
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || statSync(path).size > MAX_CONTRACT_BYTES) return null;
  return readFileSync(path, "utf8");
}

function nodeOk(root: string, relativePath: string, kind: "file" | "directory"): boolean {
  const path = safeRelativePath(root, relativePath);
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return false;
  return kind === "file" ? info.isFile() : info.isDirectory();
}

export function inspectAiVerseOs(rootPath: string): AiVerseCompatibilityResult {
  let candidate: string;
  try { candidate = safeRootPath(rootPath); } catch (error) {
    return { status: "incompatible", root_path: rootPath, schema_major: null, architecture: null, issues: [issue("ROOT_INVALID", error instanceof Error ? error.message : "Invalid root path.")] };
  }
  if (!existsSync(candidate)) {
    return { status: "no-os", root_path: candidate, schema_major: null, architecture: null, issues: [issue("AI_VERSE_NOT_DETECTED", "No filesystem root exists at the candidate path.")] };
  }
  try { assertExistingRoot(candidate); } catch (error) {
    return { status: "incompatible", root_path: candidate, schema_major: null, architecture: null, issues: [issue("ROOT_UNSAFE", error instanceof Error ? error.message : "Unsafe root.")] };
  }

  const manifestPath = safeRelativePath(candidate, "AI-VERSE.yaml");
  if (!existsSync(manifestPath)) {
    const strongEvidence = existsSync(join(candidate, "system", "extensions", "README.md")) || existsSync(join(candidate, ".aiverse", "extensions", "registry.json"));
    return {
      status: strongEvidence ? "incompatible" : "no-os",
      root_path: candidate,
      schema_major: null,
      architecture: null,
      issues: [issue(strongEvidence ? "MANIFEST_MISSING" : "AI_VERSE_NOT_DETECTED", strongEvidence ? "AI-Verse-like host evidence exists but AI-VERSE.yaml is missing." : "No AI-Verse OS manifest was detected.", "AI-VERSE.yaml")]
    };
  }

  const manifest = boundedFile(candidate, "AI-VERSE.yaml");
  if (manifest === null) {
    return { status: "incompatible", root_path: candidate, schema_major: null, architecture: null, issues: [issue("MANIFEST_UNSAFE", "AI-VERSE.yaml must be a bounded regular non-symlink file.", "AI-VERSE.yaml")] };
  }

  const schemaValues = [...scalar(manifest, "schema_version"), ...scalar(manifest, "schema-version"), ...scalar(manifest, "schemaVersion"), ...scalar(manifest, "schema")];
  const architectureValues = scalar(manifest, "architecture");
  const issues: AiVerseCompatibilityIssue[] = [];
  let schemaMajor: number | null = null;
  let architecture: string | null = null;
  if (schemaValues.length !== 1 || !/^\d+(?:\.\d+){0,2}$/.test(schemaValues[0] ?? "")) issues.push(issue("SCHEMA_VERSION_INVALID", "AI-VERSE.yaml must declare exactly one numeric top-level schema version.", "AI-VERSE.yaml"));
  else {
    schemaMajor = Number.parseInt((schemaValues[0] ?? "0").split(".")[0] ?? "0", 10);
    if (schemaMajor !== AI_VERSE_REQUIRED_SCHEMA_MAJOR) issues.push(issue("SCHEMA_VERSION_UNSUPPORTED", `AI-Verse Token requires OS schema major ${AI_VERSE_REQUIRED_SCHEMA_MAJOR}.`, "AI-VERSE.yaml"));
  }
  if (architectureValues.length !== 1) issues.push(issue("ARCHITECTURE_INVALID", "AI-VERSE.yaml must declare exactly one top-level architecture.", "AI-VERSE.yaml"));
  else {
    architecture = architectureValues[0] ?? null;
    if (architecture !== AI_VERSE_REQUIRED_ARCHITECTURE) issues.push(issue("ARCHITECTURE_UNSUPPORTED", `AI-Verse Token requires architecture '${AI_VERSE_REQUIRED_ARCHITECTURE}'.`, "AI-VERSE.yaml"));
  }

  for (const requirement of [
    ["AGENTS.md", "file"],
    ["operator", "directory"],
    ["workspaces", "directory"],
    ["system/extensions/README.md", "file"]
  ] as const) {
    if (!nodeOk(candidate, requirement[0], requirement[1])) issues.push(issue("HOST_CONTRACT_INCOMPLETE", `Required AI-Verse OS path '${requirement[0]}' is missing or unsafe.`, requirement[0]));
  }
  const contract = boundedFile(candidate, "system/extensions/README.md");
  if (contract !== null && !contract.includes(`/${AI_VERSE_EXTENSION_REGISTRY_PATH}`)) {
    issues.push(issue("EXTENSION_CONTRACT_UNSUPPORTED", `OS extension contract does not reference '/${AI_VERSE_EXTENSION_REGISTRY_PATH}'.`, "system/extensions/README.md"));
  }

  return { status: issues.length === 0 ? "compatible" : "incompatible", root_path: candidate, schema_major: schemaMajor, architecture, issues };
}
