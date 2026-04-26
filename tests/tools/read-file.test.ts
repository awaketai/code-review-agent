import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReadFileTool } from "../../src/tools/read-file.ts"

describe("read_file tool", () => {
  let workDir: string
  let tool: ReturnType<typeof createReadFileTool>

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "read-file-test-"))
    tool = createReadFileTool(workDir)
    await writeFile(join(workDir, "hello.txt"), "hello world")
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it("reads a file successfully", async () => {
    const result = await tool.execute({ path: "hello.txt" })
    expect(result.output).toBe("hello world")
    expect(result.error).toBeUndefined()
  })

  it("returns error for missing file", async () => {
    const result = await tool.execute({ path: "nonexistent.txt" })
    expect(result.error).toBeDefined()
    expect(result.output).toBe("")
  })

  it("blocks path traversal with ../", async () => {
    const result = await tool.execute({ path: "../../../etc/passwd" })
    expect(result.error).toContain("Path traversal denied")
  })

  it("reads file in subdirectory", async () => {
    await mkdir(join(workDir, "sub"))
    await writeFile(join(workDir, "sub", "nested.txt"), "nested content")
    const result = await tool.execute({ path: "sub/nested.txt" })
    expect(result.output).toBe("nested content")
  })

  it("blocks symlink pointing outside workDir", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"))
    await writeFile(join(outsideDir, "secret.txt"), "secret")
    await symlink(join(outsideDir, "secret.txt"), join(workDir, "link.txt"))

    const result = await tool.execute({ path: "link.txt" })
    expect(result.error).toContain("Path traversal denied")

    await rm(outsideDir, { recursive: true, force: true })
  })
})
