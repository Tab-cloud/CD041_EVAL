import { resourcesConflict, type ResourceClaims } from "./run-contract.ts"

export interface DelegationDagNode<TPayload = unknown> {
  id: string
  dependsOn: string[]
  resources: ResourceClaims
  payload: TPayload
}

export interface DelegationDagNodeResult<T = unknown> {
  nodeId: string
  success: boolean
  skipped?: boolean
  value?: T
  error?: string
}

export interface DelegationDagResult<T = unknown> {
  success: boolean
  results: DelegationDagNodeResult<T>[]
  failedNodeId?: string
  waitingWorkerExitNodeIds: string[]
}

export interface DelegationDagHooks<TPayload, TResult> {
  suspendParent: () => boolean
  resumeParent: () => Promise<void>
  runNode: (
    node: DelegationDagNode<TPayload>,
    signal: AbortSignal,
    dependencyResults: ReadonlyMap<string, DelegationDagNodeResult<TResult>>,
  ) => Promise<DelegationDagNodeResult<TResult>>
  cancelNode: (nodeId: string) => "exited" | "pending" | Promise<"exited" | "pending">
}

export interface DelegationDagOptions {
  /** Bounded parent wait; resource leases remain owned by unfinished workers. */
  cancellationJoinMs?: number
}

/**
 * Executes one typed atomic delegation graph.
 *
 * The graph owns the complete parent/child handoff:
 * - validation occurs before the parent is suspended;
 * - the parent is suspended and resumed at most once;
 * - dependencies and resource conflicts are enforced independently of model
 *   call ordering;
 * - one failed branch never cancels independent work; only dependent nodes
 *   are skipped, while parent cancellation still joins active workers.
 */
export async function executeDelegationDag<TPayload, TResult>(
  nodes: DelegationDagNode<TPayload>[],
  hooks: DelegationDagHooks<TPayload, TResult>,
  parentSignal?: AbortSignal,
  options: DelegationDagOptions = {},
): Promise<DelegationDagResult<TResult>> {
  validateDelegationDag(nodes)
  const parentSuspended = hooks.suspendParent()
  if (!parentSuspended) {
    throw new Error("主 Agent 未进入 waiting-delegation，拒绝启动无 owner 的委派 DAG")
  }
  const groupAbort = new AbortController()
  const unlinkParent = forwardAbort(parentSignal, groupAbort)
  const pending = new Map(nodes.map((node) => [node.id, node]))
  const running = new Map<string, {
    node: DelegationDagNode<TPayload>
    promise: Promise<DelegationDagNodeResult<TResult>>
  }>()
  const results = new Map<string, DelegationDagNodeResult<TResult>>()
  const cancellationRequested = new Set<string>()
  const cancellationJoins = new Map<string, Promise<"exited" | "pending">>()
  let failedNodeId: string | undefined
  const cancelStarted = () => {
    for (const id of running.keys()) {
      if (cancellationRequested.has(id)) continue
      cancellationRequested.add(id)
      cancellationJoins.set(id, Promise.resolve(hooks.cancelNode(id)))
    }
  }
  groupAbort.signal.addEventListener("abort", cancelStarted)
  if (groupAbort.signal.aborted) cancelStarted()

  try {
    while (pending.size > 0 || running.size > 0) {
      if (groupAbort.signal.aborted && !failedNodeId) failedNodeId = "cancelled"
      if (groupAbort.signal.aborted) break
      skipFailedDependents(pending, results)
      for (const node of readyNodes(pending, results)) {
        if ([...running.values()].some((active) =>
          resourcesConflict(active.node.resources, node.resources))) continue
        pending.delete(node.id)
        const dependencyResults = new Map(
          node.dependsOn.flatMap((dependency) => {
            const result = results.get(dependency)
            return result ? [[dependency, result] as const] : []
          }),
        )
        const promise = Promise.resolve()
          .then(() => hooks.runNode(node, groupAbort.signal, dependencyResults))
          .then((result) => normalizeNodeResult(node.id, result))
          .catch((error) => ({
            nodeId: node.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        running.set(node.id, { node, promise })
      }

      if (running.size === 0) {
        if (pending.size > 0) {
          throw new Error("委派 DAG 无法取得可运行节点")
        }
        break
      }

      const settled = await raceNodeSettlement(running, groupAbort.signal)
      if (!settled) continue
      running.delete(settled.nodeId)
      results.set(settled.nodeId, settled)
      if (!settled.success && !failedNodeId) failedNodeId = settled.nodeId
    }

    if (groupAbort.signal.aborted) {
      cancelStarted()
      const joinMs = Math.max(0, options.cancellationJoinMs ?? 5_000)
      const workerJoin = Promise.allSettled([...running.values()].map(({ promise }) => promise))
      const cancellationJoin = Promise.all([...cancellationJoins].map(async ([nodeId, promise]) => {
        try {
          return { nodeId, status: await promise }
        } catch {
          return { nodeId, status: "pending" as const }
        }
      }))
      const joined = await settleWithin(
        Promise.all([workerJoin, cancellationJoin]),
        joinMs,
      )
      const waitingWorkerExitNodeIds = new Set<string>()
      if (joined) {
        for (const item of joined[0]) {
          if (item.status === "fulfilled") results.set(item.value.nodeId, item.value)
        }
        for (const item of joined[1]) {
          if (item.status === "pending") waitingWorkerExitNodeIds.add(item.nodeId)
        }
      } else {
        for (const id of running.keys()) waitingWorkerExitNodeIds.add(id)
        for (const id of cancellationJoins.keys()) waitingWorkerExitNodeIds.add(id)
      }
      for (const node of pending.values()) {
        results.set(node.id, {
          nodeId: node.id,
          success: false,
          skipped: true,
          error: "父任务已取消，节点未启动",
        })
      }
      for (const nodeId of cancellationRequested) {
        results.set(nodeId, {
          nodeId,
          success: false,
          error: waitingWorkerExitNodeIds.has(nodeId)
            ? "事务已取消，Worker 尚未真实退出，资源租约继续保留"
            : "父任务已取消，当前节点已退出",
        })
      }
      return {
        success: false,
        results: nodes.map((node) => results.get(node.id) ?? ({
          nodeId: node.id,
          success: false,
          error: waitingWorkerExitNodeIds.has(node.id)
            ? "取消已请求，Worker 尚未真实退出，资源租约继续保留"
            : "节点未产生终态结果",
        })),
        failedNodeId,
        waitingWorkerExitNodeIds: [...waitingWorkerExitNodeIds],
      }
    }

    return {
      success: !groupAbort.signal.aborted && results.size === nodes.length
        && [...results.values()].every((result) => result.success),
      results: nodes.map((node) => results.get(node.id) ?? ({
        nodeId: node.id,
        success: false,
        error: "节点未产生终态结果",
      })),
      failedNodeId,
      waitingWorkerExitNodeIds: [],
    }
  } finally {
    unlinkParent()
    if (parentSuspended) await hooks.resumeParent()
  }
}

export function validateDelegationDag(nodes: DelegationDagNode[]): void {
  if (nodes.length === 0) throw new Error("委派 DAG 至少需要一个节点")
  const ids = new Set<string>()
  for (const node of nodes) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(node.id)) {
      throw new Error(`无效的委派节点 id: ${node.id}`)
    }
    if (ids.has(node.id)) throw new Error(`委派节点 id 重复: ${node.id}`)
    ids.add(node.id)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`节点 ${node.id} 依赖不存在的节点 ${dependency}`)
      if (dependency === node.id) throw new Error(`节点 ${node.id} 不能依赖自身`)
    }
  }

  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)]))
  const resolved = new Set<string>()
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) =>
      [...dependencies].every((dependency) => resolved.has(dependency)))
    if (ready.length === 0) throw new Error("委派 DAG 存在循环依赖")
    for (const [id] of ready) {
      remaining.delete(id)
      resolved.add(id)
    }
  }
}

function readyNodes<TPayload, TResult>(
  pending: Map<string, DelegationDagNode<TPayload>>,
  results: Map<string, DelegationDagNodeResult<TResult>>,
): DelegationDagNode<TPayload>[] {
  return [...pending.values()].filter((node) =>
    node.dependsOn.every((dependency) => results.get(dependency)?.success === true))
}

function skipFailedDependents<TPayload, TResult>(
  pending: Map<string, DelegationDagNode<TPayload>>,
  results: Map<string, DelegationDagNodeResult<TResult>>,
): void {
  let changed = true
  while (changed) {
    changed = false
    for (const node of pending.values()) {
      const failedDependencies = node.dependsOn.filter((dependency) => {
        const result = results.get(dependency)
        return result && !result.success
      })
      if (failedDependencies.length === 0) continue
      pending.delete(node.id)
      results.set(node.id, {
        nodeId: node.id,
        success: false,
        skipped: true,
        error: `依赖节点未完成，已跳过：${failedDependencies.join(", ")}`,
      })
      changed = true
    }
  }
}

function normalizeNodeResult<T>(
  nodeId: string,
  result: DelegationDagNodeResult<T>,
): DelegationDagNodeResult<T> {
  return {
    ...result,
    nodeId,
    success: result.success === true,
    skipped: result.skipped === true,
    error: result.success ? undefined : result.error || `节点 ${nodeId} 执行失败`,
  }
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  const abort = () => {
    if (!target.signal.aborted) target.abort(source.reason)
  }
  if (source.aborted) abort()
  else source.addEventListener("abort", abort, { once: true })
  return () => source.removeEventListener("abort", abort)
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function raceNodeSettlement<TResult>(
  running: Map<string, { promise: Promise<DelegationDagNodeResult<TResult>> }>,
  signal: AbortSignal,
): Promise<DelegationDagNodeResult<TResult> | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: DelegationDagNodeResult<TResult> | undefined) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const onAbort = () => finish(undefined)
    signal.addEventListener("abort", onAbort, { once: true })
    Promise.race([...running.values()].map(({ promise }) => promise))
      .then((value) => finish(value), () => finish(undefined))
  })
}
