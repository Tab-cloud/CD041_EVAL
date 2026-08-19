/**
 * Checkpoint — 任务中断恢复 (LangGraph 简化版)
 *
 * 使用 SQLite 存储 Agent 执行状态，支持中断后从上次位置继续。
 * 参考 LangGraph: channel_values + pending_sends + versions_seen
 */
import { getDb } from "../store/database"

// ══════════════════════════════════════════════
// 类型
// ══════════════════════════════════════════════

export interface CheckpointData {
  id: string
  sessionId: string
  agentId: string
  /** 当前执行到第几步 */
  step: number
  /** 完整消息历史 (JSON) */
  messages: string
  /** 待处理的工具调用 */
  pendingToolCalls: string
  /** 计划状态 (JSON) */
  planState: string | null
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

// ══════════════════════════════════════════════
// Checkpoint Manager
// ══════════════════════════════════════════════

export class CheckpointManager {
  constructor() {
    this.initTable()
  }

  private initTable() {
    getDb().run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        messages TEXT NOT NULL DEFAULT '[]',
        pending_tool_calls TEXT NOT NULL DEFAULT '[]',
        plan_state TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    getDb().run("CREATE INDEX IF NOT EXISTS idx_checkpoint_session ON checkpoints(session_id)")
  }

  /**
   * 保存检查点
   */
  save(data: {
    sessionId: string
    agentId: string
    step: number
    messages: unknown[]
    pendingToolCalls: unknown[]
    planState?: unknown
  }): CheckpointData {
    const now = Date.now()
    const id = `ckpt-${data.sessionId}-${data.step}`

    // UPSERT
    const existing = getDb().query("SELECT id FROM checkpoints WHERE id = ?").get(id)
    if (existing) {
      getDb().run(
        `UPDATE checkpoints SET messages=?, pending_tool_calls=?, plan_state=?, updated_at=? WHERE id=?`,
        [JSON.stringify(data.messages), JSON.stringify(data.pendingToolCalls),
         data.planState ? JSON.stringify(data.planState) : null, now, id],
      )
    } else {
      getDb().run(
        `INSERT INTO checkpoints (id, session_id, agent_id, step, messages, pending_tool_calls, plan_state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, data.sessionId, data.agentId, data.step,
         JSON.stringify(data.messages), JSON.stringify(data.pendingToolCalls),
         data.planState ? JSON.stringify(data.planState) : null, now, now],
      )
    }

    return {
      id, sessionId: data.sessionId, agentId: data.agentId, step: data.step,
      messages: JSON.stringify(data.messages),
      pendingToolCalls: JSON.stringify(data.pendingToolCalls),
      planState: data.planState ? JSON.stringify(data.planState) : null,
      createdAt: now, updatedAt: now,
    }
  }

  /**
   * 加载最新的检查点
   */
  loadLatest(sessionId: string): CheckpointData | null {
    const row = getDb().query(
      "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY step DESC LIMIT 1",
    ).get(sessionId) as Record<string, any> | null
    if (!row) return null
    return {
      id: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      step: row.step,
      messages: row.messages,
      pendingToolCalls: row.pending_tool_calls,
      planState: row.plan_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * 检查是否有未完成的任务（中断恢复）
   */
  hasUnfinished(sessionId: string): boolean {
    const row = getDb().query(
      "SELECT COUNT(*) as cnt FROM checkpoints WHERE session_id = ? AND pending_tool_calls != '[]'",
    ).get(sessionId) as { cnt: number }
    return (row?.cnt ?? 0) > 0
  }

  /**
   * 恢复中断的任务
   */
  resumeContext(sessionId: string): {
    messages: unknown[]
    pendingToolCalls: unknown[]
    step: number
  } | null {
    const ckpt = this.loadLatest(sessionId)
    if (!ckpt) return null

    try {
      return {
        messages: JSON.parse(ckpt.messages),
        pendingToolCalls: JSON.parse(ckpt.pendingToolCalls),
        step: ckpt.step,
      }
    } catch {
      return null
    }
  }

  /**
   * 清理旧的检查点（保留最近 5 个）
   */
  cleanup(sessionId: string): void {
    getDb().run(
      `DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (
        SELECT id FROM checkpoints WHERE session_id = ? ORDER BY updated_at DESC LIMIT 5
      )`,
      [sessionId, sessionId],
    )
  }

  /** 任务成功完成后删除检查点，避免把已执行的副作用再次恢复。 */
  clear(sessionId: string): void {
    getDb().run("DELETE FROM checkpoints WHERE session_id = ?", [sessionId])
  }
}

export const checkpointManager = new CheckpointManager()
