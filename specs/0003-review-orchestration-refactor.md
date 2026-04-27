# Code Review Agent 重构方案

## 1. 背景

当前项目采用“system prompt 定义几乎全部行为，LLM 自主决定 review 流程”的方案。这个方向在原型阶段是可行的，但从当前实现和实际运行结果来看，已经暴露出明显问题：

- `review 当前分支代码` 这类常见输入会进入反复探测 `git status`、`git log`、`git show` 的循环，迟迟不输出 review 结果
- 入口代码已经不得不补充上下文注入、重复调用检测等编排逻辑，说明“代码完全无智能”的前提无法成立
- `write_file` 仍然可以覆盖仓库内任意文件，关键安全约束仅依赖 prompt，不够稳健
- `git` / `gh` 的输入解析过于宽松，会静默容忍无效 shell 风格命令，导致模型不断试错

因此需要将架构从“LLM 驱动全部控制流”调整为“代码负责编排与边界控制，LLM 负责审查判断与报告生成”。

---

## 2. 重构目标

### 2.1 目标

1. 让常见 review 场景具备确定性执行路径，而不是依赖模型临场摸索
2. 将“目标解析、diff 收集、停止条件、安全边界”收回到代码层
3. 保留 LLM 在代码理解、风险判断、review 表达上的优势
4. 降低无效工具调用和 token 消耗
5. 让设计文档、实现、运行行为重新一致

### 2.2 非目标

- 不把 code review 结果规则硬编码成静态 lint
- 不引入任意 shell 执行
- 不扩展为自动修复 agent
- 不在本次重构中引入测试/构建执行能力

---

## 3. 新的职责边界

### 3.1 职责划分原则

> **LLM 负责语义归类，代码负责 schema 校验与最终 target 决策。**

Target 解析流程：LLM 将自然语言归类为 `ReviewTarget` JSON → 代码做 schema 校验 → 校验失败则报错退出 → 校验通过后代码全权执行数据收集。

### 3.2 代码层负责

- 调用 LLM 解析用户输入，校验返回的 `ReviewTarget` 是否合法
- 根据合法的 `ReviewTarget` 选择确定性的 diff 获取策略
- 收集必要上下文（变更文件全文、约定文件）
- 裁剪并组织给 LLM 的输入材料
- 控制工具能力与调用预算
- 强制执行终止条件

### 3.3 LLM 负责

- 将用户自然语言归类为结构化 `ReviewTarget`（一次廉价调用，代码做最终校验）
- 理解 diff 与上下文代码
- 识别 bug、回归风险、边界条件问题
- 判断问题严重度与置信度
- 必要时通过 `read_file` 或 `git`（只读）补充查询
- 生成结构化 review 输出

---

## 4. 核心架构调整

### 4.1 从自由 agent loop 改为”编排 + 有限 loop”

当前结构：

```text
用户输入 -> LLM -> 工具调用 -> LLM -> 工具调用 -> ... -> 输出
          (LLM 自由决定调什么工具、什么时候停)
```

重构后结构：

```text
用户输入
  -> LLM Target Parse（一次廉价调用，解析意图为结构化 JSON）
  -> 代码根据 ReviewTarget 执行确定性收集（git diff / gh pr diff / read_file）
  -> 组装 ReviewContext
  -> Agent Loop（LLM 审查 + 可选补充查询 read_file / git blame 等）
  -> stdout 输出
```

关键变化：
- **Target 解析由 LLM 完成**（利用语言理解能力），但只做一次廉价调用，输出结构化 JSON
- **数据收集由代码完成**（确定性、不依赖 LLM 决策）
- **审查判断仍在 agent loop 中**，LLM 拿到预组装的完整上下文后进行审查，必要时可通过工具补充查询

### 4.2 执行流程

1. 用户输入传给 LLM，解析为结构化 `ReviewTarget`（一次调用）
2. 代码根据 `ReviewTarget` 类型执行固定的 `git` / `gh` 收集流程
3. 代码提取变更文件列表，读取文件全文与约定文件
4. 代码组装 `ReviewContext`，格式化为结构化文本
5. 将 `ReviewContext` 作为用户消息注入 agent loop
6. LLM 在 agent loop 中审查代码，可选调用 `read_file`、`git` 补充上下文
7. LLM 输出 review 结果到 stdout

---

## 5. Review Target 显式建模

新增 `ReviewTarget` 概念。LLM 将用户自然语言归类为结构化 JSON，代码做 schema 校验后决定执行路径。

```ts
type ReviewTarget =
  | { type: "working-tree" }
  | { type: "staged" }
  | { type: "current-branch" }
  | { type: "commit"; commit: string }
  | { type: "commit-range"; from: string; to: "HEAD" }
  | { type: "pull-request"; prNumber: number }
  | { type: "file"; paths: string[] }
```

### 5.1 LLM 解析

Target 解析通过一次 LLM 调用完成，利用 LLM 的自然语言理解能力处理中英文混合、模糊表述等情况。

**解析 prompt 示例：**

```text
Parse the following user input into a structured review target.

User input: "{userInput}"

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
- "暂存区" / "staged" -> staged
- No arguments / "未提交改动" / "uncommitted changes" -> working-tree
- PR / pull request / # followed by number -> pull-request
- commit hash (7-40 hex chars) alone -> commit
- "since/after <hash>" / "<hash> 之后" -> commit-range
- file paths (containing . or /) -> file
- If the input is ambiguous and you cannot confidently classify it, respond with: { "error": "ambiguous input" }

Respond ONLY with the JSON object, no other text.
```

**调用方式：**
- 使用 `simple-agent` 的 `callLLM` 接口（单次非流式调用）
- 可用与主审查相同的模型，也可配置为更轻量的模型
- `maxTokens` 设为 100（输出很短），降低成本
- 将 LLM 返回的文本 `JSON.parse` 为 `ReviewTarget`

### 5.2 解析失败策略

对 code review 这种强 scope 任务，解析失败不能 fail-open（静默降级到错误的 review 范围比不 review 更危险）。

若 LLM 返回无效 JSON 或不符合 schema：

- **直接报错退出**，不做 fallback
- 在 stderr 输出明确的错误信息，包含：原始用户输入、LLM 返回的原始文本、期望的 JSON 格式
- 提示用户用更明确的表述重试，例如："请指定 review 目标：`review current branch`、`review PR 42`、`review commit abc1234`"

若 LLM 返回合法 JSON 但 schema 校验失败（如 `commit` 类型缺少 `commit` 字段）：

- 同样报错退出，不猜测用户意图

---

## 6. 确定性的上下文收集策略

### 6.0 `working-tree`

固定执行：

- `git diff`（unstaged 改动）
- `git diff --cached`（staged 改动）
- 两者取并集作为 review 范围
- 若两者都为空：**直接报告"没有未提交的改动"并退出**，不 fallback 到 review HEAD 或其他 scope

### 6.0.1 `staged`

固定执行：

- `git diff --cached`（仅 staged 改动）
- 若为空：**直接报告"暂存区没有待审查的改动"并退出**

与 `working-tree` 的区别：`staged` 只看 `--cached`，不包含 unstaged 改动。

### 6.0.2 `commit`

固定执行：

- `git show <hash>`（获取该 commit 的 diff 和 commit message）
- 若 `git show` 失败（如 hash 不存在）：按 6.6 git 错误分类处理
- 若 `git show` 结果中不包含 patch 内容：报告"指定 commit 没有可审查的代码差异：`<hash>`"并退出

`git show` 同时返回 commit metadata 和 diff，不需要额外调用 `git diff`。

### 6.1 `current-branch`

执行逻辑：

1. 获取当前分支名
2. 若分支为 `main` 或 `master`（即默认分支）：
   - 退化为 `working-tree` 的行为：获取 unstaged + staged diff
   - 若两者都为空：**直接报告”当前分支没有待审查的改动”并退出**，不 fallback 到 review HEAD。用户要求的是”当前分支代码”，不是”最近一次提交”，这两者语义不同。
3. 若分支不是默认分支：
   - 检测默认基线分支，优先 `main`，其次 `master`
   - 执行 `git diff <base>...HEAD`
   - 若 diff 为空：报告”当前分支相对 `<base>` 没有差异”并退出

### 6.2 `commit-range`

固定执行：

- `git log --oneline <from>..HEAD`
- `git diff <from>..HEAD`
- 若 diff 为空：报告"`<from>..HEAD` 之间没有代码差异"并退出。即使 commit log 非空（如仅有 merge commit 或 revert），只要 diff 为空就视为无审查内容。`ReviewContext` 不允许"无 diff 但有 commit 列表"的状态进入 LLM 审查阶段

### 6.3 `pull-request`

固定执行：

- `gh pr view <number>`
- `gh pr diff <number>`
- **不调用** `gh pr checks <number>`

说明：

- `gh pr checks` 不属于审查代码差异的必需上下文
- 为保持数据收集阶段的确定性和低延迟，本次重构中固定不收集 checks 信息
- 如果未来确实需要将 CI 状态纳入审查上下文，应通过显式配置项引入，而不是让实现层自行决定是否调用

**gh 失败分类：**

以下错误直接报用户可理解的信息并退出：

| 错误类型 | 识别方式 | 报错信息 |
|---------|---------|---------|
| PR 不存在 | stderr 含 `not found` / exit code 1 | "PR #N 不存在" |
| gh 未登录 | stderr 含 `auth login` | "GitHub CLI 未登录，请先运行 `gh auth login`" |
| 非 GitHub 仓库 | stderr 含 `not a git repository` 或无 remote | "当前目录不是 GitHub 仓库" |
| 权限不足 | stderr 含 `403` / `forbidden` | "没有权限访问该 PR" |

其余错误（网络超时、未知 stderr）：包装原始 stderr 后退出，格式为 `"gh 命令失败: <原始 stderr>"`。不做猜测性重试。

### 6.4 `file`

固定执行：

- `git diff -- <path>`
- `git diff --cached -- <path>`
- 若两者都为空：报告"指定文件没有待审查的改动：`<path>`"并退出，不 fallback 到读取文件全文或切换 scope

### 6.5 git 失败分类

与 6.3 的 gh 失败分类对等，git 命令失败时的处理规则：

| 错误类型 | 识别方式 | 报错信息 |
|---------|---------|---------|
| 无效 revision | stderr 含 `bad revision` 或 `unknown revision` | "无效的 commit 引用：`<ref>`" |
| 歧义引用 | stderr 含 `ambiguous argument` | "歧义的 git 引用：`<ref>`，请提供更精确的 commit hash" |
| 非 git 仓库 | stderr 含 `not a git repository` | "当前目录不是 git 仓库" |
| 基线分支不存在 | `git rev-parse --verify main` 和 `master` 都失败 | "找不到默认分支（main 或 master）" |

其余错误：包装原始 stderr 后退出，格式为 `"git 命令失败: <原始 stderr>"`。不做猜测性重试。

### 6.6 统一收集产物

代码层产出统一结构：

```ts
interface ReviewContext {
  target: ReviewTarget
  summary: {
    branch?: string
    baseBranch?: string
    recentCommits?: string
    statusShort?: string
    prMetadata?: string
    commitMetadata?: string
  }
  diffs: Array<{
    source: "git" | "gh"
    label: string
    content: string
  }>
  changedFiles: string[]
  files: Array<{
    path: string
    content: string
  }>
  omittedFiles: Array<{
    path: string
    reason: "filtered" | "budget" | "read-error"
    detail?: string
  }>
  conventions: Array<{
    path: string
    content: string
  }>
}
```

LLM 接收到的是这个结构化上下文，而不是自己再去四处探路。

字段口径：

- `changedFiles[]` 保留**全部变更文件路径**，按去重后的路径字典序排列
- `files[]` 仅包含实际读取了全文的文件
- `omittedFiles[]` 记录未读取全文的变更文件及原因
- `summary.commitMetadata` 仅用于 `commit` target，承载 `git show <hash>` 返回的 commit message / author / date 等元信息

---

## 7. 文件上下文收集策略

### 7.1 changed files 提取

不要让 LLM 自己从大 diff 中反复猜文件名。代码层直接执行：

- `git diff --name-only ...`
- 或从统一 diff 文本中解析 `+++ b/...` / `diff --git a/... b/...`

规则：

- 提取后的路径先去重
- 去重后按路径字典序（locale-insensitive）排序
- `changedFiles[]` 始终记录这个完整结果，不受 7.2 的过滤和预算影响

### 7.2 文件读取预算

避免一次性把大量文件全文塞给模型。规则：

- 默认最多读取 `N=20` 个变更文件
- 单文件截断规则：
  - 按**字节**计量，阈值 50KB
  - 截断位置：回退到最近一个完整的换行符（`\n`），避免切断多字节字符或代码行
  - 在截断后的内容末尾追加 `\n[truncated at 50KB]` 标记文本
  - 不需要 `ReviewContext.files[].truncated` 字段——LLM 直接从内容文本中识别截断标记

**排序与过滤规则（确定性）：**

1. 先过滤：跳过以下文件（不计入 N）
   - lockfile：`pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`Gemfile.lock` 等
   - 二进制文件：图片、字体、编译产物
   - 大型生成文件：`.min.js`、`.min.css`、`.map`、`dist/` 下文件
2. 过滤后的文件按**路径字典序（locale-insensitive）**排序
3. 取前 N 个

字典序保证排序结果在任何环境下一致，测试可复现。不做优先级排序——复杂度高、维护成本大，且 20 个文件的预算足以覆盖绝大多数 review 场景。

**文件全部被过滤但 diff 非空：** 即使所有变更文件都被过滤规则跳过（如只改了 lockfile），只要 diff 非空，仍进入 LLM 审查阶段。此时 `ReviewContext.files[]` 为空，被过滤的文件记入 `omittedFiles[]`（reason: `"filtered"`）。LLM 将基于 diff 内容进行审查，上下文中会标注"以下文件因过滤规则未读取全文"。

### 7.3 约定文件收集

代码层固定查找：

- 仓库根目录：`AGENTS.md`、`CONVENTIONS.md`、`.editorconfig`
- 变更文件所在目录向上查找最近的 `AGENTS.md` / `CONVENTIONS.md`

去重规则：

- `conventions[]` 按文件真实路径去重，同一文件最多收集一次
- 去重后按路径字典序排列，保证上下文顺序稳定

这样既保留约定感知，又避免 LLM 盲目试读不存在的文件和重复约定文本。

---

## 8. 工具层重构

### 8.1 `read_file`

保留。两个使用场景：

1. **代码层内部调用**：`build-context.ts` 中读取变更文件全文和约定文件
2. **LLM 补充查询**：在 agent loop 中，LLM 可能需要读取额外文件（如 import 的模块、类型定义等）

建议新增能力：

- 内部截断能力：按字节截断（阈值 50KB），回退到最近换行符，末尾追加 `\n[truncated at 50KB]`
- 与 7.2 节截断规则一致，不需要额外的 `truncated` 字段

### 8.2 `write_file`

**移除。** Review 结果通过 stdout 直接输出，不需要写入文件。

- 删除 `src/tools/write-file.ts`
- 删除 `tests/tools/write-file.test.ts`
- 从 `index.ts` 的工具注册中移除
- 从 system prompt 中移除相关说明

如果未来有持久化需求（如写入 review 报告），由调用方在 agent 外部处理（如重定向 stdout）。

### 8.3 `git`

建议区分两层：

1. 内部代码调用：直接用受控参数数组，不走自由字符串
2. LLM 工具调用：若保留，必须更严格限制

若仍保留字符串命令接口，必须修改：

- 遇到 `|`、`>`, `<`、明显 shell 风格输入时直接报错
- 遇到未知顶层子命令时直接报错
- 不再静默清洗非法输入

### 8.4 `gh`

保持白名单思路，但同样建议：

- 内部代码走受控参数数组
- LLM 若可调用，仅保留极少量只读能力

---

## 9. Prompt 重构

### 9.1 Prompt 职责缩小

新的 system prompt 不再负责：

- 解析用户 review target
- 决定先跑哪些 git/gh 命令
- 推断何时应该停止继续探测
- 写入 review 报告文件

新的 system prompt 只负责：

- 如何审查给定 diff 和文件上下文
- 如何判定问题是否成立
- 如何组织 review 输出
- 如何表达置信度和不确定性
- 何时需要补充查询（通过 `read_file`、`git blame` 等工具）

**可用工具缩减为：** `read_file`、`git`（只读）、`gh`（只读）。不再有 `write_file` 和 `bash`。

### 9.2 Prompt 输入形式

代码层将 `ReviewContext` 组织为结构化文本段落，作为用户消息注入 agent loop：

```text
[Review Target]
current-branch

[Repository Summary]
Current branch: feature/add-auth
Base branch: main
Uncommitted changes: none

[Changed Files]
- src/auth/handler.ts
- src/auth/middleware.ts
- src/types.ts

[Diff]
diff --git a/src/auth/handler.ts b/src/auth/handler.ts
...

[File: src/auth/handler.ts]
(完整文件内容)

[File: src/auth/middleware.ts]
(完整文件内容)

[Conventions: AGENTS.md]
(约定文件内容，若存在)
```

LLM 拿到这些预组装的上下文后，直接开始审查。如果需要更多信息（如被 import 的模块、git blame），可在 agent loop 中调用工具补充。

---

## 10. 停止条件与失败策略

### 10.1 停止条件

数据收集阶段由代码控制，有确定性的结束点：

- diff 已收集完成
- 文件上下文已达到预算（默认 20 个文件）
- `ReviewContext` 组装完毕

Agent loop 阶段由 `maxSteps` 限制：

- LLM 审查完成后自然停止（不发起工具调用）
- 补充查询受 `maxSteps` 限制（建议设为 20，远少于当前的 50）
- 由于上下文已预组装，LLM 通常只需 0-5 次补充查询即可完成审查

### 10.2 失败策略

以下为总原则。第 6 节各 target 定义的 target-specific 错误信息优先于此处的通用描述。

- 无 diff：使用第 6 节中对应 target 的专用退出消息（如 `working-tree` 用”没有未提交的改动”，`file` 用”指定文件没有待审查的改动：`<path>`”）
- `git` 失败：按 6.5 定义的错误分类表处理
- `gh` 失败：按 6.3 定义的错误分类表处理
- 文件读取失败：记入 `ReviewContext.omittedFiles[]`（reason: `”read-error”`，detail: 错误信息），继续对其余文件审查
- 超出预算：超出 N=20 的文件记入 `omittedFiles[]`（reason: `”budget”`），上下文中标注”以下文件因数量限制未读取全文”

---

## 11. 推荐目录结构

```text
src/
├── index.ts              # 入口：CLI 参数解析，串联 parse-target -> build-context -> agent loop
├── config.ts             # 配置：模型、max steps 等
├── prompt/
│   └── system.ts         # 加载审查 system prompt（职责缩小后的版本）
├── review/
│   ├── types.ts          # ReviewTarget、ReviewContext 类型定义
│   ├── parse-target.ts   # LLM 调用：用户输入 -> ReviewTarget JSON
│   └── build-context.ts  # 确定性收集：ReviewTarget -> ReviewContext（diff、文件、约定）
└── tools/
    ├── read-file.ts      # read_file：供代码层和 LLM 补充查询
    ├── git.ts            # git：只读，供代码层和 LLM 使用
    ├── gh.ts             # gh：只读，供代码层和 LLM 使用
    └── parse-command.ts  # 命令解析工具（供 git/gh 使用）
```

要点：

- `review/` 只有 3 个文件，职责清晰：类型、解析、收集
- `tools/` 不再有 `write-file.ts`
- `prompt/` 只提供审查指令，不再定义 target 解析和工具规划

---

## 12. 分阶段实施计划

### Phase 1: 核心编排层

目标：实现 `review/` 模块，让 review 有确定性的数据收集路径。

实施项：

- 新增 `src/review/types.ts`：定义 `ReviewTarget` 和 `ReviewContext` 类型
- 新增 `src/review/parse-target.ts`：通过一次 LLM 调用解析用户输入为 `ReviewTarget`
- 新增 `src/review/build-context.ts`：根据 `ReviewTarget` 执行确定性的 git/gh 收集，读取变更文件和约定文件，组装 `ReviewContext`
- 改造 `src/index.ts`：串联 parse-target → build-context → agent loop
- 移除 `write_file` 工具（删除 `src/tools/write-file.ts` 和对应测试）

### Phase 2: 重写 system prompt

目标：缩小 prompt 职责，聚焦审查判断。

实施项：

- 重写 `specs/0001-system.md`
- 删除 target 解析规则、工具规划策略、停止条件等编排逻辑
- 聚焦：审查原则、证据要求、输出格式、补充查询指引
- 移除 `write_file` 相关说明
- 可用工具缩减为：`read_file`、`git`、`gh`

### Phase 3: 收紧工具边界

实施项：

- `git` / `gh` 拒绝非法 shell 风格输入（含 `|`、`>`、`<` 直接报错）
- 删除静默”修正输入”的行为
- 将代码层内部的 git/gh 调用改为参数数组接口（不走字符串解析）

### Phase 4: 测试

实施项：

- 为 `parse-target` 增加单测（mock LLM 返回，测试各种 target 类型、schema 校验失败报错退出、无效 JSON 报错退出）
- 为 `build-context` 增加场景测试（current-branch on main、feature branch、commit-range、PR、file）
- 为”无变更””gh 不可用””LLM 解析失败”增加失败路径测试
- 端到端冒烟测试：在真实仓库上运行 review，验证能输出结论

---

## 13. 风险与权衡

### 13.1 优点

- 行为更稳定、可预测——常见场景有确定性执行路径
- 更易测试——target 解析和 context 收集可独立单测
- token 成本更低——上下文预组装，LLM 通常只需 0-5 次补充查询
- 工具安全边界更明确——移除 write_file，减少攻击面
- LLM 仍保留灵活性——agent loop 允许补充查询

### 13.2 代价

- 代码量会增加（新增 `review/` 模块约 3 个文件）
- target 解析多一次 LLM 调用（但 maxTokens 很低，成本可忽略）
- 需要维护 context builder 中各 target 类型的收集逻辑

### 13.3 判断

这个代价是值得的。因为 code review agent 的核心价值不是”像通用代理一样自由探索”，而是”稳定地拿到正确上下文，并输出可靠审查意见”。

---

## 14. 最终建议

放弃”system prompt 是唯一行为来源”这一绝对表述，改为以下原则：

> Code Review Agent 采用分层设计：
> - **LLM 负责意图理解**（target 解析）和**代码审查判断**（review 输出）
> - **代码负责确定性编排**（数据收集、上下文组装）和**安全控制**（工具白名单、调用预算）
> - **Agent loop 提供灵活性**——LLM 在预组装上下文基础上，仍可通过工具补充查询

这是一个更符合工程现实、也更适合长期演进的架构。LLM 做它擅长的事（理解语言、分析代码），代码做它擅长的事（确定性流程、安全边界）。
