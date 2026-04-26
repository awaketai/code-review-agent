import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createGitTool } from "../../src/tools/git.ts"

const exec = promisify(execFile)

describe("git tool", () => {
  let workDir: string
  let tool: ReturnType<typeof createGitTool>

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "git-test-"))
    await exec("git", ["init"], { cwd: workDir })
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: workDir })
    await exec("git", ["config", "user.name", "Test"], { cwd: workDir })
    await writeFile(join(workDir, "file.txt"), "initial")
    await exec("git", ["add", "."], { cwd: workDir })
    await exec("git", ["commit", "-m", "init"], { cwd: workDir })
    tool = createGitTool(workDir)
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it("runs git log", async () => {
    const result = await tool.execute({ command: "log --oneline" })
    expect(result.output).toContain("init")
    expect(result.error).toBeUndefined()
  })

  it("runs git diff with no changes (empty stdout)", async () => {
    const result = await tool.execute({ command: "diff" })
    expect(result.output).toBe("")
    expect(result.error).toBeUndefined()
  })

  it("runs git diff with changes", async () => {
    await writeFile(join(workDir, "file.txt"), "modified")
    const result = await tool.execute({ command: "diff" })
    expect(result.output).toContain("modified")
  })

  it("blocks git push", async () => {
    const result = await tool.execute({ command: "push origin main" })
    expect(result.error).toContain("Blocked")
    expect(result.error).toContain("push")
  })

  it("blocks git commit", async () => {
    const result = await tool.execute({ command: "commit -m 'test'" })
    expect(result.error).toContain("Blocked")
  })

  it("blocks git reset", async () => {
    const result = await tool.execute({ command: "reset --hard HEAD" })
    expect(result.error).toContain("Blocked")
  })

  it("blocks git checkout", async () => {
    const result = await tool.execute({ command: "checkout -b new-branch" })
    expect(result.error).toContain("Blocked")
  })

  it("allows git blame", async () => {
    const result = await tool.execute({ command: "blame file.txt" })
    expect(result.output).toContain("initial")
  })

  it("allows git show", async () => {
    const result = await tool.execute({ command: "show HEAD" })
    expect(result.output).toContain("init")
  })

  it("returns error for invalid command", async () => {
    const result = await tool.execute({ command: "log --invalid-flag-xyz" })
    expect(result.error).toBeDefined()
  })
})
