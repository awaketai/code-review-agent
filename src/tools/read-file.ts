import type { Tool } from "simple-agent"
import { readFile, realpath } from "node:fs/promises"
import { resolve } from "node:path"

export function createReadFileTool(workDir: string): Tool {
  return {
    name: "read_file",
    description:
      "Read the contents of a file at a given path relative to the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the working directory",
        },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const { path } = args as { path: string }
      const absolute = resolve(workDir, path)
      const resolvedWorkDir = await realpath(workDir)

      if (!absolute.startsWith(resolve(workDir))) {
        return { output: "", error: `Path traversal denied: ${path}` }
      }

      try {
        const real = await realpath(absolute)
        if (!real.startsWith(resolvedWorkDir)) {
          return { output: "", error: `Path traversal denied: ${path}` }
        }
        const content = await readFile(real, "utf-8")
        return { output: content }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: "", error: msg }
      }
    },
  }
}
