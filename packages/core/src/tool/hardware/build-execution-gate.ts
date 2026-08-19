interface Waiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
}

/** Host-wide build process limiter. Agent concurrency does not imply unbounded toolchain concurrency. */
export class BuildExecutionGate {
  private active = 0
  private readonly queue: Waiter[] = []

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("构建并发容量必须为正整数")
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.active < this.capacity) {
      this.active++
      return Promise.resolve(this.releaseHandle())
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      waiter.abort = () => {
        const index = this.queue.indexOf(waiter)
        if (index >= 0) this.queue.splice(index, 1)
        reject(abortError())
      }
      signal?.addEventListener("abort", waiter.abort, { once: true })
      this.queue.push(waiter)
    })
  }

  snapshot(): { active: number; queued: number; capacity: number } {
    return { active: this.active, queued: this.queue.length, capacity: this.capacity }
  }

  private releaseHandle(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.dispatch()
    }
  }

  private dispatch(): void {
    while (this.active < this.capacity && this.queue.length > 0) {
      const waiter = this.queue.shift()!
      waiter.signal?.removeEventListener("abort", waiter.abort!)
      if (waiter.signal?.aborted) {
        waiter.reject(abortError())
        continue
      }
      this.active++
      waiter.resolve(this.releaseHandle())
    }
  }
}

// Windows toolchain shims and vendor compilers frequently share temporary
// files or global state. Parallelism remains inside each build via `jobs`;
// separate build graphs are serialized on Windows and bounded elsewhere.
export const buildExecutionGate = new BuildExecutionGate(process.platform === "win32" ? 1 : 2)

function abortError(): Error {
  const error = new Error("构建在等待执行槽位时已取消")
  error.name = "AbortError"
  return error
}
