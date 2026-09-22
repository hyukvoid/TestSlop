/**
 * Node-side wrapper around the pytest adapter.
 *
 * The Python process is a pure function: JSON in, JSON out, no filesystem
 * access, no imports of the code under analysis. That matters because TestSlop
 * must be able to parse the *base revision* of a file, which no longer exists on
 * disk, and because importing a user's production module to analyse it would be
 * both slow and unsafe.
 *
 * If no interpreter is available the adapter degrades to "skip Python files"
 * rather than failing the scan.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import type { ProductionFileModel, TestFileModel } from "../../core/types.ts";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "extract.py");

let cachedInterpreter: string | null | undefined;

export async function pythonAvailable(): Promise<boolean> {
  return (await interpreter()) !== null;
}

async function interpreter(): Promise<string | null> {
  if (cachedInterpreter !== undefined) return cachedInterpreter;
  for (const candidate of ["python3", "python", "py"]) {
    try {
      await exec(candidate, ["-c", "import ast,json,sys"], { windowsHide: true, timeout: 15_000 });
      cachedInterpreter = candidate;
      return candidate;
    } catch {
      // try next
    }
  }
  cachedInterpreter = null;
  return null;
}

async function run(kind: "test" | "production", filePath: string, content: string): Promise<unknown> {
  const bin = await interpreter();
  if (!bin) throw new Error("no python interpreter available");

  const child = execFile(bin, [SCRIPT], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const payload = JSON.stringify({ kind, path: filePath, content });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (d: Buffer) => stdout.push(Buffer.from(d)));
  child.stderr?.on("data", (d: Buffer) => stderr.push(Buffer.from(d)));

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`python adapter exited ${code}: ${Buffer.concat(stderr).toString().slice(0, 500)}`));
    });
  });

  child.stdin?.end(payload);
  await done;
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

export async function parsePythonTestFile(filePath: string, content: string): Promise<TestFileModel> {
  try {
    const raw = (await run("test", filePath, content)) as TestFileModel;
    // Normalise optional collections so rules can treat every adapter's output
    // uniformly instead of guarding each field access.
    for (const c of raw.cases ?? []) {
      c.assertions ??= [];
      c.implicitAssertions ??= [];
      c.mockOps ??= [];
      c.calls ??= [];
    }
    raw.cases ??= [];
    raw.imports ??= [];
    raw.moduleMocks ??= [];
    raw.problems ??= [];
    return raw;
  } catch (err) {
    return {
      path: filePath,
      framework: "pytest",
      cases: [],
      imports: [],
      moduleMocks: [],
      problems: [`python adapter failed: ${(err as Error).message}`],
    };
  }
}

export async function parsePythonProductionFile(filePath: string, content: string): Promise<ProductionFileModel> {
  try {
    const raw = (await run("production", filePath, content)) as Omit<ProductionFileModel, "returnExpressions"> & {
      returnExpressions: Record<string, string[]>;
    };
    return {
      path: raw.path,
      signals: raw.signals,
      exportedNames: raw.exportedNames,
      returnExpressions: new Map(Object.entries(raw.returnExpressions ?? {})),
      problems: raw.problems ?? [],
    };
  } catch (err) {
    return {
      path: filePath,
      signals: [],
      exportedNames: [],
      returnExpressions: new Map(),
      problems: [`python adapter failed: ${(err as Error).message}`],
    };
  }
}

export const _internal = { interpreter };
