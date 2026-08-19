import { invoke } from "@tauri-apps/api/core"

export const WORKSPACE_FILE_SCHEME = "eval-workspace-file:"

const SPECIAL_FILE_NAMES = new Set([
  "cmakelists.txt", "makefile", "dockerfile", "license", "readme", "readme.md",
  "agents.md", "package.json", "cargo.toml", "pyproject.toml", "tsconfig.json",
])

/**
 * Recognize file references emitted as inline Markdown code without turning
 * ordinary identifiers, commands, URLs or configuration expressions into links.
 */
export function workspaceFileReference(value: string): string | null {
  const reference = value.trim()
  if (!reference || reference.length > 1_000 || /[\r\n]/.test(reference) || reference.includes("\0")) return null
  if (/^(?:https?|file|mailto|data):/i.test(reference) || reference.startsWith("#")) return null
  if (/[?*<>|]/.test(reference) || reference.includes("=")) return null

  const normalized = reference.replace(/\\/g, "/")
  if (normalized.endsWith("/")) return null
  const fileName = normalized.split("/").pop()?.toLowerCase() ?? ""
  const hasPath = normalized.includes("/") || /^[a-z]:\//i.test(normalized)
  const hasFileShape = /(?:^|.)\.[a-z0-9][a-z0-9._-]*$/i.test(fileName)
    || SPECIAL_FILE_NAMES.has(fileName)
  return hasFileShape && (hasPath || SPECIAL_FILE_NAMES.has(fileName)) ? reference : null
}

export function workspaceFileHref(reference: string): string {
  return `${WORKSPACE_FILE_SCHEME}${encodeURIComponent(reference)}`
}

export function workspaceFileReferenceFromHref(href: string): string | null {
  if (!href.startsWith(WORKSPACE_FILE_SCHEME)) {
    try {
      return workspaceFileReference(decodeURI(href))
    } catch {
      return null
    }
  }
  try {
    return workspaceFileReference(decodeURIComponent(href.slice(WORKSPACE_FILE_SCHEME.length)))
  } catch {
    return null
  }
}

export function remarkWorkspaceFileLinks() {
  return (tree: MarkdownNode) => transformInlineFileReferences(tree)
}

export async function openWorkspaceFile(workspace: string, reference: string): Promise<void> {
  if (!workspace.trim()) throw new Error("当前会话没有工作区，无法打开文件")
  const safeReference = workspaceFileReference(reference)
  if (!safeReference) throw new Error("这不是可打开的工作区文件路径")
  await invoke("open_workspace_file", { workspace, path: safeReference })
}

interface MarkdownNode {
  type?: string
  value?: string
  children?: MarkdownNode[]
  url?: string
}

function transformInlineFileReferences(node: MarkdownNode): void {
  if (!Array.isArray(node.children)) return
  node.children = node.children.map((child) => {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const reference = workspaceFileReference(child.value)
      if (reference) {
        return {
          type: "link",
          url: workspaceFileHref(reference),
          children: [{ type: "text", value: reference }],
        }
      }
    }
    transformInlineFileReferences(child)
    return child
  })
}
