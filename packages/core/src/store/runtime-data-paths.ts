import { existsSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export const EVAL_DATA_DIR = process.env.EVAL_DATA_DIR?.trim()
  || (process.env.NODE_ENV === "test"
    ? join(tmpdir(), `eval-agent-test-${process.pid}-${Date.now()}`)
    : join(homedir(), ".eval"))

export const EVAL_DATABASE_PATH = join(EVAL_DATA_DIR, "eval.db")
export const EVAL_DIAGNOSTIC_LOG_PATH = join(EVAL_DATA_DIR, "log.txt")
export const EVAL_DIAGNOSTIC_LOG_BACKUP_PATH = join(EVAL_DATA_DIR, "log.1.txt")

export function ensureEvalDataDir(): void {
  if (!existsSync(EVAL_DATA_DIR)) mkdirSync(EVAL_DATA_DIR, { recursive: true })
}
