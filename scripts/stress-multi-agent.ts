import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tempRoot = mkdtempSync(join(tmpdir(), "eval-agent-stress-multi-agent-"))
const workerPath = join(import.meta.dir, "stress-multi-agent-worker.ts")

try {
  const worker = Bun.spawn([process.execPath, workerPath], {
    env: {
      ...process.env,
      EVAL_DATA_DIR: join(tempRoot, "database"),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await worker.exited
  if (exitCode !== 0) process.exitCode = exitCode
} finally {
  await removeWithRetry(tempRoot)
}

async function removeWithRetry(path: string): Promise<void> {
  const maxAttempts = 40
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (!isRetryableRemovalError(error) || attempt === maxAttempts - 1) throw error
      const delayMs = Math.min(50 * (2 ** Math.floor(attempt / 5)), 500)
      await Bun.sleep(delayMs)
    }
  }
}

function isRetryableRemovalError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false
  const code = (error as { code?: unknown }).code
  return code === "EBUSY"
    || code === "EPERM"
    || code === "EACCES"
    || code === "ENOTEMPTY"
}
