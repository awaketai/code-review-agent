import { describe, it, expect } from "vitest"
import { validateTarget } from "../../src/review/parse-target.ts"

// We test validateTarget directly since parseReviewTarget requires an LLM call.
// validateTarget is the core schema validation logic.

// Re-export for testing — validateTarget is not exported, so we test via the
// public parseReviewTarget by mocking callLLM. But since validateTarget is
// the critical part, let's test it through a minimal wrapper.

// Actually, validateTarget is a local function. Let's test the exported
// parseReviewTarget with a mocked callLLM.

import { vi } from "vitest"

// Mock simple-agent's callLLM
vi.mock("simple-agent", () => ({
  callLLM: vi.fn(),
}))

import { callLLM } from "simple-agent"
import { parseReviewTarget } from "../../src/review/parse-target.ts"

const mockCallLLM = vi.mocked(callLLM)

function mockLLMResponse(json: string) {
  mockCallLLM.mockResolvedValueOnce({
    content: [{ type: "text" as const, text: json }],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 20 },
  })
}

describe("parseReviewTarget", () => {
  const config = { model: "test-model" }

  it("parses working-tree target", async () => {
    mockLLMResponse('{"type": "working-tree"}')
    const result = await parseReviewTarget("review", config)
    expect(result).toEqual({ type: "working-tree" })
  })

  it("parses staged target", async () => {
    mockLLMResponse('{"type": "staged"}')
    const result = await parseReviewTarget("review staged changes", config)
    expect(result).toEqual({ type: "staged" })
  })

  it("parses current-branch target", async () => {
    mockLLMResponse('{"type": "current-branch"}')
    const result = await parseReviewTarget("review current branch", config)
    expect(result).toEqual({ type: "current-branch" })
  })

  it("parses commit target", async () => {
    mockLLMResponse('{"type": "commit", "commit": "abc1234"}')
    const result = await parseReviewTarget("review abc1234", config)
    expect(result).toEqual({ type: "commit", commit: "abc1234" })
  })

  it("parses commit-range target", async () => {
    mockLLMResponse('{"type": "commit-range", "from": "abc1234"}')
    const result = await parseReviewTarget("review abc1234 之后的代码", config)
    expect(result).toEqual({ type: "commit-range", from: "abc1234" })
  })

  it("parses pull-request target", async () => {
    mockLLMResponse('{"type": "pull-request", "prNumber": 42}')
    const result = await parseReviewTarget("review PR 42", config)
    expect(result).toEqual({ type: "pull-request", prNumber: 42 })
  })

  it("parses file target", async () => {
    mockLLMResponse('{"type": "file", "paths": ["src/index.ts"]}')
    const result = await parseReviewTarget("review src/index.ts", config)
    expect(result).toEqual({ type: "file", paths: ["src/index.ts"] })
  })

  it("rejects invalid JSON from LLM", async () => {
    mockLLMResponse("not json at all")
    await expect(parseReviewTarget("review stuff", config)).rejects.toThrow(
      "Failed to parse review target",
    )
  })

  it("rejects invalid target type", async () => {
    mockLLMResponse('{"type": "invalid"}')
    await expect(parseReviewTarget("review stuff", config)).rejects.toThrow(
      "Invalid review target type",
    )
  })

  it("rejects commit target without commit field", async () => {
    mockLLMResponse('{"type": "commit"}')
    await expect(parseReviewTarget("review abc", config)).rejects.toThrow(
      'missing or empty "commit" field',
    )
  })

  it("rejects pull-request target with non-integer prNumber", async () => {
    mockLLMResponse('{"type": "pull-request", "prNumber": "42"}')
    await expect(parseReviewTarget("review PR 42", config)).rejects.toThrow(
      "prNumber must be a positive integer",
    )
  })

  it("rejects file target with empty paths", async () => {
    mockLLMResponse('{"type": "file", "paths": []}')
    await expect(parseReviewTarget("review files", config)).rejects.toThrow(
      '"paths" must be a non-empty array',
    )
  })

  it("rejects empty LLM response", async () => {
    mockLLMResponse("")
    await expect(parseReviewTarget("review", config)).rejects.toThrow(
      "empty response",
    )
  })

  it("rejects ambiguous input", async () => {
    mockLLMResponse('{"error": "ambiguous input"}')
    await expect(parseReviewTarget("something weird", config)).rejects.toThrow(
      "Could not determine review target",
    )
  })
})
