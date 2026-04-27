# Code Review Agent 设计文档

## 1. 概述

基于 `simple-agent` 框架构建一个专注于代码审查的 Agent。用户通过自然语言描述审查目标，Agent 自动解析意图、获取 diff、阅读上下文、产出结构化的审查报告。

### 核心架构原则：LLM 驱动，代码无智能

**Agent 代码不包含任何业务逻辑、路由逻辑或决策逻辑。** 整个代码审查流程完全由 LLM 驱动：

```
用户输入 → [agent 代码原样传递] → LLM → [LLM 决定调用什么工具] → agent 代码执行工具 → 返回结果 → LLM → ...
```

Agent 代码的职责**仅限于**：
1. 加载 system prompt（从 `specs/0001-system.md`）
2. 注册五个工具（`read_file`、`write_file`、`git`、`gh`、`bash`）
3. 将用户输入原样传给 LLM
4. 执行 LLM 发出的工具调用，返回结果
5. 流式输出 LLM 的响应文本

Agent 代码**不做**：
- ❌ 解析用户意图（"这是 PR 还是 branch？"由 LLM 判断）
- ❌ 决定调用顺序（"先 diff 还是先 read_file？"由 LLM 判断）
- ❌ 路由到不同处理流程（没有 `if input.isPR() then ...` 这样的代码）
- ❌ 格式化输出（输出格式由 system prompt 定义，LLM 自行遵循）

**所有审查行为规范都定义在 system prompt 中**，包括：如何解析用户意图、如何选择工具、审查什么、不审查什么、输出格式、错误处理策略。修改审查策略只需编辑 `specs/0001-system.md`，不需要改任何代码。

### 核心约束

- 运行在 `simple-agent` 的 agent loop 中（`createSession` → `streamAgent`）
- 仅有五个工具：`read_file`、`write_file`、`git`、`gh`、`bash`
- `bash` 工具仅允许白名单内的只读命令，不修改源代码，不运行测试/构建
- System prompt 是唯一的行为定义来源（`specs/0001-system.md`）

---

## 2. 用户场景

| 用户输入 | 解析目标 | 工具调用链 |
|---------|---------|-----------|
| `帮我 review 当前 branch 新代码` | 当前分支相对默认分支的 diff | `git rev-parse --abbrev-ref HEAD` → `git diff main...HEAD` → `read_file` 逐个文件 |
| `帮我 review commit abc1234 之后的代码` | 指定 commit 到 HEAD 的 diff | `git log --oneline abc1234..HEAD` → `git diff abc1234..HEAD` → `read_file` |
| `帮我 review pull request 42` | PR 的 diff 和上下文 | `gh pr view 42` → `gh pr diff 42` → `read_file` |
| `review 这个文件 src/index.ts` | 单个文件的未提交变更 | `git diff -- src/index.ts` → `git diff --cached -- src/index.ts` → `read_file` |
| `review 暂存区的改动` | staged changes | `git diff --cached` → `read_file` |
| *(无参数)* | 所有未提交变更 | `git diff` → `git diff --cached` → `read_file` |

---

## 3. 架构设计

```
┌──────────────────────────────────────────────────┐
│                   用户输入                         │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│              simple-agent loop                    │
│  ┌─────────────────────────────────────────────┐ │
│  │           System Prompt                      │ │
│  │         (specs/0001-system.md)               │ │
│  └─────────────────────────────────────────────┘ │
│                                                   │
│  ┌──────────┐ ┌──────────┐ ┌─────┐ ┌────┐ ┌──────┐ │
│  │read_file │ │write_file│ │ git │ │ gh │ │ bash │ │
│  └────┬─────┘ └────┬─────┘ └──┬──┘ └──┬─┘ └──┬───┘ │
│       │            │          │        │       │      │
└───────┼────────────┼──────────┼────────┼───────┼─────┘
        │            │          │        │       │
        ▼            ▼          ▼        ▼       ▼
   文件系统        文件系统    git CLI  gh CLI  /bin/sh
```

### 3.1 系统分层

```
src/
├── index.ts              # 入口：解析 CLI 参数，启动 agent
├── tools/
│   ├── read-file.ts      # read_file 工具实现
│   ├── write-file.ts     # write_file 工具实现
│   ├── git.ts            # git 工具实现
│   ├── gh.ts             # gh 工具实现
│   └── bash.ts           # bash 工具实现（白名单只读命令）
├── prompt/
│   └── system.ts         # 加载并组装 system prompt
└── config.ts             # 配置：模型、max steps 等
```

### 3.2 设计原则

#### 核心：智能在 Prompt，代码是管道

这是本项目最重要的设计原则。Agent 代码是一条无状态管道：

| 层 | 职责 | 包含智能？ |
|----|------|-----------|
| System Prompt | 定义审查流程、工具使用策略、输出格式、错误处理 | ✅ 所有智能在这里 |
| Agent 入口 (`index.ts`) | 加载 prompt、注册工具、传递用户输入、流式输出 | ❌ 纯编排 |
| 工具实现 (`tools/*.ts`) | 执行单一操作、返回结果、安全校验 | ❌ 纯执行 |
| simple-agent loop | LLM 调用、工具调度、消息管理 | ❌ 通用框架 |

**检验标准：** 如果你想修改审查行为（比如"增加对 SQL 注入的检查"），你应该只修改 system prompt，不碰任何 `.ts` 文件。如果做不到，说明设计泄漏了。

#### SOLID 原则

**S — 单一职责（Single Responsibility）**

每个模块只做一件事：
- 每个工具文件只负责一个工具的参数校验和执行
- `prompt/system.ts` 只负责 system prompt 的加载
- `index.ts` 只负责入口编排
- 没有任何模块承担"理解用户意图"的职责 — 那是 LLM 的工作

**O — 开闭原则（Open-Closed）**

- 工具通过 `simple-agent` 的 `Tool` 接口注册，新增工具只需新建文件并注册，不修改 agent loop
- System prompt 是外部 markdown 文件，修改审查策略不需要改代码
- 新增审查维度（如"检查国际化"）只需编辑 prompt，不需要改代码

**L — 里氏替换（Liskov Substitution）**

- 所有工具实现同一个 `Tool` 接口（`name`、`description`、`parameters`、`execute`），agent loop 对工具无差别调用

**I — 接口隔离（Interface Segregation）**

- 每个工具只暴露 LLM 需要的最小参数集，不混合无关功能
- `git` 工具只接收 `command` 字符串，不暴露底层 `spawn` 细节
- `read_file` 只接收 `path`，不包含 write 能力

**D — 依赖反转（Dependency Inversion）**

- 工具通过 `Tool` 接口定义行为，`index.ts` 组装具体实现
- agent loop 依赖 `Tool` 抽象，不依赖具体工具实现
- 命令执行（`child_process`）被封装在工具内部，上层不感知

---

## 4. 工具详细设计

### 4.1 `read_file`

```typescript
import type { Tool } from "simple-agent"
import { readFile, realpath } from "node:fs/promises"
import { resolve } from "node:path"

export function createReadFileTool(workDir: string): Tool {
  return {
    name: "read_file",
    description: "Read the contents of a file at a given path relative to the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the working directory"
        }
      },
      required: ["path"]
    },
    execute: async (args) => {
      const { path } = args as { path: string }
      const absolute = resolve(workDir, path)
      const resolvedWorkDir = await realpath(workDir)

      if (!absolute.startsWith(resolve(workDir))) {
        return { output: "", error: `Path traversal denied: ${path}` }
      }

      try {
        const real = await realpath(absolute)
        if (!real.startsWith(resolvedWorkDir)) {
          return { output: "", error: `Path traversal denied: ${path}` }
        }
        const content = await readFile(real, "utf-8")
        return { output: content }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: "", error: msg }
      }
    }
  }
}
```

**关键决策：**
- 路径相对于工作目录解析，防止路径穿越
- 使用 `realpath` 解析符号链接后二次检查，防止 symlink 绕过
- 返回完整文件内容，由 LLM 自行定位关注区域
- 对于不存在的文件返回 error，让 LLM 感知失败并调整策略

### 4.2 `write_file`

```typescript
import type { Tool } from "simple-agent"
import { writeFile, mkdir, realpath } from "node:fs/promises"
import { resolve, dirname } from "node:path"

export function createWriteFileTool(workDir: string): Tool {
  return {
    name: "write_file",
    description:
      "Write content to a file. Use only for producing review output (reports, summaries). Never use to modify source code.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the working directory"
        },
        content: {
          type: "string",
          description: "Content to write to the file"
        }
      },
      required: ["path", "content"]
    },
    execute: async (args) => {
      const { path, content } = args as { path: string; content: string }
      const absolute = resolve(workDir, path)
      const resolvedWorkDir = await realpath(workDir)

      if (!absolute.startsWith(resolve(workDir))) {
        return { output: "", error: `Path traversal denied: ${path}` }
      }

      try {
        await mkdir(dirname(absolute), { recursive: true })
        const realParent = await realpath(dirname(absolute))
        if (!realParent.startsWith(resolvedWorkDir)) {
          return { output: "", error: `Path traversal denied: ${path}` }
        }
        await writeFile(absolute, content, "utf-8")
        return { output: `Written to ${path}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: "", error: msg }
      }
    }
  }
}
```

**关键决策：**
- 自动创建父目录（`recursive: true`），避免 LLM 需要额外操作
- 写入前用 `realpath` 检查父目录的真实路径，防止通过 symlinked 目录写入外部
- System prompt 中已约束 LLM 不得用此工具修改源代码，代码层不做硬性限制（灵活性 > 过度防御）

### 4.3 `git`

```typescript
import type { Tool } from "simple-agent"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export function createGitTool(workDir: string): Tool {
  return {
    name: "git",
    description:
      "Run a git subcommand. Examples: 'diff', 'diff --cached', 'log --oneline -20', 'show abc1234', 'blame src/file.ts', 'diff main...HEAD'. Do not include the leading 'git'.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The git subcommand and arguments, e.g. 'diff main...HEAD' or 'log --oneline abc1234..HEAD'"
        }
      },
      required: ["command"]
    },
    execute: async (args) => {
      const { command } = args as { command: string }
      const parts = parseCommand(command)

      // 安全检查：禁止危险的写操作
      const blocked = ["push", "reset", "rebase", "merge", "commit", "checkout", "switch", "branch", "tag", "stash", "clean", "rm"]
      if (blocked.includes(parts[0] ?? "")) {
        return { output: "", error: `Blocked: 'git ${parts[0]}' is not allowed in review mode` }
      }

      try {
        const { stdout, stderr } = await execFileAsync("git", parts, {
          cwd: workDir,
          maxBuffer: 10 * 1024 * 1024, // 10MB — 大 diff 场景
          timeout: 30_000
        })
        const output = stdout !== "" ? stdout : stderr
        return { output: output.trimEnd() }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: "", error: msg }
      }
    }
  }
}

function parseCommand(command: string): string[] {
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
```

**关键决策：**
- 使用 `execFile` 而非 `exec`，避免 shell 注入
- 命令解析使用自定义 parser 处理引号内空格，不依赖 shell
- 显式拦截写操作子命令（`push`、`commit`、`reset` 等），确保 agent 只能只读使用 git
- `maxBuffer` 设为 10MB，足以处理大型仓库的 diff
- 超时 30 秒，避免挂起

### 4.4 `gh`

```typescript
import type { Tool } from "simple-agent"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parseCommand } from "./parse-command.ts"

const execFileAsync = promisify(execFile)

const ALLOWED_TOP_LEVEL = ["pr", "issue", "api", "repo"]
const ALLOWED_PR_SUB = ["view", "diff", "checks", "list", "status"]
const ALLOWED_ISSUE_SUB = ["view", "list", "status"]

function hasWriteMethod(parts: string[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    const arg = parts[i]
    if (arg === "-X" || arg === "--method") {
      const method = parts[i + 1]?.toUpperCase()
      if (method && method !== "GET") return true
    }
  }
  return false
}

export function createGhTool(workDir: string): Tool {
  return {
    name: "gh",
    description:
      "Run a GitHub CLI (gh) subcommand. Examples: 'pr view 42', 'pr diff 42', 'pr diff 42 --name-only', 'pr checks 42', 'issue view 123', 'api repos/{owner}/{repo}/pulls/42/comments'. Do not include the leading 'gh'.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The gh subcommand and arguments, e.g. 'pr view 42' or 'pr diff 42'"
        }
      },
      required: ["command"]
    },
    execute: async (args) => {
      const { command } = args as { command: string }
      const parts = parseCommand(command)

      const topLevel = parts[0] ?? ""
      if (!ALLOWED_TOP_LEVEL.includes(topLevel)) {
        return { output: "", error: `Blocked: 'gh ${topLevel}' is not allowed in review mode` }
      }

      if (topLevel === "pr") {
        const prSub = parts[1] ?? ""
        if (!ALLOWED_PR_SUB.includes(prSub)) {
          return { output: "", error: `Blocked: 'gh pr ${prSub}' is not allowed in review mode. Allowed: ${ALLOWED_PR_SUB.join(", ")}` }
        }
      }

      if (topLevel === "issue") {
        const issueSub = parts[1] ?? ""
        if (!ALLOWED_ISSUE_SUB.includes(issueSub)) {
          return { output: "", error: `Blocked: 'gh issue ${issueSub}' is not allowed in review mode. Allowed: ${ALLOWED_ISSUE_SUB.join(", ")}` }
        }
      }

      if (topLevel === "api" && hasWriteMethod(parts)) {
        return { output: "", error: "Blocked: 'gh api' with non-GET method is not allowed in review mode" }
      }

      try {
        const { stdout, stderr } = await execFileAsync("gh", parts, {
          cwd: workDir,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000
        })
        const output = stdout !== "" ? stdout : stderr
        return { output: output.trimEnd() }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: "", error: msg }
      }
    }
  }
}
```

**关键决策：**
- 白名单机制：只允许 `pr`、`issue`、`api`、`repo` 顶级命令
- 对 `pr` 子命令进一步限制为只读操作（`view`、`diff`、`checks`、`list`、`status`）
- 对 `issue` 子命令同样限制为只读操作（`view`、`list`、`status`）
- 不允许 `pr merge`、`pr close`、`pr edit`、`pr review`（会提交 review）等写操作
- `gh api` 检测 `-X`/`--method` 参数，拦截非 GET 请求（`POST`、`PUT`、`DELETE` 等）
- `parseCommand` 函数与 `git` 工具共享，提取为 `src/tools/parse-command.ts` 公共模块
- `stdout !== "" ? stdout : stderr` 正确处理空 stdout（如无变更时），不会误用 stderr 替代
- System prompt 中已告知 LLM 这些工具是只读的，LLM 不会主动尝试写操作；代码层的白名单是防御性兜底

### 4.5 `bash`

```typescript
import type { Tool } from "simple-agent"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const ALLOWED_COMMANDS = new Set([
  "pwd", "ls", "find", "grep", "cat", "head", "tail", "wc",
  "file", "stat", "which", "echo", "env", "uname", "date",
  "dirname", "basename", "realpath", "du", "sort", "uniq",
  "tr", "cut", "awk", "sed", "xargs", "tee", "diff", "tree",
])

export function createBashTool(workDir: string): Tool {
  return {
    name: "bash",
    description: "Run a read-only shell command. Only whitelisted commands allowed.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" }
      },
      required: ["command"]
    },
    execute: async (args) => {
      const { command } = args as { command: string }

      // 提取管道中所有命令名，全部必须在白名单内
      const commands = extractCommands(command)
      const disallowed = commands.filter(c => !ALLOWED_COMMANDS.has(c))
      if (disallowed.length > 0) {
        return { output: "", error: `Blocked: ${disallowed.join(", ")}` }
      }

      // 拦截 sed -i（就地编辑）
      if (hasSedInPlace(command)) {
        return { output: "", error: "Blocked: 'sed -i' is not allowed" }
      }

      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      })
      return { output: (stdout || stderr).trimEnd() }
    }
  }
}
```

**关键决策：**
- 使用 `execFile("/bin/sh", ["-c", command])` 执行，因为白名单内的命令需要管道和重定向支持（如 `find . -name "*.ts" | wc -l`）
- **白名单机制**：解析命令字符串，提取管道中所有命令名，全部必须在 `ALLOWED_COMMANDS` 白名单内
- 路径前缀自动剥离：`/usr/bin/grep` → `grep`，确保完整路径的命令也能通过白名单
- 特殊处理 `sed -i`：`sed` 本身允许（用于文本提取/打印），但 `-i` 标志（就地编辑）被拦截
- 与 git/gh 工具一致的 `maxBuffer`（10MB）和 `timeout`（30s）配置
- 不需要 `parseCommand` 工具，因为通过 shell 执行，shell 自行处理引号和转义

---

## 5. 入口设计

```typescript
// src/index.ts
import { createSession, streamAgent } from "simple-agent"
import { createReadFileTool } from "./tools/read-file.ts"
import { createWriteFileTool } from "./tools/write-file.ts"
import { createGitTool } from "./tools/git.ts"
import { createGhTool } from "./tools/gh.ts"
import { loadSystemPrompt } from "./prompt/system.ts"

interface ReviewConfig {
  model: string
  workDir: string
  maxSteps?: number
  apiKey?: string
  baseURL?: string
}

export async function runCodeReview(input: string, config: ReviewConfig) {
  const workDir = config.workDir
  const systemPrompt = await loadSystemPrompt()

  const tools = [
    createReadFileTool(workDir),
    createWriteFileTool(workDir),
    createGitTool(workDir),
    createGhTool(workDir),
  ]

  const agentConfig = {
    model: config.model,
    systemPrompt,
    tools,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxSteps: config.maxSteps ?? 50,
  }

  const session = createSession(agentConfig)

  // 将用户输入作为第一条消息
  session.messages.push({
    id: `user-${Date.now()}`,
    role: "user",
    content: [{ type: "text", text: input }],
    createdAt: new Date(),
  })

  // 流式输出
  for await (const event of streamAgent(session, agentConfig)) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text)
        break
      case "tool_call":
        // 可选：显示工具调用信息
        break
      case "error":
        console.error(`Error: ${event.error.message}`)
        break
    }
  }

  return session
}
```

### 5.1 System Prompt 加载

```typescript
// src/prompt/system.ts
import { readFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

function findProjectRoot(startDir: string): string {
  let dir = startDir
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, "package.json"))) return dir
    dir = dirname(dir)
  }
  return startDir
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = findProjectRoot(currentDir)

export async function loadSystemPrompt(): Promise<string> {
  const promptPath = resolve(projectRoot, "specs/0001-system.md")
  return readFile(promptPath, "utf-8")
}
```

**关键决策：**
- 通过向上查找 `package.json` 定位项目根目录，而非硬编码相对路径
- 在 `src/prompt/system.ts`（开发模式）和 `dist/index.js`（打包后）两种路径下都能正确工作

---

## 6. 安全边界

本系统采用**双层防御**：System prompt 作为第一道防线引导 LLM 正确行为，代码层安全检查作为第二道防线兜底。

| 风险 | System Prompt 防御（第一层） | 代码防御（第二层） |
|------|---------------------------|-------------------|
| 路径穿越 | 告知 LLM "路径穿越会被拒绝" | `resolve()` 前缀检查 + `realpath()` 解析符号链接后二次检查 |
| Shell 注入 | 未覆盖（LLM 不了解底层实现） | `git`/`gh` 使用 `execFile` 不经过 shell；`bash` 工具经过 shell 但受白名单限制 |
| Git 写操作 | 告知 LLM "git 是只读的，写操作会被拦截" | `git` 工具黑名单拦截 `push`、`commit`、`reset` 等 |
| GitHub 写操作 | 告知 LLM "gh 是只读的，写操作会被拦截" | `gh` 工具白名单：`pr`/`issue` 子命令白名单 + `api` 拦截非 GET 方法 |
| Bash 危险命令 | 告知 LLM "bash 只允许白名单命令，写操作会被拦截" | `bash` 工具白名单限制 30 个只读命令，拦截 `rm`/`mv`/`curl` 等，拦截 `sed -i` |
| 大输出 OOM | 未覆盖 | `maxBuffer` 限制 10MB，`timeout` 30 秒 |
| LLM 修改源代码 | 明确禁止："Never use `write_file` on source files" | 不做代码层限制（保留写报告的灵活性） |
| LLM 无限循环 | 未覆盖 | `maxSteps` 限制（默认 50） |

---

## 7. 典型执行流程

> **注意：** 以下流程描述的是 LLM 的决策过程，不是 agent 代码中的逻辑。Agent 代码只负责执行 LLM 发出的工具调用。LLM 根据 system prompt 中的指引自主决定调用顺序，实际执行可能与以下示例有所不同。

### 场景 A：review 当前 branch 新代码

```
用户: "帮我 review 当前 branch 新代码"

                        ┌─────────────────────────────────────┐
                        │  LLM 读取 system prompt 中            │
                        │  "Determining what to review" 第 5 条  │
                        │  → 决定获取当前分支名，对比默认分支      │
                        └──────────────┬──────────────────────┘
                                       │
                                       ▼
1. LLM 调用 → git({ command: "rev-parse --abbrev-ref HEAD" })
   agent 执行 → "feature/add-auth"

2. LLM 调用 → git({ command: "diff --name-only main...HEAD" })
   agent 执行 → "src/auth/handler.ts\nsrc/auth/middleware.ts\nsrc/types.ts"

3. LLM 调用 → git({ command: "diff main...HEAD" })
   agent 执行 → [完整 diff]

4. LLM 调用 → read_file({ path: "AGENTS.md" })
   agent 执行 → [项目约定] 或 [错误: 文件不存在]

5. LLM 调用 → read_file({ path: "src/auth/handler.ts" })
   agent 执行 → [完整文件内容]

6. LLM 调用 → read_file({ path: "src/auth/middleware.ts" })
   agent 执行 → [完整文件内容]

7. LLM 输出 → 结构化 review 报告（格式由 system prompt 定义）
```

### 场景 B：review commit 之后的代码

```
用户: "帮我 review commit 13b23d 之后的代码"

  LLM 匹配 system prompt 中 "since <commit>" 模式 → 决定用 diff <commit>..HEAD

1. LLM 调用 → git({ command: "log --oneline 13b23d..HEAD" })
   agent 执行 → [commit 列表]

2. LLM 调用 → git({ command: "diff 13b23d..HEAD" })
   agent 执行 → [完整 diff]

3. LLM 调用 → git({ command: "diff --name-only 13b23d..HEAD" })
   agent 执行 → [变更文件列表]

4. LLM 逐个调用 → read_file({ path: "..." })
   agent 逐个执行 → [完整文件内容]

5. LLM 输出 → 结构化 review 报告
```

### 场景 C：review pull request

```
用户: "帮我 review pull request 12"

  LLM 匹配 system prompt 中 "PR number" 模式 → 决定用 gh 获取 PR 信息

1. LLM 调用 → gh({ command: "pr view 12" })
   agent 执行 → [PR 标题、描述、作者、关联 issue]

2. LLM 调用 → gh({ command: "pr diff 12" })
   agent 执行 → [完整 diff]

3. LLM 调用 → gh({ command: "pr diff 12 --name-only" })
   agent 执行 → [变更文件列表]

4. LLM 逐个调用 → read_file({ path: "..." })
   agent 逐个执行 → [完整文件内容]

5. LLM 输出 → 结构化 review 报告
```

### 场景 D：工具报错后的 LLM 自主恢复

```
用户: "帮我 review 当前 branch 新代码"

1. LLM 调用 → git({ command: "diff main...HEAD" })
   agent 执行 → 错误: "fatal: bad revision 'main...HEAD'"

  LLM 读取错误信息 → 推断仓库默认分支可能是 master 而非 main

2. LLM 调用 → git({ command: "diff master...HEAD" })
   agent 执行 → [完整 diff]

  正常继续 review 流程...
```

**以上场景说明：** Agent 代码中没有任何 `if (input.includes("PR"))` 或 `if (defaultBranch === "master")` 这样的逻辑。所有分支判断都由 LLM 根据 system prompt 的指引自主完成。

---

## 8. 配置

```typescript
// src/config.ts
export interface AppConfig {
  model: string
  maxSteps: number
  apiKey?: string
  baseURL?: string
}

export const defaultConfig: AppConfig = {
  model: "claude-sonnet-4-6",
  maxSteps: 50,
}
```

**`maxSteps` 为什么是 50：**
- 典型 review 流程：1 次 diff + 1 次文件列表 + N 次 read_file + 若干 git log/blame ≈ 10–30 步
- 50 步为合理上限，允许处理大型 PR（10+ 文件）同时防止无限循环
- 可通过配置覆盖

---

## 9. 实现计划

| 阶段 | 任务 | 产出 |
|------|------|------|
| **P0** | 项目初始化：`package.json`、`tsconfig.json`、依赖 `simple-agent` | 可编译的空项目 |
| **P0** | 实现五个工具：`read_file`、`write_file`、`git`、`gh`、`bash` | `src/tools/*.ts` |
| **P0** | 实现 system prompt 加载和入口 | `src/prompt/system.ts`、`src/index.ts` |
| **P0** | CLI 入口：接受用户输入，启动 agent | 可运行的 CLI |
| **P1** | 工具单元测试：路径穿越、命令拦截、正常执行 | `tests/tools/*.test.ts` |
| **P1** | 集成测试：在真实仓库上运行 review 场景 | `tests/integration/` |
| **P2** | 输出报告持久化：将 review 结果写入文件 | `write_file` 场景验证 |
| **P2** | 流式输出美化：工具调用状态提示 | 用户体验优化 |
