import { createSession, streamAgent } from "simple-agent"
import { createReadFileTool } from "./tools/read-file.ts"
import { createWriteFileTool } from "./tools/write-file.ts"
import { createGitTool } from "./tools/git.ts"
import { createGhTool } from "./tools/gh.ts"
import { loadSystemPrompt } from "./prompt/system.ts"
import { defaultConfig } from "./config.ts"
import type { AppConfig } from "./config.ts"

interface ReviewConfig extends AppConfig {
  workDir: string
}

export async function runCodeReview(input: string, config: ReviewConfig) {
  const workDir = config.workDir
  const systemPrompt = await loadSystemPrompt()

  const tools = [
    createReadFileTool(workDir),
    createWriteFileTool(workDir),
    createGitTool(workDir),
    createGhTool(workDir),
  ]

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
    content: [{ type: "text", text: input }],
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
      case "tool_result":
        if (event.result.length > 200) {
          process.stderr.write(`[result] ${event.name}: ${event.result.slice(0, 200)}...\n`)
        } else {
          process.stderr.write(`[result] ${event.name}: ${event.result}\n`)
        }
        break
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

Environment:
  OPENAI_API_KEY   Required. API key for the LLM provider.
  OPENAI_BASE_URL  Optional. Custom base URL for the LLM provider.
  REVIEW_MODEL     Optional. Model name (default: claude-sonnet-4-6).
  REVIEW_MAX_STEPS Optional. Max agent steps (default: 50).`)
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
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Fatal: ${msg}`)
    process.exit(1)
  }
}

main()
