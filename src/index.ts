import "dotenv/config"
import { createSession, streamAgent } from "simple-agent"
import { createReadFileTool } from "./tools/read-file.ts"
import { createGitTool } from "./tools/git.ts"
import { createGhTool } from "./tools/gh.ts"
import { loadSystemPrompt } from "./prompt/system.ts"
import { defaultConfig } from "./config.ts"
import { parseReviewTarget } from "./review/parse-target.ts"
import { buildReviewContext, ReviewError } from "./review/build-context.ts"
import type { AppConfig } from "./config.ts"
import type { ReviewContext } from "./review/types.ts"
import type { Tool } from "simple-agent"

interface ReviewConfig extends AppConfig {
  workDir: string
}

function withLoopDetection(tool: Tool, preloadedFiles?: Map<string, string>): Tool {
  const resultCache = new Map<string, { output: string }>()
  const originalExecute = tool.execute
  return {
    ...tool,
    execute: async (args) => {
      const key = `${tool.name}:${JSON.stringify(args)}`

      // Return cached result for any duplicate call (any tool)
      const cached = resultCache.get(key)
      if (cached) return cached

      // For read_file, intercept calls to pre-loaded files (skip disk I/O)
      if (tool.name === "read_file" && preloadedFiles) {
        const path = (args as { path: string }).path
        const preloaded = preloadedFiles.get(path)
        if (preloaded !== undefined) {
          const result = { output: preloaded }
          resultCache.set(key, result)
          return result
        }
      }

      const result = await originalExecute(args)
      resultCache.set(key, result)
      return result
    },
  }
}

function formatReviewContext(ctx: ReviewContext): string {
  const sections: string[] = []

  sections.push("[Review Target]")
  sections.push(ctx.target.type)

  if (Object.keys(ctx.summary).length > 0) {
    sections.push("\n[Repository Summary]")
    if (ctx.summary.branch) sections.push(`Current branch: ${ctx.summary.branch}`)
    if (ctx.summary.baseBranch) sections.push(`Base branch: ${ctx.summary.baseBranch}`)
    if (ctx.summary.recentCommits) sections.push(`Recent commits:\n${ctx.summary.recentCommits}`)
    if (ctx.summary.statusShort) sections.push(`Uncommitted changes:\n${ctx.summary.statusShort}`)
    if (ctx.summary.prMetadata) sections.push(`PR metadata:\n${ctx.summary.prMetadata}`)
    if (ctx.summary.commitMetadata) sections.push(`Commit metadata:\n${ctx.summary.commitMetadata}`)
  }

  if (ctx.changedFiles.length > 0) {
    sections.push("\n[Changed Files]")
    for (const f of ctx.changedFiles) {
      sections.push(`- ${f}`)
    }
  }

  for (const diff of ctx.diffs) {
    sections.push(`\n[Diff: ${diff.label}]`)
    sections.push(diff.content)
  }

  if (ctx.files.length > 0) {
    sections.push("\n[Pre-loaded Files — full content provided below, do NOT read_file these]")
    for (const f of ctx.files) {
      sections.push(`- ${f.path}`)
    }
  }

  for (const file of ctx.files) {
    sections.push(`\n[File: ${file.path}]`)
    sections.push(file.content)
  }

  if (ctx.omittedFiles.length > 0) {
    sections.push("\n[Omitted Files]")
    for (const f of ctx.omittedFiles) {
      const detail = f.detail ? ` (${f.detail})` : ""
      sections.push(`- ${f.path}: ${f.reason}${detail}`)
    }
  }

  for (const conv of ctx.conventions) {
    sections.push(`\n[Conventions: ${conv.path}]`)
    sections.push(conv.content)
  }

  return sections.join("\n")
}

export async function runCodeReview(input: string, config: ReviewConfig) {
  const workDir = config.workDir
  const systemPrompt = await loadSystemPrompt()

  // Step 1: Parse user input to ReviewTarget
  process.stderr.write("[parse] Parsing review target...\n")
  const parseConfig: { model: string; apiKey?: string; baseURL?: string } = { model: config.model }
  if (config.apiKey) parseConfig.apiKey = config.apiKey
  if (config.baseURL) parseConfig.baseURL = config.baseURL
  const target = await parseReviewTarget(input, parseConfig)
  process.stderr.write(`[parse] Target: ${target.type}\n`)

  // Step 2: Build ReviewContext deterministically
  process.stderr.write("[collect] Gathering diff and context...\n")
  const context = await buildReviewContext(target, workDir)
  process.stderr.write(
    `[collect] ${context.diffs.length} diff(s), ${context.changedFiles.length} changed files, ${context.files.length} file contents loaded\n`,
  )

  // Step 3: Agent loop — LLM reviews with pre-assembled context
  const preloadedFiles = new Map<string, string>()
  for (const f of context.files) {
    preloadedFiles.set(f.path, f.content)
  }

  const tools = [
    createReadFileTool(workDir),
    createGitTool(workDir),
    createGhTool(workDir),
  ].map((tool) => withLoopDetection(tool, preloadedFiles))

  const agentConfig = {
    model: config.model,
    systemPrompt,
    tools,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxSteps: config.maxSteps,
  }

  const session = createSession(agentConfig)

  session.messages.push({
    id: `user-${Date.now()}`,
    role: "user",
    content: [{ type: "text", text: `[User Request]\n${input}\n\n${formatReviewContext(context)}` }],
    createdAt: new Date(),
  })

  for await (const event of streamAgent(session, agentConfig)) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text)
        break
      case "tool_call":
        process.stderr.write(`\n[tool] ${event.name}(${JSON.stringify(event.args)})\n`)
        break
      case "tool_result": {
        const result = event.result.length > 200
          ? `${event.result.slice(0, 200)}...`
          : event.result
        process.stderr.write(`[result] ${event.name}: ${result}\n`)
        break
      }
      case "error":
        console.error(`Error: ${event.error.message}`)
        break
    }
  }

  return session
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`code-review-agent — LLM-driven code review

Usage:
  code-review-agent <review-target>

Examples:
  code-review-agent "review current branch"
  code-review-agent "review commit abc1234 之后的代码"
  code-review-agent "review pull request 42"
  code-review-agent "review src/index.ts"
  code-review-agent "review staged changes"
  code-review-agent "review"

Environment:
  OPENAI_API_KEY   Required. API key for the LLM provider.
  OPENAI_BASE_URL  Optional. Custom base URL for the LLM provider.
  REVIEW_MODEL     Optional. Model name (default: claude-sonnet-4-6).
  REVIEW_MAX_STEPS Optional. Max agent steps (default: 20).`)
    process.exit(0)
  }

  const input = args.join(" ")
  const config: ReviewConfig = {
    workDir: process.cwd(),
    model: process.env["REVIEW_MODEL"] ?? defaultConfig.model,
    maxSteps: parseInt(process.env["REVIEW_MAX_STEPS"] ?? String(defaultConfig.maxSteps), 10),
    apiKey: process.env["OPENAI_API_KEY"],
    baseURL: process.env["OPENAI_BASE_URL"],
  }

  try {
    await runCodeReview(input, config)
  } catch (err) {
    if (err instanceof ReviewError) {
      console.error(err.message)
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Fatal: ${msg}`)
    }
    process.exit(1)
  }
}

main()
