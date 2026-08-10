import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
  datasets: string[];
  benchmarkInstanceType: string;
  benchmarkNodeCount: number;
  baseSha: string;
  headSha: string;
}

export interface Job extends NewJob {
  id: number;
  statusCommentId: number | null;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
}

export interface RecoveryResult {
  retried: number;
  failed: Job[];
}

export class QueueLimitError extends Error {}

const MAX_QUEUE_DEPTH = 20;
const MAX_QUEUED_PER_USER = 3;

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS = loadMigrations();

export class JobDatabase {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.applyMigrations();
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
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
    this.clearCommentFailure(commentId);
  }

  canAttemptComment(commentId: number, now = new Date()): boolean {
    const row = this.#database
      .prepare(
        "SELECT next_attempt_at FROM comment_failures WHERE comment_id = ?",
      )
      .get(commentId) as { next_attempt_at: string } | undefined;
    return !row || row.next_attempt_at <= now.toISOString();
  }

  recordCommentFailure(
    commentId: number,
    error: string,
    now = new Date(),
  ): number {
    const current = this.#database
      .prepare("SELECT attempts FROM comment_failures WHERE comment_id = ?")
      .get(commentId) as { attempts: number } | undefined;
    const attempts = (current?.attempts ?? 0) + 1;
    const delayMs = Math.min(5 * 60_000, 30_000 * 2 ** (attempts - 1));
    this.#database
      .prepare(
        `INSERT INTO comment_failures(comment_id, attempts, next_attempt_at, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(comment_id) DO UPDATE SET
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at,
           last_error = excluded.last_error`,
      )
      .run(
        commentId,
        attempts,
        new Date(now.getTime() + delayMs).toISOString(),
        error.slice(0, 4_000),
      );
    return attempts;
  }

  clearCommentFailure(commentId: number): void {
    this.#database
      .prepare("DELETE FROM comment_failures WHERE comment_id = ?")
      .run(commentId);
  }

  enqueue(job: NewJob, now = new Date()): number | null {
    if (
      job.datasets.length === 0 ||
      job.datasets.some(
        (dataset) => typeof dataset !== "string" || dataset.length === 0,
      )
    ) {
      throw new Error("A benchmark job must contain at least one dataset");
    }
    const timestamp = now.toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const active = this.#database
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN requested_by = ? THEN 1 ELSE 0 END) AS requester
           FROM jobs WHERE status IN ('pending', 'running')`,
        )
        .get(job.requestedBy) as { total: number; requester: number | null };
      if (active.total >= MAX_QUEUE_DEPTH) {
        throw new QueueLimitError("The benchmark queue is full");
      }
      if ((active.requester ?? 0) >= MAX_QUEUED_PER_USER) {
        throw new QueueLimitError(
          "The requester already has three active jobs",
        );
      }
      this.markCommentSeen(job.commentId, now);
      const result = this.#database
        .prepare(
          `INSERT OR IGNORE INTO jobs(
             comment_id, repository, pull_request_number, pull_request_url,
             requested_by, datasets_json,
             benchmark_instance_type, benchmark_node_count,
             base_sha, head_sha, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          job.commentId,
          job.repository,
          job.pullRequestNumber,
          job.pullRequestUrl,
          job.requestedBy,
          JSON.stringify(job.datasets),
          job.benchmarkInstanceType,
          job.benchmarkNodeCount,
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
        `SELECT * FROM jobs
         WHERE status = 'pending' AND status_comment_id IS NOT NULL
         ORDER BY id LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? jobFromRow(row) : null;
  }

  getJobForComment(commentId: number): Job | null {
    const row = this.#database
      .prepare("SELECT * FROM jobs WHERE comment_id = ?")
      .get(commentId) as Record<string, unknown> | undefined;
    return row ? jobFromRow(row) : null;
  }

  claimNextPending(now = new Date()): Job | null {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.nextPending();
      if (!pending) {
        this.#database.exec("COMMIT");
        return null;
      }
      const result = this.#database
        .prepare(
          `UPDATE jobs SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now.toISOString(), pending.id);
      this.#database.exec("COMMIT");
      return result.changes === 1
        ? {
            ...pending,
            status: "running",
            attemptCount: pending.attemptCount + 1,
            updatedAt: now.toISOString(),
          }
        : null;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  setStatusCommentId(id: number, commentId: number): void {
    this.#database
      .prepare(
        "UPDATE jobs SET status_comment_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(commentId, new Date().toISOString(), id);
  }

  recoverRunningJobs(maxAttempts = 3, now = new Date()): RecoveryResult {
    const running = this.#database
      .prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY id")
      .all() as Record<string, unknown>[];
    const failed = running
      .map(jobFromRow)
      .filter((job) => job.attemptCount >= maxAttempts);
    this.#database
      .prepare(
        `UPDATE jobs SET status = 'pending', error = NULL, updated_at = ?
         WHERE status = 'running' AND attempt_count < ?`,
      )
      .run(now.toISOString(), maxAttempts);
    this.#database
      .prepare(
        `UPDATE jobs SET status = 'failed', error = ?, updated_at = ?
         WHERE status = 'running' AND attempt_count >= ?`,
      )
      .run(
        `Controller restarted during this job ${maxAttempts} times`,
        now.toISOString(),
        maxAttempts,
      );
    return { retried: running.length - failed.length, failed };
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
         ON CONFLICT(repository) DO UPDATE SET scanned_through =
           MAX(scan_state.scanned_through, excluded.scanned_through)`,
      )
      .run(repository, scannedThrough);
  }

  private applyMigrations(): void {
    this.#database.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT`);

    const applied = this.#database
      .prepare("SELECT version, name FROM schema_version ORDER BY version")
      .all() as { version: number; name: string }[];
    if (applied.length === 0 && this.tableExists("jobs")) {
      this.baselineUnversionedDatabase();
      applied.push({
        version: MIGRATIONS[0]!.version,
        name: MIGRATIONS[0]!.name,
      });
    }
    validateMigrationHistory(applied);

    const appliedVersions = new Set(applied.map(({ version }) => version));
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            "INSERT INTO schema_version(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, new Date().toISOString());
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private baselineUnversionedDatabase(): void {
    const initialMigration = MIGRATIONS[0]!;
    const requiredLegacyColumns = [
      "id",
      "comment_id",
      "repository",
      "pull_request_number",
      "pull_request_url",
      "requested_by",
      "dataset",
      "base_sha",
      "head_sha",
      "status",
      "error",
      "created_at",
      "updated_at",
    ];
    const columns = new Set(
      (
        this.#database.prepare("PRAGMA table_info(jobs)").all() as {
          name: string;
        }[]
      ).map(({ name }) => name),
    );
    const missing = requiredLegacyColumns.filter(
      (column) => !columns.has(column),
    );
    if (missing.length > 0) {
      throw new Error(
        `Cannot migrate unversioned jobs table; missing columns: ${missing.join(", ")}`,
      );
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(initialMigration.sql);
      const compatibilityColumns = [
        {
          name: "attempt_count",
          definition: "INTEGER NOT NULL DEFAULT 0",
        },
        {
          name: "benchmark_instance_type",
          definition: "TEXT NOT NULL DEFAULT 'c5n.2xlarge'",
        },
        {
          name: "benchmark_node_count",
          definition: "INTEGER NOT NULL DEFAULT 12",
        },
        { name: "status_comment_id", definition: "INTEGER" },
        { name: "datasets_json", definition: "TEXT" },
      ] as const;
      for (const column of compatibilityColumns) {
        if (!columns.has(column.name)) {
          this.#database.exec(
            `ALTER TABLE jobs ADD COLUMN ${column.name} ${column.definition}`,
          );
        }
      }
      this.#database.exec(
        "UPDATE jobs SET datasets_json = json_array(dataset) WHERE datasets_json IS NULL",
      );
      this.#database.exec(
        "UPDATE jobs SET datasets_json = json_array(dataset) WHERE NOT json_valid(datasets_json)",
      );
      this.#database
        .prepare(
          "INSERT INTO schema_version(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(
          initialMigration.version,
          initialMigration.name,
          new Date().toISOString(),
        );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  private tableExists(table: string): boolean {
    return Boolean(
      this.#database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table),
    );
  }
}

function jobFromRow(row: Record<string, unknown>): Job {
  return {
    id: Number(row.id),
    statusCommentId:
      row.status_comment_id === null ? null : Number(row.status_comment_id),
    commentId: Number(row.comment_id),
    repository: String(row.repository),
    pullRequestNumber: Number(row.pull_request_number),
    pullRequestUrl: String(row.pull_request_url),
    requestedBy: String(row.requested_by),
    datasets: parseDatasets(row.datasets_json),
    benchmarkInstanceType: String(row.benchmark_instance_type),
    benchmarkNodeCount: Number(row.benchmark_node_count),
    baseSha: String(row.base_sha),
    headSha: String(row.head_sha),
    status: String(row.status) as JobStatus,
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    attemptCount: Number(row.attempt_count),
  };
}

function parseDatasets(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((dataset) => typeof dataset === "string")
      ) {
        return parsed;
      }
    } catch {
      // Report the same invariant violation for malformed JSON and shape errors.
    }
  }
  throw new Error("Job row contains invalid datasets_json");
}

function loadMigrations(): Migration[] {
  const migrations = readdirSync(MIGRATIONS_DIRECTORY)
    .map((name): Migration | null => {
      const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name);
      if (!match) return null;
      return {
        version: Number(match[1]),
        name,
        sql: readFileSync(path.join(MIGRATIONS_DIRECTORY, name), "utf8"),
      };
    })
    .filter((migration): migration is Migration => migration !== null)
    .sort((left, right) => left.version - right.version);
  if (
    migrations.length === 0 ||
    migrations.some((migration, index) => migration.version !== index + 1)
  ) {
    throw new Error(
      "Database migrations must use consecutive versions from 001",
    );
  }
  return migrations;
}

function validateMigrationHistory(
  applied: readonly { version: number; name: string }[],
): void {
  for (const [index, migration] of applied.entries()) {
    const expected = MIGRATIONS[index];
    if (
      !expected ||
      migration.version !== expected.version ||
      migration.name !== expected.name
    ) {
      throw new Error(
        `Database has unknown migration ${migration.version} (${migration.name})`,
      );
    }
  }
}
