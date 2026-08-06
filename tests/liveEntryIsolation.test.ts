/**
 * Phase 5B — structural proof that scripts/paper-run.ts (which contains the
 * PAPER-only synthetic-candidate demo) is unreachable from the production
 * entrypoint (scripts/run-agent.ts, what deploy/delphi-agent.service runs).
 *
 * Not just an isLive() runtime check — this walks the actual static import
 * graph starting from run-agent.ts (following relative imports the same way
 * Node's ESM resolver does) and asserts paper-run.ts never appears in it.
 * If someone later adds `import ... from "./paper-run.js"` to run-agent.ts
 * or anything it pulls in, this test fails the build, not just a runtime
 * isLive() branch that only helps if that code path actually executes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const IMPORT_RE = /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

async function resolveModuleFile(fromFile: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) return null; // external package — not part of this project's graph
  const asTs = resolve(dirname(fromFile), specifier.replace(/\.js$/, ".ts"));
  return asTs;
}

async function collectImportGraph(entryFile: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue = [resolve(ROOT, entryFile)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue; // unresolved path (e.g. a directory import) — not this test's concern
    }

    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1]!;
      const resolved = await resolveModuleFile(file, specifier);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }

  return visited;
}

test("run-agent.ts's import graph never reaches scripts/paper-run.ts", async () => {
  const graph = await collectImportGraph("scripts/run-agent.ts");
  const paperRunPath = join(ROOT, "scripts", "paper-run.ts");
  assert.ok(!graph.has(paperRunPath), `scripts/paper-run.ts must never be reachable from the production entrypoint — found in import graph: ${[...graph].join(", ")}`);
});

test("run-agent.ts's import graph never reaches scripts/demo-persistence-restart.ts (also a diagnostic-only script)", async () => {
  const graph = await collectImportGraph("scripts/run-agent.ts");
  const demoPath = join(ROOT, "scripts", "demo-persistence-restart.ts");
  assert.ok(!graph.has(demoPath));
});

test("sanity check: the import-graph walker actually resolves real files (not silently empty)", async () => {
  const graph = await collectImportGraph("scripts/run-agent.ts");
  assert.ok(graph.size > 5, `expected a real import graph, got ${graph.size} file(s)`);
});
