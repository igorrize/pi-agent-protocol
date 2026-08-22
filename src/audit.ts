// In-memory ring-buffer audit log with optional JSONL file append.
//
// Fail-open by design: file append failures (bad path, no permissions, ...)
// are swallowed so audit logging never breaks the caller's control flow.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditEvent } from "./types.js";

const DEFAULT_CAPACITY = 500;

export class AuditLog {
  private readonly capacity: number;
  private readonly file?: string;
  private buffer: AuditEvent[] = [];

  constructor(opts?: { capacity?: number; file?: string }) {
    this.capacity = opts?.capacity ?? DEFAULT_CAPACITY;
    this.file = opts?.file;
  }

  record(event: Omit<AuditEvent, "ts"> & { ts?: number }): void {
    const fullEvent: AuditEvent = { ...event, ts: event.ts ?? Date.now() };

    this.buffer.push(fullEvent);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }

    const file = this.file;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(fullEvent) + "\n");
      } catch {
        // fail-open: audit logging must never throw for the caller
      }
    }
  }

  recent(n?: number): AuditEvent[] {
    if (n === undefined) return [...this.buffer];
    if (n <= 0) return [];
    return this.buffer.slice(Math.max(0, this.buffer.length - n));
  }

  all(): AuditEvent[] {
    return [...this.buffer];
  }
}
