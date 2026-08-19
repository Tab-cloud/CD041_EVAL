import { describe, expect, test } from "bun:test"
import { appendDownloadLog } from "../src/download-log"

describe("download log projection", () => {
  test("does not append the same polling failure repeatedly", () => {
    const first = appendDownloadLog([], "status unavailable")
    expect(appendDownloadLog(first, "status unavailable")).toBe(first)
  })

  test("retains distinct events within the bounded history", () => {
    expect(appendDownloadLog(["one", "two"], "three", 2)).toEqual(["two", "three"])
  })
})
