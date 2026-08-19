import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  analyzeFirmwareArtifact,
  parseIntelHex,
  type FirmwareDiagnosticCode,
} from "../src/tool/hardware/firmware-artifact"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("parseIntelHex", () => {
  test("parses, relocates and merges data records while counting programmed bytes", () => {
    const source = [
      record(0x04, 0, [0x08, 0x00]),
      record(0x00, 0x0010, [1, 2, 3, 4]),
      record(0x00, 0x0014, [5, 6]),
      record(0x00, 0x0020, [7]),
      record(0x05, 0, [0x08, 0x00, 0x00, 0x11]),
      record(0x01, 0, []),
    ].join("\n")

    const result = parseIntelHex(source)

    expect(result.valid).toBe(true)
    expect(result.programmedBytes).toBe(7)
    expect(result.addressStart).toBe(0x0800_0010)
    expect(result.addressEnd).toBe(0x0800_0020)
    expect(result.entryAddress).toBe(0x0800_0011)
    expect(result.segments).toEqual([
      { addressStart: 0x0800_0010, addressEnd: 0x0800_0015, byteLength: 6 },
      { addressStart: 0x0800_0020, addressEnd: 0x0800_0020, byteLength: 1 },
    ])
  })

  test("supports segment addressing and start segment addresses", () => {
    const result = parseIntelHex([
      record(0x02, 0, [0x12, 0x34]),
      record(0x00, 0x0010, [0xaa, 0xbb]),
      record(0x03, 0, [0x12, 0x34, 0x00, 0x10]),
      record(0x01, 0, []),
    ].join("\n"))

    expect(result.valid).toBe(true)
    expect(result.addressStart).toBe(0x12350)
    expect(result.addressEnd).toBe(0x12351)
    expect(result.entryAddress).toBe(0x12350)
  })

  test("rejects malformed records, invalid checksums, missing EOF and records after EOF", () => {
    const badChecksum = record(0x00, 0, [1, 2]).slice(0, -2) + "00"
    const result = parseIntelHex([
      ":not-hex",
      badChecksum,
      record(0x01, 0, []),
      record(0x00, 0, [3]),
      record(0x01, 0, []),
    ].join("\n"))

    expect(result.valid).toBe(false)
    expect(codes(result.diagnostics)).toEqual([
      "invalid_record",
      "invalid_checksum",
      "record_after_eof",
      "record_after_eof",
      "duplicate_eof",
    ])
    expect(codes(parseIntelHex(record(0x00, 0, [1])).diagnostics)).toContain("missing_eof")
  })

  test("validates payload shapes for non-data record types", () => {
    const result = parseIntelHex([
      record(0x02, 1, [0, 1]),
      record(0x03, 0, [0, 1]),
      record(0x04, 0, [1]),
      record(0x05, 1, [0, 0, 0, 1]),
      record(0x01, 1, []),
    ].join("\n"))

    expect(result.valid).toBe(false)
    expect(codes(result.diagnostics).filter((code) => code === "invalid_record_payload")).toHaveLength(5)
    expect(codes(result.diagnostics)).toContain("missing_eof")
  })

  test("diagnoses overlap and counts unique programmed addresses", () => {
    const result = parseIntelHex([
      record(0x00, 0x1000, [1, 2, 3, 4]),
      record(0x00, 0x1002, [9, 9, 9, 9]),
      record(0x01, 0, []),
    ].join("\n"))

    expect(result.valid).toBe(false)
    expect(result.programmedBytes).toBe(6)
    expect(result.segments).toEqual([{ addressStart: 0x1000, addressEnd: 0x1005, byteLength: 6 }])
    expect(result.diagnostics.find((item) => item.code === "overlapping_data")).toMatchObject({
      line: 2,
      addressStart: 0x1002,
      addressEnd: 0x1003,
    })
  })

  test("diagnoses each portion outside caller-supplied writable ranges", () => {
    const result = parseIntelHex([
      record(0x00, 0x000e, [1, 2, 3, 4, 5, 6, 7, 8]),
      record(0x01, 0, []),
    ].join("\n"), {
      allowedAddressRanges: [{ start: 0x10, end: 0x14 }],
    })

    expect(result.valid).toBe(false)
    expect(result.diagnostics.filter((item) => item.code === "address_out_of_range")).toEqual([
      expect.objectContaining({ addressStart: 0x0e, addressEnd: 0x0f }),
      expect.objectContaining({ addressStart: 0x14, addressEnd: 0x15 }),
    ])
  })

  test("detects a data record that overflows the 32-bit address space", () => {
    const result = parseIntelHex([
      record(0x04, 0, [0xff, 0xff]),
      record(0x00, 0xffff, [1, 2]),
      record(0x01, 0, []),
    ].join("\n"))

    expect(result.valid).toBe(false)
    expect(codes(result.diagnostics)).toContain("address_overflow")
    expect(result.programmedBytes).toBe(0)
  })

  test("reports conflicting type 03 and type 05 entry points", () => {
    const result = parseIntelHex([
      record(0x03, 0, [0, 1, 0, 0]),
      record(0x05, 0, [0, 0, 0, 0x20]),
      record(0x01, 0, []),
    ].join("\n"))
    expect(codes(result.diagnostics)).toContain("conflicting_entry_point")
    expect(result.entryAddress).toBe(0x10)
  })
})

describe("analyzeFirmwareArtifact", () => {
  test("adds path, exact disk size and SHA-256 to parsed metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eval-firmware-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "firmware.hex")
    const source = `${record(0x00, 0x20, [0xde, 0xad])}\r\n${record(0x01, 0, [])}\r\n`
    writeFileSync(path, source)

    const artifact = await analyzeFirmwareArtifact(path)

    expect(artifact.format).toBe("hex")
    expect(artifact.path).toBe(path)
    expect(artifact.fileBytes).toBe(Buffer.byteLength(source))
    expect(artifact.sha256).toBe(createHash("sha256").update(source).digest("hex"))
    expect(artifact.programmedBytes).toBe(2)
    expect(artifact.valid).toBe(true)
  })
})

function codes(diagnostics: Array<{ code: FirmwareDiagnosticCode }>): FirmwareDiagnosticCode[] {
  return diagnostics.map((item) => item.code)
}

function record(type: number, address: number, data: number[]): string {
  const bytes = [
    data.length,
    (address >>> 8) & 0xff,
    address & 0xff,
    type,
    ...data,
  ]
  const checksum = (-bytes.reduce((sum, value) => sum + value, 0)) & 0xff
  return `:${[...bytes, checksum].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`
}
