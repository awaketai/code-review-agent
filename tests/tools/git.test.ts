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
    expect(result.output).not.toContain("[ERROR]")
  })

  it("runs git diff with no changes (empty stdout)", async () => {
    const result = await tool.execute({ command: "diff" })
    expect(result.output).toBe("")
  })

  it("runs git diff with changes", async () => {
    await writeFile(join(workDir, "file.txt"), "modified")
    const result = await tool.execute({ command: "diff" })
    expect(result.output).toContain("modified")
  })

  it("blocks git push", async () => {
    const result = await tool.execute({ command: "push origin main" })
    expect(result.output).toContain("Blocked")
    expect(result.output).toContain("push")
  })

  it("blocks git commit", async () => {
    const result = await tool.execute({ command: "commit -m 'test'" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks git reset", async () => {
    const result = await tool.execute({ command: "reset --hard HEAD" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks git checkout", async () => {
    const result = await tool.execute({ command: "checkout -b new-branch" })
    expect(result.output).toContain("Blocked")
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
    expect(result.output).toContain("[ERROR]")
  })

  it("rejects shell pipe", async () => {
    const result = await tool.execute({ command: "log --oneline | head -5" })
    expect(result.output).toContain("Shell metacharacters")
  })

  it("rejects shell redirect", async () => {
    const result = await tool.execute({ command: "diff > out.txt" })
    expect(result.output).toContain("Shell metacharacters")
  })

  it("rejects unknown subcommand", async () => {
    const result = await tool.execute({ command: "foo bar" })
    expect(result.output).toContain("Blocked")
    expect(result.output).toContain("foo")
  })

  it("blocks git add (mutating)", async () => {
    const result = await tool.execute({ command: "add ." })
    expect(result.output).toContain("Blocked")
  })

  it("blocks git apply (mutating)", async () => {
    const result = await tool.execute({ command: "apply patch.diff" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks git cherry-pick (mutating)", async () => {
    const result = await tool.execute({ command: "cherry-pick abc1234" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks git revert (mutating)", async () => {
    const result = await tool.execute({ command: "revert HEAD" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks git fetch (network)", async () => {
    const result = await tool.execute({ command: "fetch origin" })
    expect(result.output).toContain("Blocked")
  })

  it("allows git status", async () => {
    const result = await tool.execute({ command: "status --short" })
    expect(result.output).not.toContain("[ERROR]")
  })

  it("allows git rev-parse", async () => {
    const result = await tool.execute({ command: "rev-parse HEAD" })
    expect(result.output).toBeTruthy()
    expect(result.output).not.toContain("[ERROR]")
  })

  it("allows git grep", async () => {
    const result = await tool.execute({ command: "grep initial" })
    expect(result.output).toContain("initial")
    expect(result.output).not.toContain("[ERROR]")
  })
})
