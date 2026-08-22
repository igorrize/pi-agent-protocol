// contracts.ts
//
// Discover and load `<agent>.contract.json` sidecars (DESIGN.md, "Contract
// format") into a ContractRegistry. Pure-ish: only node:fs/node:path reads,
// no pi API, no validation (that's validator.ts) and no dispatch logic.
//
// Loading is fail-open: a missing/unreadable directory, or a file that
// can't be read or doesn't parse to a JSON object, is silently skipped so
// one bad sidecar never breaks the rest of the load.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Contract, ContractRegistry } from "./types.js";

const CONTRACT_SUFFIX = ".contract.json";

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read every `*.contract.json` file in each of `dirs` and map it by
 * `agent_name`. Directories that don't exist (or can't be listed), and
 * files that fail to read/parse or don't parse to a JSON object, are
 * skipped (caught, never thrown).
 *
 * If a contract's `agent_name` is missing or not a string, the filename
 * (minus the `.contract.json` suffix) is used instead. All other top-level
 * keys (e.g. `policy`) are preserved as-is.
 *
 * Assumption: first-wins. If the same agent_name is produced twice (same
 * dir or across dirs), the first one encountered is kept; later
 * duplicates are ignored (dirs are scanned in the order given, entries
 * within a dir are sorted for deterministic behavior).
 */
export function loadContracts(dirs: string[]): ContractRegistry {
  const registry: ContractRegistry = new Map();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue; // dir missing / unreadable -> skip
    }

    for (const entry of entries) {
      if (!entry.endsWith(CONTRACT_SUFFIX)) continue;

      let parsed: unknown;
      try {
        const text = readFileSync(join(dir, entry), "utf8");
        parsed = JSON.parse(text);
      } catch {
        continue; // unreadable or malformed JSON -> skip
      }
      if (!isPlainObject(parsed)) continue; // not a JSON object -> skip

      const fallbackName = entry.slice(0, -CONTRACT_SUFFIX.length);
      const rawName = parsed.agent_name;
      const agentName = typeof rawName === "string" ? rawName : fallbackName;

      if (registry.has(agentName)) continue; // first-wins

      const contract = { ...parsed, agent_name: agentName } as Contract;
      registry.set(agentName, contract);
    }
  }

  return registry;
}

/**
 * Candidate agent directories, in priority order:
 * 1. `${home}/.pi/agent/agents`
 * 2. `${home}/.agents`
 * 3. walking up from `cwd` towards the filesystem root (stopping right
 *    after the first directory that contains a `.git`), each ancestor's
 *    `<dir>/.pi/agents` then `<dir>/.agents`.
 *
 * Only dirs that actually exist are returned; duplicates are removed
 * while preserving first-seen order (home dirs first).
 */
export function discoverAgentDirs(cwd: string, home: string): string[] {
  const candidates: string[] = [join(home, ".pi", "agent", "agents"), join(home, ".agents")];

  let dir = resolve(cwd);
  for (;;) {
    candidates.push(join(dir, ".pi", "agents"), join(dir, ".agents"));

    if (existsSync(join(dir, ".git"))) break; // this dir is the git root, stop here

    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isDirectory(candidate)) result.push(candidate);
  }
  return result;
}

/** Convenience: `loadContracts(discoverAgentDirs(cwd, home))`. */
export function loadRegistry(cwd: string, home: string): ContractRegistry {
  return loadContracts(discoverAgentDirs(cwd, home));
}
