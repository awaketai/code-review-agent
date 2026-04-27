import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, realpath } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { existsSync } from "node:fs"
import type { ReviewTarget, ReviewContext } from "./types.ts"

const execFileAsync = promisify(execFile)

const MAX_FILES = 20
const FILE_SIZE_LIMIT = 50 * 1024 // 50KB

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Cargo.lock",
])

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".o",
  ".pyc",
  ".wasm",
])

function isFilteredFile(path: string): boolean {
  const basename = path.split("/").pop() ?? ""
  if (LOCKFILES.has(basename)) return true
  if (basename.endsWith(".min.js") || basename.endsWith(".min.css")) return true
  if (basename.endsWith(".map")) return true
  if (path.startsWith("dist/") || path.startsWith("build/") || path.startsWith("out/")) return true
  const ext = basename.includes(".") ? "." + basename.split(".").pop()! : ""
  if (BINARY_EXTENSIONS.has(ext)) return true
  return false
}

async function runGit(args: string[], workDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd: workDir,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  })
}

async function runGh(args: string[], workDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("gh", args, {
    cwd: workDir,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  })
}

class ReviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReviewError"
  }
}

function classifyGitError(stderr: string, context?: string): never {
  if (stderr.includes("not a git repository")) {
    throw new ReviewError("当前目录不是 git 仓库")
  }
  if (stderr.includes("bad revision") || stderr.includes("unknown revision")) {
    throw new ReviewError(`无效的 commit 引用：${context ?? ""}`)
  }
  if (stderr.includes("ambiguous argument")) {
    throw new ReviewError(`歧义的 git 引用：${context ?? ""}，请提供更精确的 commit hash`)
  }
  throw new ReviewError(`git 命令失败: ${stderr.trim()}`)
}

function classifyGhError(stderr: string, context?: string): never {
  if (stderr.includes("not found") || stderr.includes("404")) {
    throw new ReviewError(`PR #${context ?? ""} 不存在`)
  }
  if (stderr.includes("auth login")) {
    throw new ReviewError("GitHub CLI 未登录，请先运行 `gh auth login`")
  }
  if (stderr.includes("not a git repository") || stderr.includes("no git")) {
    throw new ReviewError("当前目录不是 GitHub 仓库")
  }
  if (stderr.includes("403") || stderr.includes("forbidden")) {
    throw new ReviewError("没有权限访问该 PR")
  }
  throw new ReviewError(`gh 命令失败: ${stderr.trim()}`)
}

async function getBranchName(workDir: string): Promise<string> {
  try {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workDir)
    return stdout.trim()
  } catch {
    return ""
  }
}

async function getDefaultBranch(workDir: string): Promise<string> {
  for (const branch of ["main", "master"]) {
    try {
      await runGit(["rev-parse", "--verify", branch], workDir)
      return branch
    } catch {
      continue
    }
  }
  throw new ReviewError("找不到默认分支（main 或 master）")
}

function extractChangedFiles(diffText: string): string[] {
  const files = new Set<string>()
  for (const line of diffText.split("\n")) {
    // Match "diff --git a/path b/path" lines
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (match) {
      files.add(match[2]!)
    }
    // Also match "+++ b/path" lines (fallback)
    const plusMatch = /^\+\+\+ b\/(.+)$/.exec(line)
    if (plusMatch) {
      files.add(plusMatch[1]!)
    }
  }
  return [...files].sort()
}

async function getUntrackedFiles(workDir: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(["status", "--porcelain"], workDir)
    const files: string[] = []
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("?? ")) {
        files.push(trimmed.slice(3))
      }
    }
    return files
  } catch {
    return []
  }
}

async function readFileWithTruncation(absolutePath: string): Promise<string> {
  const buffer = await readFile(absolutePath)
  if (buffer.byteLength <= FILE_SIZE_LIMIT) {
    return buffer.toString("utf-8")
  }

  // Truncate at the last newline before the limit
  let cutIndex = FILE_SIZE_LIMIT
  while (cutIndex > 0 && buffer[cutIndex] !== 0x0a) {
    cutIndex--
  }
  if (cutIndex === 0) cutIndex = FILE_SIZE_LIMIT
  return buffer.subarray(0, cutIndex).toString("utf-8") + "\n[truncated at 50KB]"
}

async function collectFileContents(
  changedFiles: string[],
  workDir: string,
): Promise<{ files: ReviewContext["files"]; omittedFiles: ReviewContext["omittedFiles"] }> {
  const files: ReviewContext["files"] = []
  const omittedFiles: ReviewContext["omittedFiles"] = []
  const resolvedWorkDir = await realpath(workDir)

  // Filter out lockfiles, binaries, generated files
  const eligible = changedFiles.filter((f) => !isFilteredFile(f))
  const filtered = changedFiles.filter((f) => isFilteredFile(f))

  for (const path of filtered) {
    omittedFiles.push({ path, reason: "filtered" })
  }

  // Take up to MAX_FILES from eligible
  const toRead = eligible.slice(0, MAX_FILES)
  const overBudget = eligible.slice(MAX_FILES)

  for (const path of overBudget) {
    omittedFiles.push({ path, reason: "budget" })
  }

  for (const path of toRead) {
    const absolute = resolve(workDir, path)
    if (!absolute.startsWith(resolve(workDir))) {
      omittedFiles.push({ path, reason: "read-error", detail: "Path traversal denied" })
      continue
    }
    try {
      const real = await realpath(absolute)
      if (!real.startsWith(resolvedWorkDir)) {
        omittedFiles.push({ path, reason: "read-error", detail: "Symlink escape denied" })
        continue
      }
      const content = await readFileWithTruncation(real)
      files.push({ path, content })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      omittedFiles.push({ path, reason: "read-error", detail: msg })
    }
  }

  return { files, omittedFiles }
}

async function collectConventions(
  changedFiles: string[],
  workDir: string,
): Promise<ReviewContext["conventions"]> {
  const candidates = new Set<string>()
  const resolvedWorkDir = await realpath(workDir)
  const resolvedWorkDirPrefix = resolvedWorkDir + "/"

  // Root-level convention files (relative paths)
  for (const name of ["AGENTS.md", "CONVENTIONS.md", ".editorconfig"]) {
    candidates.add(name)
  }

  // Per-changed-file: walk up from its directory looking for AGENTS.md / CONVENTIONS.md
  // Stop at workDir boundary — do not traverse above the repository root
  for (const filePath of changedFiles) {
    let dir = resolve(workDir, dirname(filePath))
    const workDirResolved = resolve(workDir)
    while (dir.startsWith(workDirResolved)) {
      for (const name of ["AGENTS.md", "CONVENTIONS.md"]) {
        const candidate = resolve(dir, name)
        if (existsSync(candidate)) {
          // Store as relative path for consistent dedup with root-level entries
          const rel = candidate.slice(workDirResolved.length + 1)
          candidates.add(rel)
        }
      }
      if (dir === workDirResolved) break
      dir = dirname(dir)
    }
  }

  const conventions: ReviewContext["conventions"] = []
  const sorted = [...candidates].sort()

  for (const relPath of sorted) {
    const absolute = resolve(workDir, relPath)
    try {
      const real = await realpath(absolute)
      if (!real.startsWith(resolvedWorkDirPrefix) && real !== resolvedWorkDir) continue
      const content = await readFile(real, "utf-8")
      conventions.push({ path: relPath, content })
    } catch {
      // Convention files are optional, skip if unreadable
    }
  }

  return conventions
}

// --- Target-specific collectors ---

async function collectWorkingTree(workDir: string): Promise<Partial<ReviewContext>> {
  const [diffResult, cachedResult, branch, untracked] = await Promise.all([
    runGit(["diff"], workDir),
    runGit(["diff", "--cached"], workDir),
    getBranchName(workDir),
    getUntrackedFiles(workDir),
  ])

  const diff = diffResult.stdout.trim()
  const cached = cachedResult.stdout.trim()

  if (!diff && !cached && untracked.length === 0) {
    throw new ReviewError("没有未提交的改动")
  }

  const allDiff = [diff, cached].filter(Boolean).join("\n")
  const changedFiles = [...new Set([...extractChangedFiles(allDiff), ...untracked])].sort()
  const statusShort = await runGit(["status", "--short"], workDir).then((r) => r.stdout.trim()).catch(() => "")

  return {
    diffs: [
      ...(diff ? [{ source: "git" as const, label: "Unstaged changes (git diff)", content: diff }] : []),
      ...(cached ? [{ source: "git" as const, label: "Staged changes (git diff --cached)", content: cached }] : []),
    ],
    changedFiles,
    summary: {
      ...(branch ? { branch } : {}),
      ...(statusShort ? { statusShort } : {}),
    },
  }
}

async function collectStaged(workDir: string): Promise<Partial<ReviewContext>> {
  const [{ stdout }, branch] = await Promise.all([
    runGit(["diff", "--cached"], workDir),
    getBranchName(workDir),
  ])
  const diff = stdout.trim()

  if (!diff) {
    throw new ReviewError("暂存区没有待审查的改动")
  }

  return {
    diffs: [{ source: "git", label: "Staged changes (git diff --cached)", content: diff }],
    changedFiles: extractChangedFiles(diff),
    summary: branch ? { branch } : {},
  }
}

async function collectCurrentBranch(workDir: string): Promise<Partial<ReviewContext>> {
  const branch = await getBranchName(workDir)

  if (branch === "main" || branch === "master") {
    // On default branch — review uncommitted changes
    const [diffResult, cachedResult, untracked] = await Promise.all([
      runGit(["diff"], workDir),
      runGit(["diff", "--cached"], workDir),
      getUntrackedFiles(workDir),
    ])

    const diff = diffResult.stdout.trim()
    const cached = cachedResult.stdout.trim()

    if (!diff && !cached && untracked.length === 0) {
      throw new ReviewError("当前分支没有待审查的改动")
    }

    const allDiff = [diff, cached].filter(Boolean).join("\n")
    const changedFiles = [...new Set([...extractChangedFiles(allDiff), ...untracked])].sort()
    const statusShort = await runGit(["status", "--short"], workDir).then((r) => r.stdout.trim()).catch(() => "")

    return {
      diffs: [
        ...(diff ? [{ source: "git" as const, label: "Unstaged changes", content: diff }] : []),
        ...(cached ? [{ source: "git" as const, label: "Staged changes", content: cached }] : []),
      ],
      changedFiles,
      summary: { branch, ...(statusShort ? { statusShort } : {}) },
    }
  }

  // Feature branch — diff against default base
  const base = await getDefaultBranch(workDir)
  const { stdout } = await runGit(["diff", `${base}...HEAD`], workDir)
  const diff = stdout.trim()

  if (!diff) {
    throw new ReviewError(`当前分支相对 ${base} 没有差异`)
  }

  const log = await runGit(["log", "--oneline", `${base}..HEAD`], workDir)
    .then((r) => r.stdout.trim())
    .catch(() => "")

  return {
    diffs: [{ source: "git", label: `Branch diff (${base}...HEAD)`, content: diff }],
    changedFiles: extractChangedFiles(diff),
    summary: { branch, baseBranch: base, ...(log ? { recentCommits: log } : {}) },
  }
}

async function collectCommit(hash: string, workDir: string): Promise<Partial<ReviewContext>> {
  let showResult: { stdout: string; stderr: string }
  try {
    showResult = await runGit(["show", hash], workDir)
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr: string }).stderr) : String(err)
    classifyGitError(stderr, hash)
  }

  const output = showResult.stdout.trim()
  if (!output) {
    throw new ReviewError(`指定 commit 没有可审查的代码差异：${hash}`)
  }

  // git show returns both metadata and diff — separate them
  const diffStart = output.indexOf("\ndiff --git")
  const commitMetadata = diffStart > 0 ? output.slice(0, diffStart).trim() : ""
  const diffContent = diffStart > 0 ? output.slice(diffStart + 1).trim() : output

  if (!diffContent.includes("diff --git")) {
    throw new ReviewError(`指定 commit 没有可审查的代码差异：${hash}`)
  }

  return {
    diffs: [{ source: "git", label: `Commit ${hash}`, content: diffContent }],
    changedFiles: extractChangedFiles(diffContent),
    summary: { commitMetadata },
  }
}

async function collectCommitRange(from: string, workDir: string): Promise<Partial<ReviewContext>> {
  let diffResult: { stdout: string; stderr: string }
  try {
    diffResult = await runGit(["diff", `${from}..HEAD`], workDir)
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr: string }).stderr) : String(err)
    classifyGitError(stderr, from)
  }

  const diff = diffResult.stdout.trim()
  if (!diff) {
    throw new ReviewError(`${from}..HEAD 之间没有代码差异`)
  }

  const log = await runGit(["log", "--oneline", `${from}..HEAD`], workDir)
    .then((r) => r.stdout.trim())
    .catch(() => "")

  return {
    diffs: [{ source: "git", label: `Commit range (${from}..HEAD)`, content: diff }],
    changedFiles: extractChangedFiles(diff),
    summary: log ? { recentCommits: log } : {},
  }
}

async function collectPullRequest(prNumber: number, workDir: string): Promise<Partial<ReviewContext>> {
  let viewResult: { stdout: string; stderr: string }
  let diffResult: { stdout: string; stderr: string }

  try {
    viewResult = await runGh(["pr", "view", String(prNumber)], workDir)
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr: string }).stderr) : String(err)
    classifyGhError(stderr, String(prNumber))
  }

  try {
    diffResult = await runGh(["pr", "diff", String(prNumber)], workDir)
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr: string }).stderr) : String(err)
    classifyGhError(stderr, String(prNumber))
  }

  const diff = diffResult.stdout.trim()
  if (!diff) {
    throw new ReviewError(`PR #${prNumber} 没有代码差异`)
  }

  return {
    diffs: [{ source: "gh", label: `PR #${prNumber} diff`, content: diff }],
    changedFiles: extractChangedFiles(diff),
    summary: { prMetadata: viewResult.stdout.trim() },
  }
}

async function collectFiles(paths: string[], workDir: string): Promise<Partial<ReviewContext>> {
  const diffs: ReviewContext["diffs"] = []

  for (const path of paths) {
    const [diffResult, cachedResult] = await Promise.all([
      runGit(["diff", "--", path], workDir).catch(() => ({ stdout: "", stderr: "" })),
      runGit(["diff", "--cached", "--", path], workDir).catch(() => ({ stdout: "", stderr: "" })),
    ])

    const diff = diffResult.stdout.trim()
    const cached = cachedResult.stdout.trim()
    if (diff) diffs.push({ source: "git", label: `Unstaged changes: ${path}`, content: diff })
    if (cached) diffs.push({ source: "git", label: `Staged changes: ${path}`, content: cached })
  }

  if (diffs.length === 0) {
    throw new ReviewError(`指定文件没有待审查的改动：${paths.join(", ")}`)
  }

  const allDiff = diffs.map((d) => d.content).join("\n")
  return {
    diffs,
    changedFiles: extractChangedFiles(allDiff),
  }
}

// --- Main entry point ---

export async function buildReviewContext(
  target: ReviewTarget,
  workDir: string,
): Promise<ReviewContext> {
  let partial: Partial<ReviewContext>

  switch (target.type) {
    case "working-tree":
      partial = await collectWorkingTree(workDir)
      break
    case "staged":
      partial = await collectStaged(workDir)
      break
    case "current-branch":
      partial = await collectCurrentBranch(workDir)
      break
    case "commit":
      partial = await collectCommit(target.commit, workDir)
      break
    case "commit-range":
      partial = await collectCommitRange(target.from, workDir)
      break
    case "pull-request":
      partial = await collectPullRequest(target.prNumber, workDir)
      break
    case "file":
      partial = await collectFiles(target.paths, workDir)
      break
  }

  const changedFiles = partial.changedFiles ?? []
  const [{ files, omittedFiles }, conventions] = await Promise.all([
    collectFileContents(changedFiles, workDir),
    collectConventions(changedFiles, workDir),
  ])

  return {
    target,
    summary: partial.summary ?? {},
    diffs: partial.diffs ?? [],
    changedFiles,
    files,
    omittedFiles,
    conventions,
  }
}

export { ReviewError }
