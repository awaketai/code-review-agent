import { describe, it, expect } from "vitest"
import { loadSystemPrompt } from "../../src/prompt/system.ts"

describe("loadSystemPrompt", () => {
  it("loads the system prompt successfully", async () => {
    const prompt = await loadSystemPrompt()
    expect(prompt).toContain("code review agent")
    expect(prompt.length).toBeGreaterThan(1000)
  })

  it("contains tool descriptions", async () => {
    const prompt = await loadSystemPrompt()
    expect(prompt).toContain("read_file")
    expect(prompt).toContain("write_file")
    expect(prompt).toContain("git")
    expect(prompt).toContain("gh")
  })

  it("contains review methodology", async () => {
    const prompt = await loadSystemPrompt()
    expect(prompt).toContain("Determining what to review")
    expect(prompt).toContain("Gathering context")
    expect(prompt).toContain("What to look for")
  })
})
