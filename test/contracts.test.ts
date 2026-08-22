import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAgentDirs, loadContracts, loadRegistry } from "../src/contracts.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "contracts");

test("loadContracts: valid sidecar loads with input_schema and output_schema", () => {
  const registry = loadContracts([fixturesDir]);
  const alpha = registry.get("alpha");

  assert.ok(alpha, 'expected an "alpha" contract to be loaded');
  assert.equal(alpha?.agent_name, "alpha");
  assert.deepEqual(alpha?.input_schema?.required, ["files", "rubric"]);
  assert.equal(alpha?.input_schema?.properties?.files?.type, "array");
  assert.deepEqual(alpha?.output_schema?.required, ["findings"]);
  assert.equal(alpha?.output_schema?.properties?.summary?.type, "string");
});

test("loadContracts: malformed JSON is skipped, a sibling valid file still loads", () => {
  const registry = loadContracts([fixturesDir]);

  assert.equal(registry.has("broken"), false);
  const beta = registry.get("beta");
  assert.ok(beta, 'expected sibling "beta" contract to still load');
  assert.equal(beta?.agent_name, "beta");
});

test("loadContracts: missing agent_name falls back to the filename", () => {
  const registry = loadContracts([fixturesDir]);
  const gamma = registry.get("gamma");

  assert.ok(gamma, 'expected a contract derived from "gamma.contract.json"');
  assert.equal(gamma?.agent_name, "gamma");
});

test("loadContracts: unknown top-level keys such as policy are preserved", () => {
  const registry = loadContracts([fixturesDir]);
  const alpha = registry.get("alpha");

  assert.deepEqual(alpha?.policy, { max_test_attempts: 3, on_exhausted: "ask_user" });
});

test("loadContracts: a contract with neither schema still loads with both undefined", () => {
  const registry = loadContracts([fixturesDir]);
  const epsilon = registry.get("epsilon");

  assert.ok(epsilon, 'expected an "epsilon" contract to be loaded');
  assert.equal(epsilon?.input_schema, undefined);
  assert.equal(epsilon?.output_schema, undefined);
});

test("loadContracts: a non-existent directory is skipped without throwing", () => {
  const missingDir = join(fixturesDir, "does-not-exist");

  assert.doesNotThrow(() => loadContracts([missingDir]));
  assert.equal(loadContracts([missingDir]).size, 0);
});

test("loadContracts: first dir wins when the same agent_name appears twice", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ap-contracts-firstwins-"));
  try {
    const dirA = join(tmp, "a");
    const dirB = join(tmp, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(
      join(dirA, "shared.contract.json"),
      JSON.stringify({ agent_name: "shared", input_schema: { required: ["from_a"] } }),
    );
    writeFileSync(
      join(dirB, "shared.contract.json"),
      JSON.stringify({ agent_name: "shared", input_schema: { required: ["from_b"] } }),
    );

    const registry = loadContracts([dirA, dirB]);
    assert.deepEqual(registry.get("shared")?.input_schema?.required, ["from_a"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("discoverAgentDirs: existing dirs only, home first, stops walking up at the git root", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ap-contracts-dirs-"));
  try {
    const home = join(tmp, "home");
    const homeAgents = join(home, ".pi", "agent", "agents");
    mkdirSync(homeAgents, { recursive: true });
    // home/.agents intentionally left absent.

    const project = join(tmp, "project");
    const sub = join(project, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(project, ".git"), "gitdir: fake\n"); // marks the git root
    const projectPiAgents = join(project, ".pi", "agents");
    mkdirSync(projectPiAgents, { recursive: true });
    // project/.agents, sub/.pi/agents, sub/.agents intentionally left absent.

    // Above the git root: if the walk incorrectly continued past `project`,
    // this dir would (wrongly) show up in the result too.
    mkdirSync(join(tmp, ".pi", "agents"), { recursive: true });

    const dirs = discoverAgentDirs(sub, home);

    assert.deepEqual(dirs, [homeAgents, projectPiAgents]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadRegistry: composes discoverAgentDirs and loadContracts", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ap-contracts-registry-"));
  try {
    const home = join(tmp, "home");
    const homeAgentsDir = join(home, ".pi", "agent", "agents");
    mkdirSync(homeAgentsDir, { recursive: true });
    writeFileSync(
      join(homeAgentsDir, "home-agent.contract.json"),
      JSON.stringify({ agent_name: "home-agent" }),
    );

    const project = join(tmp, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".git"), "gitdir: fake\n");
    const projectAgentsDir = join(project, ".pi", "agents");
    mkdirSync(projectAgentsDir, { recursive: true });
    writeFileSync(
      join(projectAgentsDir, "project-agent.contract.json"),
      JSON.stringify({ agent_name: "project-agent" }),
    );

    const registry = loadRegistry(project, home);

    assert.ok(registry.get("home-agent"), "expected the home-dir contract to be loaded");
    assert.ok(registry.get("project-agent"), "expected the project-dir contract to be loaded");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
