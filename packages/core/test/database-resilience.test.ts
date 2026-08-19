import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  DatabaseMigrationHistoryError,
  DatabaseSchemaIntegrityError,
  DatabaseSchemaVersionError,
} from "../src/store/database-schema.ts"
import { migrateDatabase } from "../src/store/database.ts"

const tempDirs = new Set<string>()
const workerPath = resolve(import.meta.dir, "fixtures", "durable-store-worker.ts")

afterEach(() => {
  for (const path of tempDirs) rmSync(path, { recursive: true, force: true })
  tempDirs.clear()
})

describe("database migration and restart resilience", () => {
  test("fresh migration is contiguous and publishes every durable control-plane table", () => {
    const db = new Database(":memory:")
    migrateDatabase(db)
    const versions = db.query(
      "SELECT version FROM _migrations ORDER BY version",
    ).all() as Array<{ version: number }>
    const tables = db.query(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'task_runs', 'run_events', 'session_commands',
           'main_agent_interactions', 'run_guidance', 'runtime_owner_leases',
           'runtime_leader_lease', 'model_protocol_capabilities',
           'model_protocol_observations', 'token_usage_events',
           'token_usage_daily'
         )
       ORDER BY name`,
    ).all() as Array<{ name: string }>

    expect(versions.map((row) => row.version)).toEqual(
      Array.from({ length: 55 }, (_, index) => index + 1),
    )
    expect(tables.map((row) => row.name)).toEqual([
      "main_agent_interactions",
      "model_protocol_capabilities",
      "model_protocol_observations",
      "run_events",
      "run_guidance",
      "runtime_leader_lease",
      "runtime_owner_leases",
      "session_commands",
      "task_runs",
      "token_usage_daily",
      "token_usage_events",
    ])
    db.close()
  })

  test("a database stamped at retired version 50 upgrades without data deletion", () => {
    const db = new Database(":memory:")
    migrateDatabase(db)
    db.run("DELETE FROM _migrations WHERE version >= 51")
    db.run(
      "INSERT INTO sessions (id, title, agent_id, created_at, updated_at) "
      + "VALUES ('upgrade-session', 'Upgrade', 'main-agent', 1, 1)",
    )

    migrateDatabase(db)

    const versions = db.query(
      "SELECT version FROM _migrations ORDER BY version",
    ).all() as Array<{ version: number }>
    expect(versions.map((row) => row.version)).toEqual(
      Array.from({ length: 55 }, (_, index) => index + 1),
    )
    expect(db.query(
      "SELECT title FROM sessions WHERE id = 'upgrade-session'",
    ).get()).toEqual({ title: "Upgrade" })
    db.close()
  })

  test("safe control-plane history holes are replayed instead of skipped by MAX(version)", () => {
    const db = new Database(":memory:")
    migrateDatabase(db)
    db.run("DROP TABLE session_commands")
    db.run("DELETE FROM _migrations WHERE version = 34")

    migrateDatabase(db)

    expect(db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_commands'",
    ).get()).toBeTruthy()
    expect(db.query(
      "SELECT 1 FROM _migrations WHERE version = 34",
    ).get()).toBeTruthy()
    db.close()
  })

  test("unsafe migration holes and schema drift fail at startup with typed diagnostics", () => {
    const history = new Database(":memory:")
    history.run(
      "CREATE TABLE _migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )
    history.run("INSERT INTO _migrations VALUES(36, 0)")
    expect(() => migrateDatabase(history)).toThrow(DatabaseMigrationHistoryError)
    history.close()

    const future = new Database(":memory:")
    migrateDatabase(future)
    future.run("INSERT INTO _migrations VALUES(99, 0)")
    expect(() => migrateDatabase(future)).toThrow(DatabaseSchemaVersionError)
    future.close()

    const drift = new Database(":memory:")
    migrateDatabase(drift)
    drift.run("DROP TABLE session_commands")
    expect(() => migrateDatabase(drift)).toThrow(DatabaseSchemaIntegrityError)
    try {
      migrateDatabase(drift)
    } catch (error) {
      expect(String(error)).toContain("缺少表 session_commands")
      expect(String(error)).not.toContain("no such table")
    }
    drift.close()
  })

  test("a failed migration never publishes a poisoned database singleton", async () => {
    const dataDir = tempDataDir("eval-store-poison-")
    const result = await runWorker(dataDir, "singleton-poison", "unused", 1)

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      failures: [
        "DatabaseMigrationHistoryError",
        "DatabaseMigrationHistoryError",
      ],
    })
    expect(result.stderr).not.toContain("no such table")
  })

  test("concurrent processes migrate once and allocate command/event sequences without collision", async () => {
    const dataDir = tempDataDir("eval-store-concurrency-")
    const workers = 6
    const perWorker = 30
    const enqueueResults = await Promise.all(
      Array.from({ length: workers }, (_, index) =>
        runWorker(dataDir, "enqueue", `enqueue-${index}`, perWorker)),
    )
    expect(enqueueResults.every((result) => result.exitCode === 0)).toBe(true)

    const eventResults = await Promise.all(
      Array.from({ length: workers }, (_, index) =>
        runWorker(dataDir, "events", `events-${index}`, perWorker)),
    )
    expect(eventResults.every((result) => result.exitCode === 0)).toBe(true)

    const db = new Database(join(dataDir, "eval.db"), { readonly: true })
    const commands = db.query(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT session_seq) AS unique_count,
              MIN(session_seq) AS min_seq, MAX(session_seq) AS max_seq
       FROM session_commands WHERE session_id = 'shared-session'`,
    ).get() as {
      count: number
      unique_count: number
      min_seq: number
      max_seq: number
    }
    const events = db.query(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT seq) AS unique_count,
              MIN(seq) AS min_seq, MAX(seq) AS max_seq
       FROM run_events WHERE run_id = 'shared-run'`,
    ).get() as {
      count: number
      unique_count: number
      min_seq: number
      max_seq: number
    }
    const expected = workers * perWorker
    expect(commands).toEqual({
      count: expected,
      unique_count: expected,
      min_seq: 1,
      max_seq: expected,
    })
    expect(events).toEqual({
      count: expected,
      unique_count: expected,
      min_seq: 1,
      max_seq: expected,
    })
    db.close()
  }, 30_000)

  test("expired process recovery has one replacement owner and terminal task commit is atomic", async () => {
    const dataDir = tempDataDir("eval-store-restart-")
    const requestId = "restart-request"
    expect((await runWorker(dataDir, "seed-crashed-claim", requestId, 1)).exitCode).toBe(0)
    await Bun.sleep(150)

    const recoveries = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runWorker(dataDir, "recover-claim", requestId, index)),
    )
    expect(recoveries.every((result) => result.exitCode === 0)).toBe(true)
    const winners = recoveries
      .map((result) => JSON.parse(result.stdout) as { won: boolean })
      .filter((result) => result.won)
    expect(winners).toHaveLength(1)

    const terminal = await runWorker(dataDir, "terminal-atomic", "terminal-request", 1)
    expect(terminal.exitCode).toBe(0)
    expect(JSON.parse(terminal.stdout)).toMatchObject({
      taskState: "completed",
      commandState: "completed",
    })
  }, 30_000)

  test("only one backend process owns recovery leadership and an expired leader is replaceable", async () => {
    const dataDir = tempDataDir("eval-store-leader-")
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runWorker(dataDir, "leader-acquire", `candidate-${index}`, 10_000)),
    )
    expect(attempts
      .filter((result) => result.exitCode !== 0)
      .map((result) => result.stderr)).toEqual([])
    const acquired = attempts
      .map((result) => JSON.parse(result.stdout) as {
        acquired: boolean
        ownerEpoch: string
      })
      .filter((result) => result.acquired)
    expect(acquired).toHaveLength(1)

    const db = new Database(join(dataDir, "eval.db"))
    expect((db.query(
      "SELECT owner_epoch FROM runtime_leader_lease WHERE singleton = 1",
    ).get() as { owner_epoch: string }).owner_epoch).toBe(acquired[0]!.ownerEpoch)
    db.run("UPDATE runtime_leader_lease SET lease_expires_at = 0 WHERE singleton = 1")
    db.close()

    const replacement = await runWorker(dataDir, "leader-acquire", "replacement", 10_000)
    expect(replacement.exitCode).toBe(0)
    expect(JSON.parse(replacement.stdout)).toMatchObject({ acquired: true })
  }, 30_000)
})

function tempDataDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.add(path)
  return path
}

async function runWorker(
  dataDir: string,
  mode: string,
  id: string,
  count: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, workerPath, mode, id, String(count)],
    {
      cwd: resolve(import.meta.dir, "..", ".."),
      env: { ...Bun.env, EVAL_DATA_DIR: dataDir, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}
