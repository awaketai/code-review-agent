# code-review-agent

LLM-driven code review agent built on [simple-agent](https://github.com/user/simple-agent). Give it a branch, commit, or PR — it reads the diff, gathers context, and produces a structured review.

## How it works

```
User input → simple-agent loop → LLM → tool calls → LLM → ... → review output
```

The agent code contains **zero business logic**. All review behavior — what to check, how to gather context, output format — is defined in the [system prompt](specs/0001-system.md). The code just provides four tools and passes user input to the LLM.

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

The `<review-target>` is natural language. The LLM interprets it and decides which tools to call. Examples:

| Input | What happens |
|-------|-------------|
| `"review current branch"` | Diffs current branch against `main` (or `master`) |
| `"review commit abc1234 之后的代码"` | Diffs from that commit to HEAD |
| `"review pull request 42"` | Fetches PR context and diff via `gh` |
| `"review src/index.ts"` | Diffs uncommitted changes in that file |
| `"review staged changes"` | Diffs only staged (`--cached`) changes |
| *(no arguments)* | Shows help |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | yes | — | API key for the LLM provider |
| `OPENAI_BASE_URL` | no | — | Custom base URL (for OpenAI-compatible providers) |
| `REVIEW_MODEL` | no | `claude-sonnet-4-6` | Model name |
| `REVIEW_MAX_STEPS` | no | `50` | Max agent loop iterations |

Works with any OpenAI-compatible API. Set `OPENAI_BASE_URL` to point at your provider.

## Tools

The agent has exactly four tools, all read-only with respect to the repository:

| Tool | Purpose | Safety |
|------|---------|--------|
| `read_file` | Read file contents | Path traversal check + symlink resolution |
| `write_file` | Write review output | Path traversal check; only for reports, not source |
| `git` | Run git subcommands | Blocks write ops (`push`, `commit`, `reset`, etc.) |
| `gh` | Run GitHub CLI subcommands | Whitelist: only `pr view/diff/checks/list/status`, `issue view/list/status`, `api` GET |

## Architecture

```
src/
├── index.ts              # CLI entry + runCodeReview()
├── config.ts             # Default model, maxSteps
├── prompt/
│   └── system.ts         # Loads specs/0001-system.md
└── tools/
    ├── parse-command.ts   # Shared command string parser
    ├── read-file.ts       # read_file tool
    ├── write-file.ts      # write_file tool
    ├── git.ts             # git tool
    └── gh.ts              # gh tool

specs/
├── 0001-system.md        # System prompt (all review behavior defined here)
└── 0002-code-review-agent-design.md  # Design doc
```

Key principle: **intelligence lives in the system prompt, code is just plumbing.** To change review behavior (e.g. add SQL injection checks), edit `specs/0001-system.md` — no code changes needed.

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

- [System Prompt](specs/0001-system.md) — defines all LLM behavior
- [Design Doc](specs/0002-code-review-agent-design.md) — architecture, tool design, security model
