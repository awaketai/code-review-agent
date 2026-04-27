# code-review-agent

LLM-driven code review agent built on [simple-agent](https://github.com/user/simple-agent). Give it a branch, commit, or PR — it collects the diff, gathers context, and produces a structured review.

## How it works

```
User input
  → LLM Target Parse (one cheap call, structured JSON)
  → Deterministic context collection (git diff / gh pr diff / file reads)
  → Agent loop (LLM reviews with pre-assembled context, optional supplementary queries)
  → Review output to stdout
```

The agent splits responsibilities: **code handles orchestration** (target parsing, diff collection, context assembly, safety), while the **LLM handles judgment** (code understanding, risk assessment, review output).

## Install

```bash
# Clone and install
git clone <repo-url>
cd code-review-agent
pnpm install

# Build
pnpm build
```

Requires Node.js >= 22 and [GitHub CLI](https://cli.github.com/) (`gh`) for PR reviews.

## Quick start

```bash
# Set your API key
export OPENAI_API_KEY=your-key

# If using an OpenAI-compatible provider (e.g. proxy, self-hosted)
export OPENAI_BASE_URL=https://your-provider.com/v1

# Review current branch against main
pnpm dev "review current branch"

# Review a specific commit range
pnpm dev "review commit abc1234 之后的代码"

# Review a pull request
pnpm dev "review pull request 42"

# Review staged changes
pnpm dev "review staged changes"
```

Or use the built CLI:

```bash
pnpm build
node dist/index.js "review current branch"
```

## Usage

```
code-review-agent <review-target>
```

The `<review-target>` is natural language. The LLM parses it into a structured target, then code collects the relevant diff and context. Examples:

| Input | Target Type | What happens |
|-------|-------------|-------------|
| `"review"` / `"review uncommitted changes"` | `working-tree` | Diffs unstaged + staged changes |
| `"review staged changes"` / `"review 暂存区"` | `staged` | Diffs only staged (`--cached`) changes |
| `"review current branch"` | `current-branch` | Diffs branch against `main` (or uncommitted if on main) |
| `"review abc1234"` | `commit` | Shows that commit's diff |
| `"review abc1234 之后的代码"` / `"review since abc1234"` | `commit-range` | Diffs from that commit to HEAD |
| `"review pull request 42"` / `"review PR 42"` | `pull-request` | Fetches PR diff via `gh` |
| `"review src/index.ts"` | `file` | Diffs changes in that file |

If the input is ambiguous or cannot be parsed, the agent reports an error and suggests clearer input.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | yes | — | API key for the LLM provider |
| `OPENAI_BASE_URL` | no | — | Custom base URL (for OpenAI-compatible providers) |
| `REVIEW_MODEL` | no | `claude-sonnet-4-6` | Model name |
| `REVIEW_MAX_STEPS` | no | `20` | Max agent loop iterations for supplementary queries |

Works with any OpenAI-compatible API. Set `OPENAI_BASE_URL` to point at your provider.

## Tools (agent loop)

The agent loop has three read-only tools for supplementary queries:

| Tool | Purpose | Safety |
|------|---------|--------|
| `read_file` | Read file contents | Path traversal check + symlink resolution; auto-truncates at 50KB |
| `git` | Run read-only git subcommands | Blocks write ops, shell metacharacters (`\|`, `>`, `<`), unknown subcommands |
| `gh` | Run read-only GitHub CLI | Whitelist: `pr view/diff/checks/list/status`, `issue view/list/status`, `api` GET only |

No `write_file`, `bash`, or any write capability. All review output goes to stdout.

## Architecture

```
src/
├── index.ts              # CLI entry: parse-target → build-context → agent loop
├── config.ts             # Default model, maxSteps
├── prompt/
│   └── system.ts         # Loads specs/0001-system.md
├── review/
│   ├── types.ts          # ReviewTarget, ReviewContext type definitions
│   ├── parse-target.ts   # LLM call: user input → ReviewTarget JSON
│   └── build-context.ts  # Deterministic collection: target → diffs, files, conventions
└── tools/
    ├── parse-command.ts  # Command string parser + shell char validation
    ├── read-file.ts      # read_file tool (with 50KB truncation)
    ├── git.ts            # git tool (read-only, strict validation)
    └── gh.ts             # gh tool (read-only, whitelist)

specs/
├── 0001-system.md        # System prompt (review judgment only)
├── 0002-code-review-agent-design.md  # Original design doc
└── 0003-review-orchestration-refactor.md  # Refactor spec
```

Key principle: **LLM handles understanding and judgment, code handles orchestration and safety.** The LLM parses natural language into structured targets, then reviews pre-assembled context. Code ensures deterministic data collection, tool boundaries, and error handling.

## Development

```bash
# Type check
pnpm typecheck

# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Build
pnpm build

# Run from source
pnpm dev "review current branch"
```

## Design docs

- [System Prompt](specs/0001-system.md) — review judgment instructions
- [Original Design Doc](specs/0002-code-review-agent-design.md) — initial architecture
- [Refactor Spec](specs/0003-review-orchestration-refactor.md) — orchestration refactor rationale and plan
