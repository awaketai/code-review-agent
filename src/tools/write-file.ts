import type { Tool } from "simple-agent"
import { writeFile, mkdir, realpath } from "node:fs/promises"
import { resolve, dirname } from "node:path"

export function createWriteFileTool(workDir: string): Tool {
  return {
    name: "write_file",
    description:
      "Write content to a file. Use only for producing review output (reports, summaries). Never use to modify source code.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the working directory",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const { path, content } = args as { path: string; content: string }
      const absolute = resolve(workDir, path)
      const resolvedWorkDir = await realpath(workDir)

      if (!absolute.startsWith(resolve(workDir))) {
        return { output: "", error: `Path traversal denied: ${path}` }
      }

      try {
        await mkdir(dirname(absolute), { recursive: true })

        // For write, check the parent dir's real path since target may not exist yet
        const realParent = await realpath(dirname(absolute))
        if (!realParent.startsWith(resolvedWorkDir)) {
          return { output: "", error: `Path traversal denied: ${path}` }
        }

        await writeFile(absolute, content, "utf-8")
        return { output: `Written to ${path}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: "", error: msg }
      }
    },
  }
}
