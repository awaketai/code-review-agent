export function parseCommand(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let inQuote: "'" | '"' | null = null

  for (const char of command) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null
      } else {
        current += char
      }
    } else if (char === "'" || char === '"') {
      inQuote = char
    } else if (char === " ") {
      if (current) {
        parts.push(current)
        current = ""
      }
    } else {
      current += char
    }
  }
  if (current) parts.push(current)

  // Filter out shell redirects/pipes and their targets — execFile doesn't
  // use a shell, so these would be passed as literal arguments.
  return stripShellRedirects(parts)
}

function stripShellRedirects(parts: string[]): string[] {
  const result: string[] = []
  let skip = false

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i] ?? ""
    if (skip) {
      skip = false
      continue
    }
    // 2>&1, 1>&2, etc. — no target to skip
    if (/^\d*>&\d+$/.test(token)) continue
    // > file, 2> file, >> file, 2>> file — skip redirect + next token (filename)
    if (/^\d*>+$/.test(token)) {
      skip = true
      continue
    }
    // < file — skip redirect + next token
    if (token === "<") {
      skip = true
      continue
    }
    // | — skip pipe token only (next token is a command the LLM might want)
    if (token === "|") continue
    result.push(token)
  }
  return result
}
