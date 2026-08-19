import type { QueuedInstruction } from "../store"
import { ListChecksIcon, XIcon } from "./Icons"

interface InstructionQueueProps {
  current?: QueuedInstruction
  instructions: QueuedInstruction[]
  onRemove: (instructionId: string) => void
}

export function InstructionQueue({ current, instructions, onRemove }: InstructionQueueProps) {
  if (!current && instructions.length === 0) return null
  return (
    <>
      {current && <AdmissionStatus instruction={current} onRemove={onRemove} />}
      {instructions.length > 0 && (
        <section className="instruction-queue" aria-label={`已排队 ${instructions.length} 条指令`}>
          <div className="instruction-queue-head">
            <ListChecksIcon size={13} />
            <strong>接下来</strong>
            <span>{instructions.length} 条指令已排队</span>
          </div>
          <div className="instruction-queue-list">
            {instructions.map((instruction, index) => (
              <div className="instruction-queue-item" key={instruction.id}>
                <span className="instruction-queue-index">{index + 1}</span>
                <span className="instruction-queue-text" title={instruction.text}>{instruction.text || "附件指令"}</span>
                {instruction.attachments.length > 0 && (
                  <span className="instruction-queue-attachments">{instruction.attachments.length} 个附件</span>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(instruction.id)}
                  title="移出队列"
                  aria-label="移出队列"
                >
                  <XIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function AdmissionStatus({
  instruction,
  onRemove,
}: {
  instruction: QueuedInstruction
  onRemove: (instructionId: string) => void
}) {
  const retrying = instruction.submissionState === "retrying"
  const failed = instruction.submissionState === "failed"
  const retrySeconds = instruction.submissionRetryAt
    ? Math.max(1, Math.ceil((instruction.submissionRetryAt - Date.now()) / 1_000))
    : undefined
  const detail = failed
    ? instruction.submissionError || "请移除后重新选择附件"
    : retrying
    ? `任务已保留，${retrySeconds ?? 1} 秒后自动重试`
    : instruction.serverState === "pending"
      ? "本地服务已接收，正在启动任务"
      : "正在发送到本地 Agent"
  return (
    <section
      className={`instruction-queue instruction-admission${retrying ? " is-retrying" : ""}${failed ? " is-failed" : ""}`}
      aria-label={failed ? "任务未提交" : retrying ? "任务发送失败，正在自动重试" : "任务正在发送"}
      title={instruction.submissionError}
    >
      <div className="instruction-queue-head">
        <ListChecksIcon size={13} />
        <strong>{failed ? "任务未提交" : retrying ? "正在恢复连接" : "正在提交任务"}</strong>
        <span>{detail}</span>
        {failed && (
          <button
            type="button"
            onClick={() => onRemove(instruction.id)}
            title="移除未提交任务"
            aria-label="移除未提交任务"
          >
            <XIcon size={12} />
          </button>
        )}
      </div>
    </section>
  )
}
