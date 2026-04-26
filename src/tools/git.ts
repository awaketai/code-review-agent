import type { Tool } from "simple-agent"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parseCommand } from "./parse-command.ts"

const execFileAsync = promisify(execFile)

const BLOCKED_SUBCOMMANDS = [
  "push",
  "reset",
  "rebase",
  "merge",
  "commit",
  "checkout",
  "switch",
  "branch",
  "tag",
  "stash",
  "clean",
  "rm",
]

export function createGitTool(workDir: string): Tool {
  return {
    name: "git",
    description:
      "Run a git subcommand. Examples: 'diff', 'diff --cached', 'log --oneline -20', 'show abc1234', 'blame src/file.ts', 'diff main...HEAD'. Do not include the leading 'git'.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The git subcommand and arguments, e.g. 'diff main...HEAD' or 'log --oneline abc1234..HEAD'",
        },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const { command } = args as { command: string }
      const parts = parseCommand(command)

      const subcommand = parts[0] ?? ""
      if (BLOCKED_SUBCOMMANDS.includes(subcommand)) {
        return {
          output: "",
          error: `Blocked: 'git ${subcommand}' is not allowed in review mode`,
        }
      }

      try {
        const { stdout, stderr } = await execFileAsync("git", parts, {
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
