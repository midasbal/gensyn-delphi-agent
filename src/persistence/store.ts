/**
 * Atomic JSON file store. Write-to-temp-then-rename so a crash or kill mid-
 * write never leaves a corrupt/partial state file — `fs.rename` is atomic on
 * the same filesystem, and the state dir + its contents are same-filesystem
 * by construction here.
 *
 * Deliberately a plain JSON file, not SQLite — the state this project
 * persists (a handful of markets' worth of caches + one portfolio) is small
 * enough that a JSON file needs no query engine, and it keeps this project
 * dependency-free. Revisit if/when this grows past hundreds of markets.
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await rename(tmpPath, path);
}
