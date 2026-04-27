import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { buildReviewContext, ReviewError } from "../../src/review/build-context.ts"
import type { ReviewTarget } from "../../src/review/types.ts"

const exec = promisify(execFile)

async function initGitRepo(workDir: string) {
  await exec("git", ["init", "--initial-branch=main"], { cwd: workDir })
  await exec("git", ["config", "user.email", "test@test.com"], { cwd: workDir })
  await exec("git", ["config", "user.name", "Test"], { cwd: workDir })
}

describe("buildReviewContext", () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "build-ctx-test-"))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  describe("working-tree target", () => {
    it("collects unstaged changes", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await writeFile(join(workDir, "file.txt"), "modified")

      const ctx = await buildReviewContext({ type: "working-tree" }, workDir)
      expect(ctx.diffs.length).toBeGreaterThanOrEqual(1)
      expect(ctx.diffs[0]?.content).toContain("modified")
      expect(ctx.changedFiles).toContain("file.txt")
    })

    it("throws when no uncommitted changes", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })

      await expect(
        buildReviewContext({ type: "working-tree" }, workDir),
      ).rejects.toThrow("没有未提交的改动")
    })
  })

  describe("staged target", () => {
    it("collects staged changes", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await writeFile(join(workDir, "file.txt"), "modified")
      await exec("git", ["add", "file.txt"], { cwd: workDir })

      const ctx = await buildReviewContext({ type: "staged" }, workDir)
      expect(ctx.diffs.length).toBe(1)
      expect(ctx.diffs[0]?.content).toContain("modified")
    })

    it("throws when nothing staged", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await writeFile(join(workDir, "file.txt"), "modified")
      // Not staged — only unstaged

      await expect(
        buildReviewContext({ type: "staged" }, workDir),
      ).rejects.toThrow("暂存区没有待审查的改动")
    })
  })

  describe("current-branch target (feature branch)", () => {
    it("collects diff against main", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await exec("git", ["checkout", "-b", "feature/test"], { cwd: workDir })
      await writeFile(join(workDir, "new-file.txt"), "new content")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "add new file"], { cwd: workDir })

      const ctx = await buildReviewContext({ type: "current-branch" }, workDir)
      expect(ctx.diffs.length).toBe(1)
      expect(ctx.diffs[0]?.content).toContain("new content")
      expect(ctx.changedFiles).toContain("new-file.txt")
      expect(ctx.summary.baseBranch).toBe("main")
    })

    it("throws when branch has no diff against main", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await exec("git", ["checkout", "-b", "feature/empty"], { cwd: workDir })

      await expect(
        buildReviewContext({ type: "current-branch" }, workDir),
      ).rejects.toThrow("没有差异")
    })
  })

  describe("commit target", () => {
    it("collects commit diff", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await writeFile(join(workDir, "file.txt"), "modified")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "update"], { cwd: workDir })
      const { stdout: hash } = await exec("git", ["rev-parse", "HEAD"], { cwd: workDir })

      const ctx = await buildReviewContext({ type: "commit", commit: hash.trim() }, workDir)
      expect(ctx.diffs.length).toBe(1)
      expect(ctx.diffs[0]?.content).toContain("modified")
      expect(ctx.summary.commitMetadata).toBeDefined()
    })

    it("throws for invalid commit hash", async () => {
      await initGitRepo(workDir)

      await expect(
        buildReviewContext({ type: "commit", commit: "nonexistent1234" }, workDir),
      ).rejects.toThrow()
    })
  })

  describe("file target", () => {
    it("collects file diff", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await writeFile(join(workDir, "file.txt"), "modified")

      const ctx = await buildReviewContext(
        { type: "file", paths: ["file.txt"] },
        workDir,
      )
      expect(ctx.diffs.length).toBeGreaterThanOrEqual(1)
      expect(ctx.diffs.some((d) => d.content.includes("modified"))).toBe(true)
    })

    it("throws when file has no changes", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })

      await expect(
        buildReviewContext({ type: "file", paths: ["file.txt"] }, workDir),
      ).rejects.toThrow("指定文件没有待审查的改动")
    })
  })

  describe("file content collection", () => {
    it("reads changed file contents", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await writeFile(join(workDir, "file.txt"), "modified")

      const ctx = await buildReviewContext({ type: "working-tree" }, workDir)
      expect(ctx.files.length).toBe(1)
      expect(ctx.files[0]?.path).toBe("file.txt")
      expect(ctx.files[0]?.content).toContain("modified")
    })

    it("filters lockfiles", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "file.txt"), "initial")
      await writeFile(join(workDir, "pnpm-lock.yaml"), "lockfile content")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await writeFile(join(workDir, "file.txt"), "modified")
      await writeFile(join(workDir, "pnpm-lock.yaml"), "updated lockfile")

      const ctx = await buildReviewContext({ type: "working-tree" }, workDir)
      // lockfile should be in omittedFiles, not in files
      expect(ctx.files.some((f) => f.path === "pnpm-lock.yaml")).toBe(false)
      expect(ctx.omittedFiles.some((f) => f.path === "pnpm-lock.yaml" && f.reason === "filtered")).toBe(true)
    })

    it("collects convention files", async () => {
      await initGitRepo(workDir)
      await writeFile(join(workDir, "AGENTS.md"), "# Conventions\nUse TypeScript strict mode")
      await writeFile(join(workDir, "file.txt"), "initial")
      await exec("git", ["add", "."], { cwd: workDir })
      await exec("git", ["commit", "-m", "init"], { cwd: workDir })
      await writeFile(join(workDir, "file.txt"), "modified")

      const ctx = await buildReviewContext({ type: "working-tree" }, workDir)
      expect(ctx.conventions.length).toBeGreaterThanOrEqual(1)
      expect(ctx.conventions.some((c) => c.path === "AGENTS.md")).toBe(true)
    })
  })
})
