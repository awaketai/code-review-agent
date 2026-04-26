import type { Tool } from "simple-agent"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parseCommand } from "./parse-command.ts"

const execFileAsync = promisify(execFile)

const ALLOWED_TOP_LEVEL = ["pr", "issue", "api", "repo"]

const ALLOWED_PR_SUB = ["view", "diff", "checks", "list", "status"]

const ALLOWED_ISSUE_SUB = ["view", "list", "status"]

function hasWriteMethod(parts: string[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    const arg = parts[i]
    if (arg === "-X" || arg === "--method") {
      const method = parts[i + 1]?.toUpperCase()
      if (method && method !== "GET") return true
    }
  }
  return false
}

export function createGhTool(workDir: string): Tool {
  return {
    name: "gh",
    description:
      "Run a GitHub CLI (gh) subcommand. Examples: 'pr view 42', 'pr diff 42', 'pr diff 42 --name-only', 'pr checks 42', 'issue view 123', 'api repos/{owner}/{repo}/pulls/42/comments'. Do not include the leading 'gh'.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The gh subcommand and arguments, e.g. 'pr view 42' or 'pr diff 42'",
        },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const { command } = args as { command: string }
      const parts = parseCommand(command)

      const topLevel = parts[0] ?? ""
      if (!ALLOWED_TOP_LEVEL.includes(topLevel)) {
        return {
          output: "",
          error: `Blocked: 'gh ${topLevel}' is not allowed in review mode`,
        }
      }

      if (topLevel === "pr") {
        const prSub = parts[1] ?? ""
        if (!ALLOWED_PR_SUB.includes(prSub)) {
          return {
            output: "",
            error: `Blocked: 'gh pr ${prSub}' is not allowed in review mode. Allowed: ${ALLOWED_PR_SUB.join(", ")}`,
          }
        }
      }

      if (topLevel === "issue") {
        const issueSub = parts[1] ?? ""
        if (!ALLOWED_ISSUE_SUB.includes(issueSub)) {
          return {
            output: "",
            error: `Blocked: 'gh issue ${issueSub}' is not allowed in review mode. Allowed: ${ALLOWED_ISSUE_SUB.join(", ")}`,
          }
        }
      }

      if (topLevel === "api" && hasWriteMethod(parts)) {
        return {
          output: "",
          error: "Blocked: 'gh api' with non-GET method is not allowed in review mode",
        }
      }

      try {
        const { stdout, stderr } = await execFileAsync("gh", parts, {
          cwd: workDir,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
        })
        const output = stdout !== "" ? stdout : stderr
        return { output: output.trimEnd() }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: "", error: msg }
      }
    },
  }
}
