import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"

export type FirmwareFormat = "hex"

export interface FirmwareAddressRange {
  /** First address in the range (inclusive). */
  start: number
  /** First address outside the range (exclusive). */
  end: number
}

export interface IntelHexParseOptions {
  /**
   * Optional writable address ranges supplied by a target profile. When set,
   * every data byte must fall in one of these ranges.
   */
  allowedAddressRanges?: readonly FirmwareAddressRange[]
}

export type FirmwareDiagnosticSeverity = "error" | "warning"

export type FirmwareDiagnosticCode =
  | "invalid_record"
  | "invalid_checksum"
  | "unsupported_record_type"
  | "missing_eof"
  | "duplicate_eof"
  | "record_after_eof"
  | "invalid_record_payload"
  | "address_overflow"
  | "overlapping_data"
  | "address_out_of_range"
  | "conflicting_entry_point"

export interface FirmwareDiagnostic {
  severity: FirmwareDiagnosticSeverity
  code: FirmwareDiagnosticCode
  message: string
  line?: number
  addressStart?: number
  addressEnd?: number
}

export interface FirmwareSegment {
  addressStart: number
  /** Last address in the segment (inclusive). */
  addressEnd: number
  byteLength: number
}

export interface IntelHexResult {
  valid: boolean
  programmedBytes: number
  addressStart?: number
  /** Last programmed address (inclusive). */
  addressEnd?: number
  entryAddress?: number
  segments: FirmwareSegment[]
  diagnostics: FirmwareDiagnostic[]
}

export interface FirmwareArtifact extends IntelHexResult {
  format: FirmwareFormat
  path: string
  fileBytes: number
  sha256: string
}

interface DataRecord {
  start: number
  end: number
  line: number
}

const MAX_ADDRESS = 0xffff_ffff

/**
 * Strictly parses Intel HEX records. It accepts record types 00 through 05,
 * validates every checksum and required payload shape, and reports all errors
 * that can be diagnosed without guessing corrupted record contents.
 */
export function parseIntelHex(source: string | Uint8Array, options: IntelHexParseOptions = {}): IntelHexResult {
  const text = typeof source === "string" ? source : new TextDecoder().decode(source)
  const diagnostics: FirmwareDiagnostic[] = []
  const records: DataRecord[] = []
  let baseAddress = 0
  let entryAddress: number | undefined
  let eofSeen = false

  validateRanges(options.allowedAddressRanges)

  const lines = text.split(/\r\n|\n|\r/)
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    const line = lines[index].trim()
    if (line === "") continue

    const parsed = parseRecord(line, lineNumber, diagnostics)
    if (!parsed) continue

    if (eofSeen) {
      diagnostics.push(error("record_after_eof", "Record appears after the EOF record", lineNumber))
      if (parsed.type === 0x01) {
        diagnostics.push(error("duplicate_eof", "More than one EOF record was found", lineNumber))
      }
      continue
    }

    const { address, type, data } = parsed
    switch (type) {
      case 0x00: {
        const absolute = baseAddress + address
        const end = absolute + data.length - 1
        if (absolute > MAX_ADDRESS || end > MAX_ADDRESS) {
          diagnostics.push(error(
            "address_overflow",
            "Data record exceeds the 32-bit Intel HEX address space",
            lineNumber,
            absolute,
            end,
          ))
          break
        }
        if (data.length > 0) records.push({ start: absolute, end, line: lineNumber })
        break
      }
      case 0x01:
        if (address !== 0 || data.length !== 0) {
          diagnostics.push(error("invalid_record_payload", "EOF record must have address 0000 and no data", lineNumber))
        } else {
          eofSeen = true
        }
        break
      case 0x02:
        if (address !== 0 || data.length !== 2) {
          diagnostics.push(error("invalid_record_payload", "Extended segment address record must contain two bytes at address 0000", lineNumber))
        } else {
          baseAddress = readUint16(data) * 0x10
        }
        break
      case 0x03: {
        if (address !== 0 || data.length !== 4) {
          diagnostics.push(error("invalid_record_payload", "Start segment address record must contain four bytes at address 0000", lineNumber))
          break
        }
        const candidate = readUint16(data, 0) * 0x10 + readUint16(data, 2)
        entryAddress = mergeEntryPoint(entryAddress, candidate, lineNumber, diagnostics)
        break
      }
      case 0x04:
        if (address !== 0 || data.length !== 2) {
          diagnostics.push(error("invalid_record_payload", "Extended linear address record must contain two bytes at address 0000", lineNumber))
        } else {
          baseAddress = readUint16(data) * 0x1_0000
        }
        break
      case 0x05: {
        if (address !== 0 || data.length !== 4) {
          diagnostics.push(error("invalid_record_payload", "Start linear address record must contain four bytes at address 0000", lineNumber))
          break
        }
        const candidate = readUint32(data)
        entryAddress = mergeEntryPoint(entryAddress, candidate, lineNumber, diagnostics)
        break
      }
      default:
        diagnostics.push(error("unsupported_record_type", `Unsupported Intel HEX record type 0x${type.toString(16).padStart(2, "0")}`, lineNumber))
    }
  }

  if (!eofSeen) diagnostics.push(error("missing_eof", "Intel HEX file does not contain a valid EOF record"))

  records.sort((a, b) => a.start - b.start || a.end - b.end || a.line - b.line)
  const segments: FirmwareSegment[] = []
  for (const record of records) {
    const previous = segments.at(-1)
    if (previous && record.start <= previous.addressEnd) {
      diagnostics.push(error(
        "overlapping_data",
        `Data at 0x${hex(record.start)} overlaps an earlier data record`,
        record.line,
        record.start,
        Math.min(record.end, previous.addressEnd),
      ))
    }
    if (previous && record.start <= previous.addressEnd + 1) {
      previous.addressEnd = Math.max(previous.addressEnd, record.end)
      previous.byteLength = previous.addressEnd - previous.addressStart + 1
    } else {
      segments.push({
        addressStart: record.start,
        addressEnd: record.end,
        byteLength: record.end - record.start + 1,
      })
    }
  }

  if (options.allowedAddressRanges) {
    for (const segment of segments) {
      reportOutOfRange(segment, options.allowedAddressRanges, diagnostics)
    }
  }

  const programmedBytes = segments.reduce((sum, segment) => sum + segment.byteLength, 0)
  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    programmedBytes,
    addressStart: segments[0]?.addressStart,
    addressEnd: segments.at(-1)?.addressEnd,
    entryAddress,
    segments,
    diagnostics,
  }
}

/** Reads and analyses a HEX artifact, including its on-disk size and SHA-256. */
export async function analyzeFirmwareArtifact(
  path: string,
  options: IntelHexParseOptions = {},
): Promise<FirmwareArtifact> {
  const [contents, metadata] = await Promise.all([readFile(path), stat(path)])
  const parsed = parseIntelHex(contents, options)
  return {
    format: "hex",
    path,
    fileBytes: metadata.size,
    sha256: createHash("sha256").update(contents).digest("hex"),
    ...parsed,
  }
}

function parseRecord(
  line: string,
  lineNumber: number,
  diagnostics: FirmwareDiagnostic[],
): { address: number; type: number; data: Uint8Array } | undefined {
  if (!/^:[0-9a-fA-F]+$/.test(line) || line.length < 11 || (line.length - 1) % 2 !== 0) {
    diagnostics.push(error("invalid_record", "Record must be a colon followed by complete hexadecimal bytes", lineNumber))
    return undefined
  }

  const bytes = Uint8Array.from(line.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16)))
  const declaredLength = bytes[0]
  if (bytes.length !== declaredLength + 5) {
    diagnostics.push(error(
      "invalid_record",
      `Record declares ${declaredLength} data bytes but contains ${Math.max(0, bytes.length - 5)}`,
      lineNumber,
    ))
    return undefined
  }
  const checksum = bytes.reduce((sum, value) => (sum + value) & 0xff, 0)
  if (checksum !== 0) {
    diagnostics.push(error("invalid_checksum", "Intel HEX record checksum is invalid", lineNumber))
    return undefined
  }

  return {
    address: bytes[1] * 0x100 + bytes[2],
    type: bytes[3],
    data: bytes.slice(4, -1),
  }
}

function mergeEntryPoint(
  current: number | undefined,
  candidate: number,
  line: number,
  diagnostics: FirmwareDiagnostic[],
): number {
  if (current !== undefined && current !== candidate) {
    diagnostics.push(error(
      "conflicting_entry_point",
      `Entry point 0x${hex(candidate)} conflicts with the previously declared entry point 0x${hex(current)}`,
      line,
    ))
    return current
  }
  return candidate
}

function reportOutOfRange(
  segment: FirmwareSegment,
  ranges: readonly FirmwareAddressRange[],
  diagnostics: FirmwareDiagnostic[],
): void {
  let cursor = segment.addressStart
  for (const range of ranges) {
    if (range.end <= cursor) continue
    if (range.start > segment.addressEnd) break
    if (range.start > cursor) {
      const end = Math.min(segment.addressEnd, range.start - 1)
      diagnostics.push(error(
        "address_out_of_range",
        `Data range 0x${hex(cursor)}-0x${hex(end)} is outside the configured writable ranges`,
        undefined,
        cursor,
        end,
      ))
    }
    cursor = Math.max(cursor, range.end)
    if (cursor > segment.addressEnd) return
  }
  if (cursor <= segment.addressEnd) {
    diagnostics.push(error(
      "address_out_of_range",
      `Data range 0x${hex(cursor)}-0x${hex(segment.addressEnd)} is outside the configured writable ranges`,
      undefined,
      cursor,
      segment.addressEnd,
    ))
  }
}

function validateRanges(ranges: readonly FirmwareAddressRange[] | undefined): void {
  if (!ranges) return
  let previousEnd = -1
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end <= range.start || range.end > MAX_ADDRESS + 1) {
      throw new RangeError("Allowed address ranges must be valid 32-bit half-open ranges")
    }
    if (range.start < previousEnd) throw new RangeError("Allowed address ranges must be sorted and non-overlapping")
    previousEnd = range.end
  }
}

function readUint16(data: Uint8Array, offset = 0): number {
  return data[offset] * 0x100 + data[offset + 1]
}

function readUint32(data: Uint8Array): number {
  return data[0] * 0x1_000000 + data[1] * 0x1_0000 + data[2] * 0x100 + data[3]
}

function error(
  code: FirmwareDiagnosticCode,
  message: string,
  line?: number,
  addressStart?: number,
  addressEnd?: number,
): FirmwareDiagnostic {
  return { severity: "error", code, message, line, addressStart, addressEnd }
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(8, "0")
}
