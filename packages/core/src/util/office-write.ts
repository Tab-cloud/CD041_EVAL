/**
 * 办公文档生成：纯文本 → DOCX / XLSX / PPTX
 * 基于 jszip + 最小 OOXML 模板（不引入额外依赖）
 */
import JSZip from "jszip"

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** DOCX：文本按段落分割（空行 = 新段落） */
function buildDocxXml(content: string): string {
  const paras = content.split(/\n\s*\n/).filter(Boolean)
  const bodyXml = paras.map(p => {
    const lines = p.trim().split("\n")
    const runs = lines.map(l => `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${escapeXml(l)}</w:t></w:r>`).join("<w:br/>")
    return `<w:p>${runs}</w:p>`
  }).join("")
  return bodyXml
}

function buildDocx(content: string): Promise<Uint8Array> {
  const bodyXml = buildDocxXml(content)
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${bodyXml}</w:body>
</w:document>`

  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

  const contentTypes = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

  const zip = new JSZip()
  zip.file("[Content_Types].xml", contentTypes)
  zip.file("_rels/.rels", rels)
  zip.file("word/document.xml", docXml)

  return zip.generateAsync({ type: "uint8array" })
}

/** XLSX：内容为 TSV（制表符分隔） */
function buildXlsx(content: string): Promise<Uint8Array> {
  const rows = content.split("\n").filter(row => row.trim())
  const cellsMap: string[] = []
  const cellData: number[][] = []

  for (const row of rows) {
    const cols = row.split("\t")
    const cellRow: number[] = []
    for (const col of cols) {
      const idx = cellsMap.indexOf(col)
      if (idx === -1) {
        cellsMap.push(col)
        cellRow.push(cellsMap.length - 1)
      } else {
        cellRow.push(idx)
      }
    }
    cellData.push(cellRow)
  }

  const siXml = cellsMap.map((v) => `<si><t>${escapeXml(v)}</t></si>`).join("")

  const rowsXml = cellData.map((row, ri) => {
    const cellsXml = row.map((si, ci) => {
      const colLetter = String.fromCharCode(65 + ci)
      return `<c r="${colLetter}${ri + 1}" t="s"><v>${si}</v></c>`
    }).join("")
    return `<row r="${ri + 1}">${cellsXml}</row>`
  }).join("")

  const sheetXml = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
</worksheet>`

  const sharedStrings = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${cellsMap.length}" uniqueCount="${cellsMap.length}">
  ${siXml}
</sst>`

  const contentTypes = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`

  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const workbook = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

  const zip = new JSZip()
  zip.file("[Content_Types].xml", contentTypes)
  zip.file("_rels/.rels", rels)
  zip.file("xl/workbook.xml", workbook)
  zip.file("xl/sharedStrings.xml", sharedStrings)
  zip.file("xl/worksheets/sheet1.xml", sheetXml)

  return zip.generateAsync({ type: "uint8array" })
}

/** PPTX：以 `---` 分隔幻灯片，每段第一行为标题 */
function buildPptx(content: string): Promise<Uint8Array> {
  const slides = content.split(/^---$/m).map(s => s.trim()).filter(Boolean)
  const zip = new JSZip()

  const contentTypes = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("\n")}
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`

  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`

  const slideRels = slides.map((_, i) =>
    `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
  ).join("")

  const presRel = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slideRels}
</Relationships>`

  const presXml = `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    ${slides.map((_, i) => `<p:sldId id="${i + 1}" r:id="rId${i + 2}"/>`).join("\n")}
  </p:sldIdLst>
</p:presentation>`

  zip.file("[Content_Types].xml", contentTypes)
  zip.file("_rels/.rels", rels)
  zip.file("ppt/_rels/presentation.xml.rels", presRel)
  zip.file("ppt/presentation.xml", presXml)

  for (let i = 0; i < slides.length; i++) {
    const lines = slides[i].split("\n").filter(Boolean)
    const title = lines[0] || `Slide ${i + 1}`
    const bullets = lines.slice(1).map(l => `<a:p><a:r><a:t>${escapeXml(l)}</a:t></a:r></a:p>`).join("")
    const slideXml = `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p><a:r><a:rPr lang="zh-CN"/><a:t>${escapeXml(title)}</a:t></a:r></a:p>
          ${bullets}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml)
  }

  return zip.generateAsync({ type: "uint8array" })
}

export type OfficeFormat = "docx" | "xlsx" | "pptx"

export async function buildOfficeFile(content: string, format: OfficeFormat): Promise<Uint8Array> {
  switch (format) {
    case "docx": return buildDocx(content)
    case "xlsx": return buildXlsx(content)
    case "pptx": return buildPptx(content)
  }
}

/** 文件扩展名 */
export function officeExt(format: OfficeFormat): string {
  return { docx: ".docx", xlsx: ".xlsx", pptx: ".pptx" }[format]
}
