import { useCallback, useState, type ClipboardEvent, type Dispatch, type SetStateAction } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { readFile, readTextFile, stat } from "@tauri-apps/plugin-fs"
import type { Attachment } from "../components/chat-helpers"
import { detectKind } from "../components/chat-helpers"

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024
const MAX_ATTACHMENT_COUNT = 10

export function useChatAttachments(
  workspace: string | null,
  attachments: Attachment[],
  setAttachments: Dispatch<SetStateAction<Attachment[]>>,
) {
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const addAttachment = async () => {
    setAttachmentError(null)
    try {
      const selected = await open({
        multiple: true,
        title: "选择文件（原理图 / 代码 / 手册）",
        defaultPath: workspace || undefined,
      }) as string | string[] | null
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      const list: Attachment[] = []
      let uploadedBytes = attachments.reduce((sum, item) => sum + item.size, 0)
      for (const path of paths) {
        if (attachments.length + list.length >= MAX_ATTACHMENT_COUNT) {
          setAttachmentError("单次指令最多添加 10 个附件")
          break
        }
        const name = path.split(/[/\\]/).pop() ?? "unknown"
        let size = 0
        let mime = "application/octet-stream"
        try {
          const fileStat = await stat(path)
          size = fileStat.size
          mime = (fileStat as { mime?: string }).mime ?? mime
        } catch (error) {
          console.warn(`无法读取附件大小: ${name}`, error)
          setAttachmentError(`无法读取附件：${name}`)
          continue
        }
        if (mime === "application/octet-stream") {
          const ext = name.split(".").pop()?.toLowerCase()
          const mimeByExtension: Record<string, string> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
            pdf: "application/pdf",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            txt: "text/plain",
            md: "text/markdown",
            json: "application/json",
          }
          if (ext && mimeByExtension[ext]) mime = mimeByExtension[ext]
        }
        const kind = detectKind(name, mime)
        if (size > MAX_ATTACHMENT_BYTES) {
          console.warn(`${name} 超过 32MB，跳过`)
          setAttachmentError(`${name} 超过 32MB，未添加`)
          continue
        }
        if (uploadedBytes + size > MAX_TOTAL_ATTACHMENT_BYTES) {
          console.warn("附件总大小超过 64MB，跳过后续文件")
          setAttachmentError("附件总大小超过 64MB，后续文件未添加")
          break
        }
        const attachment: Attachment = { name, path, size, mime, kind }
        if (kind === "image") {
          try {
            const bytes = await readFile(path)
            attachment.size = bytes.byteLength
            attachment.dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`
          } catch (error) {
            console.warn(`图片读取失败: ${name}`, error)
            setAttachmentError(`图片读取失败：${name}`)
            continue
          }
        } else if (kind === "text" && size <= 100 * 1024) {
          try {
            attachment.content = await readTextFile(path)
            attachment.size = new TextEncoder().encode(attachment.content).byteLength
          } catch (error) {
            console.warn(`文本附件读取失败: ${name}`, error)
            setAttachmentError(`文本附件读取失败：${name}`)
            continue
          }
        } else {
          try {
            const bytes = await readFile(path)
            attachment.size = bytes.byteLength
            attachment.dataBase64 = bytesToBase64(bytes)
          } catch (error) {
            console.warn(`附件读取失败: ${name}`, error)
            setAttachmentError(`附件读取失败：${name}`)
            continue
          }
        }
        if (attachment.size > MAX_ATTACHMENT_BYTES) {
          setAttachmentError(`${name} 超过 32MB，未添加`)
          continue
        }
        if (uploadedBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES) {
          setAttachmentError("附件总大小超过 64MB，后续文件未添加")
          break
        }
        list.push(attachment)
        uploadedBytes += attachment.size
      }
      setAttachments((previous) => [...previous, ...list])
    } catch (error) {
      console.error("文件选择失败:", error)
      setAttachmentError(`文件选择失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((previous) => previous.filter((_, itemIndex) => itemIndex !== index))
  }

  const handlePaste = useCallback(async (event: ClipboardEvent) => {
    setAttachmentError(null)
    const items = event.clipboardData?.items
    if (!items || items.length === 0) return
    const newAttachments: Attachment[] = []
    let uploadedBytes = attachments.reduce((sum, item) => sum + item.size, 0)
    for (let index = 0; index < items.length; index++) {
      if (attachments.length + newAttachments.length >= MAX_ATTACHMENT_COUNT) {
        setAttachmentError("单次指令最多添加 10 个附件")
        break
      }
      const item = items[index]
      if (item.kind !== "file") continue
      const file = item.getAsFile()
      if (!file) continue
      const name = file.name || `clipboard-${Date.now()}.${item.type.split("/")[1] || "png"}`
      const mime = file.type || item.type || "application/octet-stream"
      const kind = detectKind(name, mime)
      const size = file.size
      if (size > MAX_ATTACHMENT_BYTES) {
        console.warn(`${name} 超过 32MB，跳过`)
        setAttachmentError(`${name} 超过 32MB，未添加`)
        continue
      }
      const attachment: Attachment = { name, path: "", size, mime, kind }
      if (kind === "image") {
        try {
          attachment.dataUrl = await readBlob(file, "data-url")
        } catch (error) {
          console.warn(`剪贴板图片读取失败: ${name}`, error)
          setAttachmentError(`剪贴板图片读取失败：${name}`)
          continue
        }
      } else if (kind === "text" && size <= 100 * 1024) {
        try {
          attachment.content = await readBlob(file, "text")
          attachment.size = new TextEncoder().encode(attachment.content).byteLength
        } catch (error) {
          console.warn(`剪贴板文本读取失败: ${name}`, error)
          setAttachmentError(`剪贴板文本读取失败：${name}`)
          continue
        }
      } else {
        try {
          attachment.dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
        } catch (error) {
          console.warn(`剪贴板附件读取失败: ${name}`, error)
          setAttachmentError(`剪贴板附件读取失败：${name}`)
          continue
        }
      }
      if (uploadedBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        setAttachmentError("附件总大小超过 64MB，后续文件未添加")
        break
      }
      newAttachments.push(attachment)
      uploadedBytes += attachment.size
    }
    if (newAttachments.length === 0) {
      const text = event.clipboardData.getData("text")
      const lineCount = text.split("\n").length
      if (text.length > 500 || lineCount > 10) {
        event.preventDefault()
        const size = new TextEncoder().encode(text).byteLength
        if (attachments.length >= MAX_ATTACHMENT_COUNT) {
          setAttachmentError("单次指令最多添加 10 个附件")
        } else if (size > MAX_ATTACHMENT_BYTES) {
          setAttachmentError("粘贴文本超过 32MB，未添加")
        } else if (uploadedBytes + size > MAX_TOTAL_ATTACHMENT_BYTES) {
          setAttachmentError("附件总大小超过 64MB，粘贴文本未添加")
        } else newAttachments.push({
          name: `粘贴文本 - ${lineCount} 行`,
          path: "",
          size,
          mime: "text/plain",
          kind: "text",
          content: text,
        })
      }
    }
    if (newAttachments.length > 0) {
      setAttachments((previous) => [...previous, ...newAttachments])
    }
  }, [attachments, setAttachments])

  return {
    addAttachment,
    removeAttachment,
    handlePaste,
    attachmentError,
    clearAttachmentError: () => setAttachmentError(null),
  }
}

function readBlob(blob: Blob, mode: "data-url"): Promise<string>
function readBlob(blob: Blob, mode: "text"): Promise<string>
function readBlob(blob: Blob, mode: "data-url" | "text") {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    if (mode === "data-url") reader.readAsDataURL(blob)
    else reader.readAsText(blob)
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.slice(index, index + 8192)))
  }
  return btoa(chunks.join(""))
}
