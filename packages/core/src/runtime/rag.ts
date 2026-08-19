import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { extractOfficeDocument, isOfficeDocument } from "../util/office.ts"

export interface MemoryDocument {
  id: string
  content: string
  source: string
  projectRoot: string
  tokens: Map<string, number>
  timestamp: number
  score?: number
}

const INDEX_EXTENSIONS = new Set([".c", ".h", ".cpp", ".hpp", ".md", ".txt", ".json", ".toml", ".cmake", ".doc", ".docx", ".xlsx", ".pptx"])
const SKIP_DIRS = new Set([".git", ".eval", "build", "dist", "node_modules", "target"])
const MAX_DOCUMENTS = 500
const MAX_INDEX_BYTES = 5 * 1024 * 1024
const REFRESH_INTERVAL_MS = 60_000

export class RAGEngine {
  private projects = new Map<string, MemoryDocument[]>()
  private indexedAt = new Map<string, number>()

  addDocument(content: string, source: string, projectRoot = process.cwd()): MemoryDocument {
    const root = resolve(projectRoot)
    const documents = this.projects.get(root) ?? []
    const doc: MemoryDocument = {
      id: `doc-${randomUUID()}`,
      content,
      source,
      projectRoot: root,
      tokens: this.tokenize(content),
      timestamp: Date.now(),
    }
    documents.push(doc)
    if (documents.length > MAX_DOCUMENTS) documents.splice(0, documents.length - MAX_DOCUMENTS)
    this.projects.set(root, documents)
    return doc
  }

  async ensureIndexed(projectDir: string): Promise<number> {
    const root = resolve(projectDir)
    const lastIndexed = this.indexedAt.get(root) ?? 0
    if (Date.now() - lastIndexed < REFRESH_INTERVAL_MS && this.projects.has(root)) {
      return this.projects.get(root)!.length
    }
    return this.indexProject(root)
  }

  async indexProject(projectDir: string): Promise<number> {
    const root = realpathSync.native(resolve(projectDir))
    this.projects.set(root, [])
    let totalBytes = 0

    const walk = async (dir: string): Promise<void> => {
      if (totalBytes >= MAX_INDEX_BYTES || (this.projects.get(root)?.length ?? 0) >= MAX_DOCUMENTS) return
      let entries: ReturnType<typeof readdirSync>
      try { entries = readdirSync(dir, { withFileTypes: true }) as any } catch { return }
      for (const entry of entries as any[]) {
        if (totalBytes >= MAX_INDEX_BYTES || (this.projects.get(root)?.length ?? 0) >= MAX_DOCUMENTS) break
        if (SKIP_DIRS.has(entry.name)) continue
        const fullPath = join(dir, entry.name)
        try {
          if (lstatSync(fullPath).isSymbolicLink()) continue
          if (entry.isDirectory()) {
            await walk(fullPath)
          } else if (entry.isFile() && INDEX_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
            let content: string
            if (isOfficeDocument(entry.name)) {
              const raw = readFileSync(fullPath)
              if (raw.length > 20 * 1024 * 1024) continue
              const extracted = await extractOfficeDocument(raw, "", 20_000, entry.name)
              if (!extracted) continue
              content = extracted.text
            } else {
              content = readFileSync(fullPath, "utf-8").slice(0, 20_000)
            }
            totalBytes += Buffer.byteLength(content)
            this.addDocument(content, fullPath, root)
          }
        } catch { /* 跳过不可读或在扫描中被删除的文件 */ }
      }
    }

    if (existsSync(root)) await walk(root)
    this.indexedAt.set(root, Date.now())
    return this.projects.get(root)?.length ?? 0
  }

  search(query: string, topK = 5, projectDir?: string): MemoryDocument[] {
    const candidates = projectDir
      ? this.projects.get(resolve(projectDir)) ?? []
      : Array.from(this.projects.values()).flat()
    if (candidates.length === 0) return []
    const queryTokens = this.tokenize(query)
    return candidates
      .map((doc) => ({ ...doc, score: this.cosineSimilarity(queryTokens, doc.tokens) }))
      .filter((doc) => doc.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(topK, 10)))
  }

  buildRAGContext(query: string, projectDir: string, topK = 3): string {
    const results = this.search(query, topK, projectDir)
    if (results.length === 0) return ""
    const lines = ["## 当前项目相关代码/文档（本地检索）", ""]
    for (const doc of results) {
      const relPath = relative(projectDir, doc.source).replace(/\\/g, "/")
      lines.push(`### ${relPath}（相关度 ${(doc.score! * 100).toFixed(0)}%）`)
      lines.push(doc.content.slice(0, 800))
      lines.push("")
    }
    return lines.join("\n")
  }

  private tokenize(text: string, maxTokens = 2_000): Map<string, number> {
    const tokens = new Map<string, number>()
    const words = text.toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9_]+/g) ?? []
    for (const word of words.slice(0, maxTokens)) tokens.set(word, (tokens.get(word) ?? 0) + 1)
    return tokens
  }

  private cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0
    let normA = 0
    let normB = 0
    for (const [word, count] of a) {
      dot += count * (b.get(word) ?? 0)
      normA += count * count
    }
    for (const count of b.values()) normB += count * count
    return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
  }

  getDocumentCount(projectDir?: string): number {
    return projectDir
      ? this.projects.get(resolve(projectDir))?.length ?? 0
      : Array.from(this.projects.values()).reduce((sum, docs) => sum + docs.length, 0)
  }
}

export const ragEngine = new RAGEngine()
