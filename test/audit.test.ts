import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLog } from "../src/audit.js";
import type { AuditEvent } from "../src/types.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ap-audit-"));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("ring buffer evicts oldest entries beyond capacity", () => {
  const log = new AuditLog({ capacity: 2 });
  log.record({ kind: "dispatched", path: "subagent", mode: "warn", agent: "a" });
  log.record({ kind: "dispatched", path: "subagent", mode: "warn", agent: "b" });
  log.record({ kind: "dispatched", path: "subagent", mode: "warn", agent: "c" });

  const all = log.all();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((e) => e.agent),
    ["b", "c"],
  );
});

test("record fills ts when omitted and preserves an explicit ts", () => {
  const log = new AuditLog();
  const before = Date.now();
  log.record({ kind: "completed", path: "subagent", mode: "off" });
  const after = Date.now();

  const [autoTsEvent] = log.all();
  assert.ok(autoTsEvent.ts >= before && autoTsEvent.ts <= after);

  const explicitTs = 12345;
  log.record({ kind: "failed", path: "intercom", mode: "block", ts: explicitTs });
  const events = log.all();
  assert.equal(events[1].ts, explicitTs);
});

test("recent(n) returns the last n events, oldest-to-newest", () => {
  const log = new AuditLog({ capacity: 10 });
  for (const agent of ["a", "b", "c", "d"]) {
    log.record({ kind: "dispatched", path: "subagent", mode: "warn", agent });
  }

  const last2 = log.recent(2);
  assert.deepEqual(
    last2.map((e) => e.agent),
    ["c", "d"],
  );

  const viaDefault = log.recent();
  assert.deepEqual(
    viaDefault.map((e) => e.agent),
    ["a", "b", "c", "d"],
  );
});

test("file mode appends valid JSON lines that round-trip", () => {
  const dir = mkTmpDir();
  const file = path.join(dir, "audit.jsonl");
  try {
    const log = new AuditLog({ file });
    log.record({ kind: "dispatched", path: "subagent", mode: "warn", agent: "x" });
    log.record({ kind: "completed", path: "subagent", mode: "warn", agent: "y" });

    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);

    const parsed = lines.map((l) => JSON.parse(l) as AuditEvent);
    assert.equal(parsed[0].kind, "dispatched");
    assert.equal(parsed[0].agent, "x");
    assert.equal(parsed[1].kind, "completed");
    assert.equal(parsed[1].agent, "y");
  } finally {
    rmTmpDir(dir);
  }
});

test("file mode creates missing parent directories", () => {
  const dir = mkTmpDir();
  const file = path.join(dir, "nested", "deeper", "audit.jsonl");
  try {
    const log = new AuditLog({ file });
    log.record({ kind: "bypass", path: "subagent", mode: "warn" });

    assert.ok(fs.existsSync(file));
    const line = fs.readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(line) as AuditEvent;
    assert.equal(parsed.kind, "bypass");
  } finally {
    rmTmpDir(dir);
  }
});

test("an invalid/non-writable file path does not throw", () => {
  const dir = mkTmpDir();
  try {
    // A regular file used as a directory path component makes the
    // configured audit file path impossible to create (ENOTDIR).
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const badFile = path.join(blocker, "nested", "audit.jsonl");

    const log = new AuditLog({ file: badFile });
    assert.doesNotThrow(() => {
      log.record({ kind: "bypass", path: "subagent", mode: "warn" });
    });

    // in-memory recording still succeeds even though the file append failed
    assert.equal(log.all().length, 1);
  } finally {
    rmTmpDir(dir);
  }
});
