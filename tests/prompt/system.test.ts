import { describe, it, expect } from "vitest"
import { loadSystemPrompt } from "../../src/prompt/system.ts"

describe("loadSystemPrompt", () => {
  it("loads the system prompt successfully", async () => {
    const prompt = await loadSystemPrompt()
    expect(prompt).toContain("code review agent")
    expect(prompt.length).toBeGreaterThan(500)
  })

  it("contains read-only tool descriptions", async () => {
    const prompt = await loadSystemPrompt()
    expect(prompt).toContain("read_file")
    expect(prompt).toContain("git")
    expect(prompt).toContain("gh")
    // write_file and bash should NOT be present
    expect(prompt).not.toContain("write_file")
    expect(prompt).not.toContain("bash")
  })

  it("contains review methodology", async () => {
    const prompt = await loadSystemPrompt()
    expect(prompt).toContain("What to look for")
    expect(prompt).toContain("Output format")
  })
})
