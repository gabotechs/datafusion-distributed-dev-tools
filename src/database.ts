import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface NewJob {
  commentId: number;
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  requestedBy: string;
  dataset: string;
  baseSha: string;
  headSha: string;
}

export interface Job extends NewJob {
  id: number;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const MIGRATION = fileURLToPath(
  new URL("../migrations/001_initial.sql", import.meta.url),
);

export class JobDatabase {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#database.exec(readFileSync(MIGRATION, "utf8"));
  }

  close(): void {
    this.#database.close();
  }

  isCommentSeen(commentId: number): boolean {
    return Boolean(
      this.#database
        .prepare("SELECT 1 FROM seen_comments WHERE comment_id = ?")
        .get(commentId),
    );
  }

  markCommentSeen(commentId: number, now = new Date()): void {
    this.#database
      .prepare(
        "INSERT OR IGNORE INTO seen_comments(comment_id, seen_at) VALUES (?, ?)",
      )
      .run(commentId, now.toISOString());
  }

  enqueue(job: NewJob, now = new Date()): number | null {
    const timestamp = now.toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.markCommentSeen(job.commentId, now);
      const result = this.#database
        .prepare(
          `INSERT OR IGNORE INTO jobs(
             comment_id, repository, pull_request_number, pull_request_url,
             requested_by, dataset, base_sha, head_sha, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          job.commentId,
          job.repository,
          job.pullRequestNumber,
          job.pullRequestUrl,
          job.requestedBy,
          job.dataset,
          job.baseSha,
          job.headSha,
          timestamp,
          timestamp,
        );
      this.#database.exec("COMMIT");
      return result.changes === 0 ? null : Number(result.lastInsertRowid);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  nextPending(): Job | null {
    const row = this.#database
      .prepare(
        "SELECT * FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    return row ? jobFromRow(row) : null;
  }

  updateStatus(id: number, status: JobStatus, error?: string): void {
    this.#database
      .prepare(
        "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, error ?? null, new Date().toISOString(), id);
  }

  getScanTime(repository: string): string | null {
    const row = this.#database
      .prepare("SELECT scanned_through FROM scan_state WHERE repository = ?")
      .get(repository) as { scanned_through: string } | undefined;
    return row?.scanned_through ?? null;
  }

  setScanTime(repository: string, scannedThrough: string): void {
    this.#database
      .prepare(
        `INSERT INTO scan_state(repository, scanned_through) VALUES (?, ?)
         ON CONFLICT(repository) DO UPDATE SET scanned_through = excluded.scanned_through`,
      )
      .run(repository, scannedThrough);
  }
}

function jobFromRow(row: Record<string, unknown>): Job {
  return {
    id: Number(row.id),
    commentId: Number(row.comment_id),
    repository: String(row.repository),
    pullRequestNumber: Number(row.pull_request_number),
    pullRequestUrl: String(row.pull_request_url),
    requestedBy: String(row.requested_by),
    dataset: String(row.dataset),
    baseSha: String(row.base_sha),
    headSha: String(row.head_sha),
    status: String(row.status) as JobStatus,
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
