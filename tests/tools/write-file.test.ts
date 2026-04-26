import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, rm, symlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWriteFileTool } from "../../src/tools/write-file.ts"

describe("write_file tool", () => {
  let workDir: string
  let tool: ReturnType<typeof createWriteFileTool>

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "write-file-test-"))
    tool = createWriteFileTool(workDir)
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it("writes a file successfully", async () => {
    const result = await tool.execute({ path: "output.txt", content: "review result" })
    expect(result.output).toBe("Written to output.txt")
    expect(result.error).toBeUndefined()

    const content = await readFile(join(workDir, "output.txt"), "utf-8")
    expect(content).toBe("review result")
  })

  it("auto-creates parent directories", async () => {
    const result = await tool.execute({ path: "deep/nested/dir/file.md", content: "deep" })
    expect(result.output).toBe("Written to deep/nested/dir/file.md")

    const content = await readFile(join(workDir, "deep/nested/dir/file.md"), "utf-8")
    expect(content).toBe("deep")
  })

  it("blocks path traversal with ../", async () => {
    const result = await tool.execute({ path: "../../../tmp/evil.txt", content: "evil" })
    expect(result.error).toContain("Path traversal denied")
  })

  it("blocks symlinked parent directory pointing outside workDir", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-write-"))
    await symlink(outsideDir, join(workDir, "escape"))

    const result = await tool.execute({ path: "escape/secret.txt", content: "exploit" })
    expect(result.error).toContain("Path traversal denied")

    await rm(outsideDir, { recursive: true, force: true })
  })

  it("overwrites existing file", async () => {
    await tool.execute({ path: "file.txt", content: "v1" })
    await tool.execute({ path: "file.txt", content: "v2" })
    const content = await readFile(join(workDir, "file.txt"), "utf-8")
    expect(content).toBe("v2")
  })
})
