import { describe, it, expect } from "vitest"
import { parseCommand, assertNoShellChars } from "../../src/tools/parse-command.ts"

describe("parseCommand", () => {
  it("splits simple command", () => {
    expect(parseCommand("diff main...HEAD")).toEqual(["diff", "main...HEAD"])
  })

  it("handles single-quoted strings", () => {
    expect(parseCommand("log --format='%H %s'")).toEqual(["log", "--format=%H %s"])
  })

  it("handles double-quoted strings", () => {
    expect(parseCommand('log --format="%H %s"')).toEqual(["log", "--format=%H %s"])
  })

  it("handles multiple spaces between args", () => {
    expect(parseCommand("diff   --cached")).toEqual(["diff", "--cached"])
  })

  it("returns empty array for empty string", () => {
    expect(parseCommand("")).toEqual([])
  })

  it("handles single arg", () => {
    expect(parseCommand("status")).toEqual(["status"])
  })

  it("handles quoted string with spaces", () => {
    expect(parseCommand("commit -m 'fix the bug'")).toEqual(["commit", "-m", "fix the bug"])
  })

  it("preserves redirect tokens (shell validation is separate)", () => {
    expect(parseCommand("diff > output.txt")).toEqual(["diff", ">", "output.txt"])
  })

  it("preserves pipe token (shell validation is separate)", () => {
    expect(parseCommand("log --oneline | head -5")).toEqual(["log", "--oneline", "|", "head", "-5"])
  })
})

describe("assertNoShellChars", () => {
  it("passes for valid commands", () => {
    expect(() => assertNoShellChars("diff main...HEAD")).not.toThrow()
    expect(() => assertNoShellChars("log --oneline -20")).not.toThrow()
  })

  it("rejects pipe", () => {
    expect(() => assertNoShellChars("log --oneline | head -5")).toThrow(/Shell metacharacters/)
  })

  it("rejects redirect >", () => {
    expect(() => assertNoShellChars("diff > output.txt")).toThrow(/Shell metacharacters/)
  })

  it("rejects redirect <", () => {
    expect(() => assertNoShellChars("diff < input.txt")).toThrow(/Shell metacharacters/)
  })
})
