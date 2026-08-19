import { describe, expect, test } from "bun:test"
import {
  workspaceFileHref,
  workspaceFileReference,
  workspaceFileReferenceFromHref,
} from "../src/workspace-file-links"

describe("workspace file links", () => {
  test("recognizes model-emitted workspace file references", () => {
    expect(workspaceFileReference("docs/R818_原理图设计与开发指南.md"))
      .toBe("docs/R818_原理图设计与开发指南.md")
    expect(workspaceFileReference(".eval/project.toml")).toBe(".eval/project.toml")
    expect(workspaceFileReference("README.md")).toBe("README.md")
    expect(workspaceFileReference("target_confirmed=true")).toBeNull()
    expect(workspaceFileReference("https://example.com/guide.md")).toBeNull()
    expect(workspaceFileReferenceFromHref("docs/My%20Guide.md")).toBe("docs/My Guide.md")
  })

  test("round-trips non-ASCII and Windows references through the private link scheme", () => {
    for (const reference of [
      "docs/R818_原理图设计与开发指南.md",
      "D:\\Projects\\board\\docs\\guide.md",
    ]) {
      expect(workspaceFileReferenceFromHref(workspaceFileHref(reference))).toBe(reference)
    }
  })
})
