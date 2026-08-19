const STRESS_SEED = 0x5eed2026
const DAG_COUNT = 300
const DAG_NODES = 8
const STUBBORN_DAG_COUNT = 80
const SCHEDULER_TASK_COUNT = 2_000
const REVIEW_TREE_COUNT = 160
const FAILURE_TREE_COUNT = 80
const NON_COOPERATIVE_COUNT = 120
const [{ executeDelegationDag }, { TaskScheduler }, { resourcesConflict }, { closeDb }] =
  await Promise.all([
    import("../packages/core/src/runtime/delegation-dag.ts"),
    import("../packages/core/src/runtime/task-scheduler.ts"),
    import("../packages/core/src/runtime/run-contract.ts"),
    import("../packages/core/src/store/database.ts"),
  ])
const { flushDiagnosticFileLog } =
  await import("../packages/core/src/runtime/diagnostic-file-log.ts")

type ResourceClaims = {
  reads: string[]
  writes: string[]
}

type DagPayload = {
  delayMs: number
  fail: boolean
}

type DagNode = {
  id: string
  dependsOn: string[]
  resources: ResourceClaims
  payload: DagPayload
}

try {
  const dag = await stressDelegationDags()
  const stubbornWorkers = await stressStubbornDagWorkers()
  const scheduler = stressScheduler()
  const treeBarriers = stressTreeTerminalBarriers()
  const nonCooperativeWorkers = stressNonCooperativeSchedulerWorkers()

  const result = {
    status: "passed",
    seed: STRESS_SEED,
    totals: {
      dags: DAG_COUNT + STUBBORN_DAG_COUNT,
      dagNodes: DAG_COUNT * DAG_NODES + STUBBORN_DAG_COUNT * 2,
      schedulerTasks: SCHEDULER_TASK_COUNT,
      schedulerTreeTasks: REVIEW_TREE_COUNT * 4 + FAILURE_TREE_COUNT * 4
        + NON_COOPERATIVE_COUNT * 2,
    },
    dag,
    stubbornWorkers,
    scheduler,
    treeBarriers,
    nonCooperativeWorkers,
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  // Diagnostic logging is asynchronous during execution. Do not delete this
  // stress run's temporary data root until every queued record is durable.
  await flushDiagnosticFileLog()
  closeDb()
  // Closing the database can enqueue terminal diagnostics of its own.
  await flushDiagnosticFileLog()
}

async function stressDelegationDags() {
  const aggregate = {
    dags: DAG_COUNT,
    nodes: DAG_COUNT * DAG_NODES,
    successfulDags: 0,
    failedDags: 0,
    parallelDags: 0,
    dependencyViolations: 0,
    resourceConflictViolations: 0,
    parentSuspendCount: 0,
    parentResumeCount: 0,
    atomicRollbackViolations: 0,
  }

  for (let batchStart = 0; batchStart < DAG_COUNT; batchStart += 30) {
    const batch = Array.from(
      { length: Math.min(30, DAG_COUNT - batchStart) },
      (_, offset) => stressOneDag(batchStart + offset),
    )
    const reports = await Promise.all(batch)
    for (const report of reports) {
      aggregate.successfulDags += report.successfulDags
      aggregate.failedDags += report.failedDags
      aggregate.parallelDags += report.parallelDags
      aggregate.dependencyViolations += report.dependencyViolations
      aggregate.resourceConflictViolations += report.resourceConflictViolations
      aggregate.parentSuspendCount += report.parentSuspendCount
      aggregate.parentResumeCount += report.parentResumeCount
      aggregate.atomicRollbackViolations += report.atomicRollbackViolations
    }
  }

  assertEqual(aggregate.successfulDags, 240, "successful DAG count")
  assertEqual(aggregate.failedDags, 60, "failed DAG count")
  assertEqual(aggregate.parallelDags, DAG_COUNT, "DAGs that observed independent-node parallelism")
  assertEqual(aggregate.dependencyViolations, 0, "DAG dependency violations")
  assertEqual(aggregate.resourceConflictViolations, 0, "DAG resource conflict violations")
  assertEqual(aggregate.parentSuspendCount, DAG_COUNT, "DAG parent suspend count")
  assertEqual(aggregate.parentResumeCount, DAG_COUNT, "DAG parent resume count")
  assertEqual(aggregate.atomicRollbackViolations, 0, "failed DAG atomic rollback violations")
  return aggregate
}

async function stressOneDag(index: number) {
  const shouldFail = index % 5 === 0
  const nodes = dagFixture(index, shouldFail)
  const active = new Map<string, ResourceClaims>()
  let peak = 0
  let dependencyViolations = 0
  let resourceConflictViolations = 0
  let parentSuspendCount = 0
  let parentResumeCount = 0

  const result = await executeDelegationDag<DagPayload, string>(nodes, {
    suspendParent: () => {
      parentSuspendCount++
      return true
    },
    resumeParent: async () => {
      parentResumeCount++
    },
    runNode: async (node, signal, dependencyResults) => {
      if (node.dependsOn.some((dependency) => dependencyResults.get(dependency)?.success !== true)) {
        dependencyViolations++
      }
      for (const claims of active.values()) {
        if (resourcesConflict(claims, node.resources)) resourceConflictViolations++
      }
      active.set(node.id, node.resources)
      peak = Math.max(peak, active.size)
      try {
        await abortableDelay(node.payload.delayMs, signal)
        if (signal.aborted) {
          return { nodeId: node.id, success: false, error: "cancelled by stress DAG" }
        }
        if (node.payload.fail) {
          return { nodeId: node.id, success: false, error: "deterministic injected failure" }
        }
        return { nodeId: node.id, success: true, value: `${index}:${node.id}` }
      } finally {
        active.delete(node.id)
      }
    },
    cancelNode: () => "exited",
  }, undefined, { cancellationJoinMs: 100 })

  let atomicRollbackViolations = 0
  if (shouldFail) {
    if (result.success || result.results.some((item) => item.success)) atomicRollbackViolations++
    assertEqual(result.failedNodeId, "decision", `failed node for DAG ${index}`)
  } else {
    assert(result.success, `DAG ${index} unexpectedly failed`)
    assertEqual(result.results.filter((item) => item.success).length, DAG_NODES, `successful nodes for DAG ${index}`)
  }
  assert(peak >= 2, `DAG ${index} never ran independent nodes in parallel`)

  return {
    successfulDags: shouldFail ? 0 : 1,
    failedDags: shouldFail ? 1 : 0,
    parallelDags: peak >= 2 ? 1 : 0,
    dependencyViolations,
    resourceConflictViolations,
    parentSuspendCount,
    parentResumeCount,
    atomicRollbackViolations,
  }
}

function dagFixture(index: number, shouldFail: boolean): DagNode[] {
  const prefix = `dag-${index}`
  const claims = (reads: string[] = [], writes: string[] = []): ResourceClaims => ({ reads, writes })
  return [
    {
      id: "inspect",
      dependsOn: [],
      resources: claims([], [`${prefix}/shared`]),
      payload: { delayMs: 2, fail: false },
    },
    {
      id: "plan",
      dependsOn: [],
      resources: claims([], [`${prefix}/plan`]),
      payload: { delayMs: 3, fail: false },
    },
    {
      id: "conflicting-reader",
      dependsOn: [],
      resources: claims([`${prefix}/shared/file.c`]),
      payload: { delayMs: 1, fail: false },
    },
    {
      id: "implement",
      dependsOn: ["inspect"],
      resources: claims([], [`${prefix}/src`]),
      payload: { delayMs: 1, fail: false },
    },
    {
      id: "test",
      dependsOn: ["plan"],
      resources: claims([`${prefix}/plan`], [`${prefix}/test-output`]),
      payload: { delayMs: 1, fail: false },
    },
    {
      id: "decision",
      dependsOn: ["conflicting-reader", "implement", "test"],
      resources: claims([`${prefix}/src`, `${prefix}/test-output`]),
      payload: { delayMs: 1, fail: shouldFail },
    },
    {
      id: "publish",
      dependsOn: ["decision"],
      resources: claims([`${prefix}/src`], [`${prefix}/dist`]),
      payload: { delayMs: 1, fail: false },
    },
    {
      id: "independent-audit",
      dependsOn: [],
      resources: claims([`${prefix}/audit-input`]),
      payload: { delayMs: 15, fail: false },
    },
  ]
}

async function stressStubbornDagWorkers() {
  const reports = await Promise.all(Array.from({ length: STUBBORN_DAG_COUNT }, async (_, index) => {
    let suspendCount = 0
    let resumeCount = 0
    const never = new Promise<{ nodeId: string; success: boolean }>(() => {})
    const result = await executeDelegationDag([
      {
        id: "failure",
        dependsOn: [],
        resources: { reads: [], writes: [`stubborn-${index}/failure`] },
        payload: { kind: "failure" },
      },
      {
        id: "worker",
        dependsOn: [],
        resources: { reads: [], writes: [`stubborn-${index}/worker`] },
        payload: { kind: "worker" },
      },
    ], {
      suspendParent: () => {
        suspendCount++
        return true
      },
      resumeParent: async () => {
        resumeCount++
      },
      runNode: async (node) => node.id === "failure"
        ? { nodeId: node.id, success: false, error: "deterministic failure" }
        : never,
      cancelNode: (nodeId) => nodeId === "worker" ? "pending" : "exited",
    }, undefined, { cancellationJoinMs: 1 })

    assert(!result.success, `stubborn DAG ${index} unexpectedly succeeded`)
    assertEqual(result.failedNodeId, "failure", `stubborn DAG ${index} failed node`)
    assertEqual(result.waitingWorkerExitNodeIds.join(","), "worker", `stubborn DAG ${index} waiting worker`)
    assertEqual(suspendCount, 1, `stubborn DAG ${index} suspend count`)
    assertEqual(resumeCount, 1, `stubborn DAG ${index} resume count`)
    return result.waitingWorkerExitNodeIds.length
  }))

  const waitingWorkerExits = reports.reduce((sum, count) => sum + count, 0)
  assertEqual(waitingWorkerExits, STUBBORN_DAG_COUNT, "stubborn DAG waiting-worker-exit count")
  return {
    dags: STUBBORN_DAG_COUNT,
    nodes: STUBBORN_DAG_COUNT * 2,
    waitingWorkerExits,
    parentResumeCount: STUBBORN_DAG_COUNT,
  }
}

function stressScheduler() {
  const maxConcurrency = 12
  const scheduler = new TaskScheduler(maxConcurrency, SCHEDULER_TASK_COUNT + 10)
  const tasks = Array.from({ length: SCHEDULER_TASK_COUNT }, (_, index) => {
    const bucket = Math.floor(index / 3) % 32
    const resourceClaims: ResourceClaims = index % 3 === 0
      ? { reads: [], writes: [`workspace/bucket-${bucket}`] }
      : index % 3 === 1
        ? { reads: [`workspace/bucket-${bucket}/file.c`], writes: [] }
        : { reads: [], writes: [`docs/output-${index % 29}`] }
    return scheduler.enqueue({
      sessionId: `scheduler-session-${index}`,
      agentId: `worker-${index % 7}`,
      priority: 1 + (index % 10),
      type: "background",
      message: `scheduler stress ${index}`,
      workingDir: ".",
      laneKey: `stress-lane-${index % 41}`,
      laneOwner: `owner-${Math.floor(index / 41)}`,
      resourceClaims,
    })
  })

  const observedRunning = new Set<string>()
  let peakRunning = 0
  let activePairChecks = 0
  let resourceConflictViolations = 0
  let laneOwnershipViolations = 0
  let terminalTransitions = 0

  while (scheduler.getQueue().length > 0 || scheduler.getStats().running > 0) {
    const running = scheduler.getRunning().filter((task) => task.status === "running")
    assert(running.length > 0, "scheduler deadlocked with queued work")
    peakRunning = Math.max(peakRunning, running.length)
    for (const task of running) observedRunning.add(task.id)
    for (let left = 0; left < running.length; left++) {
      for (let right = left + 1; right < running.length; right++) {
        activePairChecks++
        if (resourcesConflict(running[left].resourceClaims, running[right].resourceClaims)) {
          resourceConflictViolations++
        }
        if (running[left].laneKey === running[right].laneKey
          && running[left].laneOwner !== running[right].laneOwner) {
          laneOwnershipViolations++
        }
      }
    }
    scheduler.completeTask(running[0].id, "stress complete")
    terminalTransitions++
  }

  assertEqual(peakRunning, maxConcurrency, "scheduler peak concurrency")
  assertEqual(observedRunning.size, SCHEDULER_TASK_COUNT, "scheduler tasks that acquired a slot")
  assertEqual(terminalTransitions, SCHEDULER_TASK_COUNT, "scheduler terminal transition count")
  assertEqual(resourceConflictViolations, 0, "scheduler resource conflict violations")
  assertEqual(laneOwnershipViolations, 0, "scheduler lane ownership violations")
  assertEqual(tasks.filter((task) => task.status === "completed").length, SCHEDULER_TASK_COUNT, "completed scheduler tasks")
  assertEqual(scheduler.getQueue().length, 0, "scheduler final queue length")
  assertEqual(scheduler.getRunning().length, 0, "scheduler final active length")

  return {
    tasks: SCHEDULER_TASK_COUNT,
    maxConcurrency,
    peakRunning,
    acquiredSlot: observedRunning.size,
    terminalTransitions,
    activePairChecks,
    resourceConflictViolations,
    laneOwnershipViolations,
    finalQueued: scheduler.getQueue().length,
    finalActive: scheduler.getRunning().length,
  }
}

function stressTreeTerminalBarriers() {
  const scheduler = new TaskScheduler(8, 2_000)
  let prematureRootTerminals = 0
  let reviewDecisions = 0
  let failureWorkerExits = 0

  for (let index = 0; index < REVIEW_TREE_COUNT; index++) {
    const owner = `review-tree-owner-${index}`
    const root = scheduler.enqueue({
      sessionId: `review-tree-${index}`,
      agentId: "main-agent",
      priority: 8,
      type: "chat",
      message: "root",
      workingDir: ".",
      laneOwner: owner,
    })
    const child = scheduler.enqueue({
      parentRunId: root.id,
      sessionId: root.sessionId,
      agentId: "implementation-worker",
      priority: 8,
      type: "background",
      message: "child",
      workingDir: ".",
      laneOwner: owner,
    })
    const grandchild = scheduler.enqueue({
      parentRunId: child.id,
      sessionId: root.sessionId,
      agentId: "test-worker",
      priority: 8,
      type: "background",
      message: "grandchild",
      workingDir: ".",
      laneOwner: owner,
    })
    const review = scheduler.enqueue({
      parentRunId: root.id,
      sessionId: root.sessionId,
      agentId: "review-worker",
      priority: 8,
      type: "background",
      message: "review",
      workingDir: ".",
      laneOwner: owner,
    })
    assertEqual(scheduler.quarantineForReview(review.id, "awaiting deterministic review"), true, "review quarantine")
    scheduler.completeTask(root.id, "root worker returned")
    scheduler.completeTask(child.id, "child worker returned")
    scheduler.completeTask(grandchild.id, "grandchild returned")
    if (root.status === "completed") prematureRootTerminals++
    assertEqual(root.status, "waiting-delegation", `root ${index} review barrier status`)
    assertEqual(scheduler.reviewTask(review.id, index % 2 === 0, "deterministic review"), true, "review decision")
    reviewDecisions++
    assertEqual(root.status, "completed", `root ${index} terminal status`)
  }

  for (let index = 0; index < FAILURE_TREE_COUNT; index++) {
    const owner = `failure-tree-owner-${index}`
    const cancelled: string[] = []
    const root = scheduler.enqueue({
      sessionId: `failure-tree-${index}`,
      agentId: "main-agent",
      priority: 8,
      type: "chat",
      message: "root",
      workingDir: ".",
      laneOwner: owner,
    })
    const child = scheduler.enqueue({
      parentRunId: root.id,
      sessionId: root.sessionId,
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "child",
      workingDir: ".",
      laneOwner: owner,
      onCancel: () => cancelled.push("child"),
    })
    const grandchild = scheduler.enqueue({
      parentRunId: child.id,
      sessionId: root.sessionId,
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "grandchild",
      workingDir: ".",
      laneOwner: owner,
      onCancel: () => cancelled.push("grandchild"),
    })
    const sibling = scheduler.enqueue({
      parentRunId: root.id,
      sessionId: root.sessionId,
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "sibling",
      workingDir: ".",
      laneOwner: owner,
      onCancel: () => cancelled.push("sibling"),
    })
    scheduler.failTask(root.id, "deterministic root failure")
    assertEqual(root.status, "cancelling", `failed root ${index} waits for descendants`)
    assertEqual(cancelled.length, 3, `failed root ${index} cancellation fanout`)

    scheduler.confirmWorkerExit(child.id, "child exit before descendant")
    if (root.status === "failed") prematureRootTerminals++
    scheduler.confirmWorkerExit(sibling.id, "sibling exit")
    if (root.status === "failed") prematureRootTerminals++
    scheduler.confirmWorkerExit(grandchild.id, "grandchild exit")
    failureWorkerExits += 3
    assertEqual(root.status, "failed", `failed root ${index} terminal status`)
  }

  const ghostReviewBarriers = scheduler.getReviewBarriers().length
    + scheduler.getRunning().filter((task) => task.status === "waiting-review").length
  assertEqual(prematureRootTerminals, 0, "premature root terminal count")
  assertEqual(reviewDecisions, REVIEW_TREE_COUNT, "tree review decision count")
  assertEqual(failureWorkerExits, FAILURE_TREE_COUNT * 3, "failure tree Worker exit count")
  assertEqual(ghostReviewBarriers, 0, "ghost waiting-review barriers")
  assertEqual(scheduler.getQueue().length, 0, "tree scheduler final queue")
  assertEqual(scheduler.getRunning().length, 0, "tree scheduler final active tasks")

  return {
    reviewTrees: REVIEW_TREE_COUNT,
    failureTrees: FAILURE_TREE_COUNT,
    reviewDecisions,
    failureWorkerExits,
    prematureRootTerminals,
    ghostReviewBarriers,
    finalQueued: scheduler.getQueue().length,
    finalActive: scheduler.getRunning().length,
  }
}

function stressNonCooperativeSchedulerWorkers() {
  const scheduler = new TaskScheduler(2, NON_COOPERATIVE_COUNT * 2 + 10)
  let competitorsBlockedBeforeExit = 0
  let competitorsStartedAfterExit = 0
  let exitAcknowledgements = 0

  for (let index = 0; index < NON_COOPERATIVE_COUNT; index++) {
    const resource = `non-cooperative/shared-${index}`
    const first = scheduler.enqueue({
      sessionId: `non-cooperative-first-${index}`,
      agentId: "non-cooperative-worker",
      priority: 8,
      type: "background",
      message: "holds write lease",
      workingDir: ".",
      resourceClaims: { reads: [], writes: [resource] },
      onCancel: () => {},
    })
    assertEqual(scheduler.cancel(first.id), true, `non-cooperative cancel ${index}`)
    assertEqual(scheduler.cancel(first.id), true, `idempotent non-cooperative cancel ${index}`)
    const competitor = scheduler.enqueue({
      sessionId: `non-cooperative-second-${index}`,
      agentId: "competing-worker",
      priority: 8,
      type: "background",
      message: "competing write",
      workingDir: ".",
      resourceClaims: { reads: [], writes: [`${resource}/file.c`] },
    })
    if (competitor.status === "queued") competitorsBlockedBeforeExit++
    assertEqual(first.status, "cancelling", `non-cooperative lease state ${index}`)
    assertEqual(competitor.status, "queued", `competing task before Worker exit ${index}`)
    assertEqual(scheduler.confirmWorkerExit(first.id, "deterministic Worker exit"), true, `Worker exit ${index}`)
    exitAcknowledgements++
    if (competitor.status === "running") competitorsStartedAfterExit++
    assertEqual(first.status, "cancelled", `cancelled task after Worker exit ${index}`)
    assertEqual(competitor.status, "running", `competing task after Worker exit ${index}`)
    scheduler.completeTask(competitor.id, "competitor complete")
  }

  assertEqual(competitorsBlockedBeforeExit, NON_COOPERATIVE_COUNT, "competitors blocked before Worker exit")
  assertEqual(competitorsStartedAfterExit, NON_COOPERATIVE_COUNT, "competitors started after Worker exit")
  assertEqual(exitAcknowledgements, NON_COOPERATIVE_COUNT, "Worker exit acknowledgements")
  assertEqual(scheduler.getQueue().length, 0, "non-cooperative final queue")
  assertEqual(scheduler.getRunning().length, 0, "non-cooperative final active tasks")
  assertEqual(scheduler.getReviewBarriers().length, 0, "non-cooperative ghost reviews")

  return {
    cycles: NON_COOPERATIVE_COUNT,
    competitorsBlockedBeforeExit,
    competitorsStartedAfterExit,
    exitAcknowledgements,
    ghostReviewBarriers: scheduler.getReviewBarriers().length,
    finalQueued: scheduler.getQueue().length,
    finalActive: scheduler.getRunning().length,
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`)
  }
}
