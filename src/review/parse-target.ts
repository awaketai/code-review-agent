import { callLLM } from "simple-agent"
import type { ReviewTarget } from "./types.ts"

const PARSE_PROMPT = `Parse the following user input into a structured review target.

User input: "{input}"

Respond with a JSON object matching one of these shapes:
- { "type": "working-tree" }
- { "type": "staged" }
- { "type": "current-branch" }
- { "type": "commit", "commit": "<hash>" }
- { "type": "commit-range", "from": "<hash>" }
- { "type": "pull-request", "prNumber": <number> }
- { "type": "file", "paths": ["<path>", ...] }

Rules:
- "当前分支" / "current branch" / "this branch" -> current-branch
- "暂存区" / "staged" / "staged changes" -> staged
- No arguments / "未提交改动" / "uncommitted changes" / "working tree" -> working-tree
- PR / pull request / # followed by number -> pull-request
- commit hash (7-40 hex chars) alone -> commit
- "since/after <hash>" / "<hash> 之后" / "<hash>.." -> commit-range
- file paths (containing . or /) -> file
- If the input is ambiguous and you cannot confidently classify it, respond with: { "error": "ambiguous input" }

Respond ONLY with the JSON object, no other text.`

const VALID_TYPES = new Set([
  "working-tree",
  "staged",
  "current-branch",
  "commit",
  "commit-range",
  "pull-request",
  "file",
])

const HEX_RE = /^[0-9a-fA-F]{7,40}$/

function validateTarget(obj: unknown): ReviewTarget {
  if (!obj || typeof obj !== "object") {
    throw new Error(`Invalid review target: not a JSON object`)
  }
  const record = obj as Record<string, unknown>
  const type = record["type"]

  if (typeof type !== "string" || !VALID_TYPES.has(type)) {
    throw new Error(`Invalid review target type: ${String(type)}`)
  }

  switch (type) {
    case "working-tree":
    case "staged":
    case "current-branch":
      return { type } as ReviewTarget

    case "commit": {
      const commit = record["commit"]
      if (typeof commit !== "string" || !commit.trim()) {
        throw new Error(`Invalid commit target: missing or empty "commit" field`)
      }
      return { type: "commit", commit: commit.trim() }
    }

    case "commit-range": {
      const from = record["from"]
      if (typeof from !== "string" || !from.trim()) {
        throw new Error(`Invalid commit-range target: missing or empty "from" field`)
      }
      return { type: "commit-range", from: from.trim() }
    }

    case "pull-request": {
      const prNumber = record["prNumber"]
      if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error(`Invalid pull-request target: prNumber must be a positive integer`)
      }
      return { type: "pull-request", prNumber }
    }

    case "file": {
      const paths = record["paths"]
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error(`Invalid file target: "paths" must be a non-empty array`)
      }
      for (const p of paths) {
        if (typeof p !== "string" || !p.trim()) {
          throw new Error(`Invalid file target: each path must be a non-empty string`)
        }
      }
      return { type: "file", paths: (paths as string[]).map((p) => p.trim()) }
    }

    default:
      throw new Error(`Unhandled target type: ${type}`)
  }
}

export async function parseReviewTarget(
  input: string,
  config: { model: string; apiKey?: string; baseURL?: string },
): Promise<ReviewTarget> {
  const prompt = PARSE_PROMPT.replace("{input}", input.replace(/"/g, '\\"'))

  const result = await callLLM({
    model: config.model,
    messages: [
      {
        id: "parse-target",
        role: "user",
        content: [{ type: "text", text: prompt }],
        createdAt: new Date(),
      },
    ],
    systemPrompt: "You are a structured data parser. Output only valid JSON.",
    tools: [],
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxTokens: 1024,
  })

  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("")
    .trim()

  if (!text) {
    throw new Error(
      `Failed to parse review target. The LLM returned an empty response.\n\n` +
        `User input: "${input}"\n\n` +
        `Please specify a review target: "review current branch", "review PR 42", "review commit abc1234", etc.`,
    )
  }

  if (text.includes('"error"')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed.error) {
        throw new Error(
          `Could not determine review target from input.\n\n` +
            `User input: "${input}"\n` +
            `Parse result: ${text}\n\n` +
            `Please specify a review target: "review current branch", "review PR 42", "review commit abc1234", etc.`,
        )
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Could not determine")) throw err
      // Fall through to parse as normal
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `Failed to parse review target. The LLM returned invalid JSON.\n\n` +
        `User input: "${input}"\n` +
        `LLM response: "${text}"\n\n` +
        `Please specify a review target: "review current branch", "review PR 42", "review commit abc1234", etc.`,
    )
  }

  return validateTarget(parsed)
}
