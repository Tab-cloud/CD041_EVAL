import { useCallback, useState, type MouseEvent, type ReactNode } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CheckIcon, CopyIcon, FileIcon } from "./Icons"
import {
  openWorkspaceFile,
  remarkWorkspaceFileLinks,
  WORKSPACE_FILE_SCHEME,
  workspaceFileReferenceFromHref,
} from "../workspace-file-links"
import { openExternalWebUrl, resolveExternalWebUrl } from "../external-links"

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager")
    await writeText(text)
    return true
  } catch {
    try { await navigator.clipboard.writeText(text); return true } catch { return false }
  }
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(async () => {
    if (!await copyToClipboard(text)) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }, [text])
  return (
    <button className={`code-copy-btn ${className ?? ""}`} onClick={handleCopy} title={copied ? "已复制" : "复制"}>
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  )
}

const baseComponents = {
  pre: ({ children, ...props }: any) => {
    const code = children?.props?.children ?? ""
    const language = children?.props?.className?.replace("language-", "") ?? ""
    const text = Array.isArray(code) ? code.join("") : String(code)
    return (
      <div className="code-block-wrap" data-language={language.toLowerCase()}>
        <div className="code-block-header">
          <span className="code-block-lang">{language || "text"}</span>
          <CopyButton text={text} />
        </div>
        <pre {...props} className={props.className}>{children}</pre>
      </div>
    )
  },
  table: ({ children }: any) => {
    const extract = (node: any): string => {
      if (typeof node === "string") return node
      const child = node?.props?.children
      if (!child) return ""
      return Array.isArray(child) ? child.map(extract).join("") : extract(child)
    }
    return (
      <div className="table-wrap">
        <div className="table-toolbar"><CopyButton text={extract(children)} /></div>
        <table>{children}</table>
      </div>
    )
  },
}

export function ChatMarkdown({ children, workspace }: { children: string; workspace?: string | null }) {
  const components = {
    ...baseComponents,
    a: ({ href = "", children: label, ...props }: any) => {
      const reference = workspaceFileReferenceFromHref(href)
      if (reference) {
        return <WorkspaceFileLink workspace={workspace} reference={reference}>{label}</WorkspaceFileLink>
      }
      const externalUrl = resolveExternalWebUrl(href)
      if (externalUrl) {
        return <ExternalWebLink {...props} href={externalUrl}>{label}</ExternalWebLink>
      }
      return <a {...props} href={href}>{label}</a>
    },
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkWorkspaceFileLinks]}
      components={components}
      urlTransform={(url) => url.startsWith(WORKSPACE_FILE_SCHEME) ? url : defaultUrlTransform(url)}
    >
      {children}
    </ReactMarkdown>
  )
}

function ExternalWebLink({ href, children, ...props }: { href: string; children: ReactNode; [key: string]: unknown }) {
  const [error, setError] = useState("")
  const open = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setError("")
    try {
      await openExternalWebUrl(href)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      console.error("[external-link] failed:", message)
    }
  }
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => void open(event)}
      title={error || `在系统浏览器中打开 ${href}`}
      aria-label={`在系统浏览器中打开 ${String(children)}`}
    >
      {children}
    </a>
  )
}

function WorkspaceFileLink({
  workspace,
  reference,
  children,
}: {
  workspace?: string | null
  reference: string
  children: ReactNode
}) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState("")
  if (!workspace) return <code>{children}</code>

  const open = async () => {
    setOpening(true)
    setError("")
    try {
      await openWorkspaceFile(workspace, reference)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOpening(false)
    }
  }

  return (
    <button
      type="button"
      className={`workspace-file-link ${error ? "error" : ""}`}
      onClick={() => void open()}
      disabled={opening}
      title={error || `打开 ${reference}`}
      aria-label={`打开工作区文件 ${reference}`}
    >
      <FileIcon size={11} />
      <code>{children}</code>
      {opening && <span className="workspace-file-state">打开中</span>}
      {error && <span className="workspace-file-state">无法打开</span>}
    </button>
  )
}
