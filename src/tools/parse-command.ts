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

  return parts
}

const SHELL_METACHAR_RE = /\||>|</

export function assertNoShellChars(command: string): void {
  if (SHELL_METACHAR_RE.test(command)) {
    throw new Error(
      `Shell metacharacters (|, >, <) are not allowed in command: "${command}"`,
    )
  }
}
