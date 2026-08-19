declare module "word-extractor" {
  interface ExtractOptions {
    filterUnicode?: boolean
    includeFooters?: boolean
    includeHeadersAndFooters?: boolean
    includeBody?: boolean
  }

  interface ExtractedWordDocument {
    getBody(options?: ExtractOptions): string
    getHeaders(options?: ExtractOptions): string
    getFooters(options?: ExtractOptions): string
    getFootnotes(options?: ExtractOptions): string
    getEndnotes(options?: ExtractOptions): string
    getAnnotations(options?: ExtractOptions): string
    getTextboxes(options?: ExtractOptions): string
  }

  export default class WordExtractor {
    extract(source: string | Buffer): Promise<ExtractedWordDocument>
  }
}
