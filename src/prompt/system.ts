import { readFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

function findProjectRoot(startDir: string): string {
  let dir = startDir
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, "package.json"))) return dir
    dir = dirname(dir)
  }
  return startDir
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = findProjectRoot(currentDir)

export async function loadSystemPrompt(): Promise<string> {
  const promptPath = resolve(projectRoot, "specs/0001-system.md")
  return readFile(promptPath, "utf-8")
}
