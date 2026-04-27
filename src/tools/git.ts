import type { Tool } from "simple-agent"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parseCommand, assertNoShellChars } from "./parse-command.ts"

const execFileAsync = promisify(execFile)

const ALLOWED_SUBCOMMANDS = new Set([
  "blame",
  "config",
  "describe",
  "diff",
  "for-each-ref",
  "grep",
  "help",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "name-rev",
  "range-diff",
  "reflog",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-branch",
  "show-ref",
  "status",
  "var",
  "verify-commit",
  "verify-tag",
  "version",
  "whatchanged",
])

export function createGitTool(workDir: string): Tool {
  return {
    name: "git",
    description:
      "Run a read-only git subcommand. Only read-only commands are allowed (diff, log, show, blame, status, grep, etc.). Examples: 'diff', 'diff --cached', 'log --oneline -20', 'show abc1234', 'blame src/file.ts', 'diff main...HEAD'. Do not include the leading 'git'.",
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

      try {
        assertNoShellChars(command)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { output: `[ERROR] ${errMsg}` }
      }

      const parts = parseCommand(command)

      const subcommand = parts[0] ?? ""
      if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
        return {
          output: `[ERROR] Blocked: 'git ${subcommand}' is not allowed in review mode. Allowed read-only commands: ${[...ALLOWED_SUBCOMMANDS].join(", ")}`,
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
        return { output: `[ERROR] ${msg}` }
      }
    },
  }
}
