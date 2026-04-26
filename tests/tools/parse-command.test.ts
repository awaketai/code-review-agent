import { describe, it, expect } from "vitest"
import { parseCommand } from "../../src/tools/parse-command.ts"

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

  it("strips shell redirect 2>&1", () => {
    expect(parseCommand("log --oneline 2>&1")).toEqual(["log", "--oneline"])
  })

  it("strips shell redirect >", () => {
    expect(parseCommand("diff > output.txt")).toEqual(["diff"])
  })

  it("strips shell pipe |", () => {
    expect(parseCommand("log --oneline | head -5")).toEqual(["log", "--oneline", "head", "-5"])
  })

  it("strips 2>> redirect", () => {
    expect(parseCommand("log 2>> err.log")).toEqual(["log"])
  })
})
