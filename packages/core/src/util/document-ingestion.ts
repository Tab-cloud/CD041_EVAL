/**
 * Unified, local-only document ingestion.
 *
 * Extractors turn document bytes into normalized text and metadata. They never
 * call an LLM, access the network, or write to the workspace. Domain tools may
 * layer analysis on top without changing the document reader's authority.
 */
import { extname } from "node:path"
import { extractOfficeDocument, isOfficeDocument } from "./office.ts"
import { extractPdfTextFromBuffer, isGraphicalPdf } from "./pdf.ts"

export type IngestedDocumentFormat = "PDF" | "DOC" | "DOCX" | "XLSX" | "PPTX"

export interface DocumentIngestionInput {
  name: string
  mime?: string
  bytes: Uint8Array
  maxChars?: number
}

export interface IngestedDocument {
  format: IngestedDocumentFormat
  parser: string
  text: string
  pages: number
  truncated: boolean
  graphical: boolean
}

export type DocumentIngestionErrorCode = "unsupported-document" | "document-extraction-failed"

export class DocumentIngestionError extends Error {
  constructor(
    readonly code: DocumentIngestionErrorCode,
    message: string,
    readonly extractor?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "DocumentIngestionError"
  }
}

/** Adapter contract for one document family. */
export abstract class DocumentExtractor {
  abstract readonly id: string
  abstract supports(input: Pick<DocumentIngestionInput, "name" | "mime" | "bytes">): boolean
  abstract extract(input: DocumentIngestionInput): Promise<IngestedDocument>
}

export class PdfDocumentExtractor extends DocumentExtractor {
  readonly id = "unpdf"

  supports(input: Pick<DocumentIngestionInput, "name" | "mime" | "bytes">): boolean {
    return input.mime?.toLowerCase() === "application/pdf"
      || extname(input.name).toLowerCase() === ".pdf"
      || hasMagic(input.bytes, [0x25, 0x50, 0x44, 0x46])
  }

  async extract(input: DocumentIngestionInput): Promise<IngestedDocument> {
    try {
      const result = await extractPdfTextFromBuffer(input.bytes, { maxChars: input.maxChars })
      return {
        format: "PDF",
        parser: this.id,
        text: result.text,
        pages: result.pages,
        truncated: result.truncated,
        graphical: isGraphicalPdf(result.text),
      }
    } catch (error) {
      throw new DocumentIngestionError(
        "document-extraction-failed",
        `PDF 文本提取失败: ${errorMessage(error)}`,
        this.id,
        { cause: error },
      )
    }
  }
}

export class OfficeDocumentExtractor extends DocumentExtractor {
  readonly id = "office"

  supports(input: Pick<DocumentIngestionInput, "name" | "mime">): boolean {
    return isOfficeDocument(input.name, input.mime ?? "")
  }

  async extract(input: DocumentIngestionInput): Promise<IngestedDocument> {
    try {
      const result = await extractOfficeDocument(
        input.bytes,
        input.mime ?? "",
        input.maxChars,
        input.name,
      )
      if (!result) {
        throw new DocumentIngestionError(
          "unsupported-document",
          `不支持的 Office 文档格式: ${input.name}`,
          this.id,
        )
      }
      return {
        format: result.format,
        parser: result.parser,
        text: result.text,
        pages: result.pages ?? 0,
        truncated: result.truncated,
        graphical: false,
      }
    } catch (error) {
      if (error instanceof DocumentIngestionError) throw error
      throw new DocumentIngestionError(
        "document-extraction-failed",
        `Office 文档提取失败: ${errorMessage(error)}`,
        this.id,
        { cause: error },
      )
    }
  }
}

export class DocumentIngestionPipeline {
  constructor(readonly extractors: readonly DocumentExtractor[]) {}

  async ingest(input: DocumentIngestionInput): Promise<IngestedDocument> {
    const extractor = this.extractors.find((candidate) => candidate.supports(input))
    if (!extractor) {
      throw new DocumentIngestionError(
        "unsupported-document",
        `没有适用于 ${input.name} 的文档提取器`,
      )
    }
    return extractor.extract({ ...input, maxChars: input.maxChars ?? 200_000 })
  }
}

export const documentIngestionPipeline = new DocumentIngestionPipeline([
  new PdfDocumentExtractor(),
  new OfficeDocumentExtractor(),
])

export function isPdfDocument(name: string, mime = "", bytes?: Uint8Array): boolean {
  return mime.toLowerCase() === "application/pdf"
    || extname(name).toLowerCase() === ".pdf"
    || Boolean(bytes && hasMagic(bytes, [0x25, 0x50, 0x44, 0x46]))
}

function hasMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.byteLength >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
