import { describe, it, expect } from "vitest"
import { createGhTool } from "../../src/tools/gh.ts"

describe("gh tool — security filters", () => {
  const tool = createGhTool(process.cwd())

  it("blocks unknown top-level command", async () => {
    const result = await tool.execute({ command: "auth login" })
    expect(result.output).toContain("Blocked")
    expect(result.output).toContain("auth")
  })

  it("blocks gh pr merge", async () => {
    const result = await tool.execute({ command: "pr merge 42" })
    expect(result.output).toContain("Blocked")
    expect(result.output).toContain("merge")
  })

  it("blocks gh pr close", async () => {
    const result = await tool.execute({ command: "pr close 42" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks gh pr edit", async () => {
    const result = await tool.execute({ command: "pr edit 42" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks gh pr review (write operation)", async () => {
    const result = await tool.execute({ command: "pr review 42 --body 'lgtm'" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks gh issue close", async () => {
    const result = await tool.execute({ command: "issue close 123" })
    expect(result.output).toContain("Blocked")
    expect(result.output).toContain("close")
  })

  it("blocks gh issue edit", async () => {
    const result = await tool.execute({ command: "issue edit 123" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks gh issue delete", async () => {
    const result = await tool.execute({ command: "issue delete 123" })
    expect(result.output).toContain("Blocked")
  })

  it("blocks gh api with -X POST", async () => {
    const result = await tool.execute({ command: "api -X POST repos/owner/repo/pulls/42/comments" })
    expect(result.output).toContain("Blocked")
    expect(result.output).toContain("non-GET")
  })

  it("blocks gh api with --method DELETE", async () => {
    const result = await tool.execute({ command: "api --method DELETE repos/owner/repo/pulls/42/comments/1" })
    expect(result.output).toContain("Blocked")
    expect(result.output).toContain("non-GET")
  })

  it("blocks gh api with -X PUT", async () => {
    const result = await tool.execute({ command: "api -X PUT repos/owner/repo/pulls/42" })
    expect(result.output).toContain("Blocked")
  })

  it("allows pr view (structure only, may fail without gh auth)", async () => {
    const result = await tool.execute({ command: "pr view 1" })
    expect(result.output).not.toContain("Blocked")
  })

  it("allows pr diff (structure only)", async () => {
    const result = await tool.execute({ command: "pr diff 1" })
    expect(result.output).not.toContain("Blocked")
  })

  it("allows issue view (structure only)", async () => {
    const result = await tool.execute({ command: "issue view 1" })
    expect(result.output).not.toContain("Blocked")
  })

  it("allows api GET (structure only)", async () => {
    const result = await tool.execute({ command: "api repos/octocat/hello-world/readme" })
    expect(result.output).not.toContain("Blocked")
  })

  it("allows api with explicit -X GET", async () => {
    const result = await tool.execute({ command: "api -X GET repos/octocat/hello-world/readme" })
    expect(result.output).not.toContain("Blocked")
  })

  it("rejects shell pipe", async () => {
    const result = await tool.execute({ command: "pr view 42 | grep title" })
    expect(result.output).toContain("Shell metacharacters")
  })

  it("rejects shell redirect", async () => {
    const result = await tool.execute({ command: "pr diff 42 > out.patch" })
    expect(result.output).toContain("Shell metacharacters")
  })
})
