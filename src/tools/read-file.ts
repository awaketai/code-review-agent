import type { Tool } from "simple-agent"
import { readFile, realpath } from "node:fs/promises"
import { resolve } from "node:path"

const FILE_SIZE_LIMIT = 50 * 1024 // 50KB

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
        return { output: `[ERROR] Path traversal denied: ${path}` }
      }

      try {
        const real = await realpath(absolute)
        if (!real.startsWith(resolvedWorkDir)) {
          return { output: `[ERROR] Path traversal denied: ${path}` }
        }

        const buffer = await readFile(real)
        if (buffer.byteLength <= FILE_SIZE_LIMIT) {
          return { output: buffer.toString("utf-8") }
        }

        // Truncate at the last newline before the limit
        let cutIndex = FILE_SIZE_LIMIT
        while (cutIndex > 0 && buffer[cutIndex] !== 0x0a) {
          cutIndex--
        }
        if (cutIndex === 0) cutIndex = FILE_SIZE_LIMIT
        return { output: buffer.subarray(0, cutIndex).toString("utf-8") + "\n[truncated at 50KB]" }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `[ERROR] ${msg}` }
      }
    },
  }
}
