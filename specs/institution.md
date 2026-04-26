# Institutions

## 系统提示生成

based on @specs/prompts/codex.txt and @specs/prompts/reviewer.txt ,think hard,we want to generate a system prompt for code review agent which is based on ../simple-agent.The code review agent will only have read file / wirte file / git command tool so make sure system prompt don't mention unexisting stuff.And make sure system prompt focused on code review but have all the goot parts of @specs/prompts/codex.txt.Write the prompts down to ./specs/0001-system.md.Think ultra hard.

## 构建 code review agent design spec

根据 @specs/0001-system.md 文档，以及 ../simple-agent 代码，构建一个 code review agent。它包含这些工具：
- read file: 读取当前目录下某个文件的内容
- write file: 写入当前目录下某个文件的内容
- git command: 执行 git 命令，尤其是可以根据用户的各种需求，找到合适的 git diff，包括但不限于： branch diff,unstaged diff,staged diff,commit ,diff,pull request diff 等。
- gh command: 执行 gh 命令，尤其是可以根据用户的各种需求，找到合适的 gh 命令，包括但不限于: pr review,pr diff 等

这些工具的使用方法，相关的例子都要更新在 ./specs/0001-system.md 文档中，这样 LLM 可以很方便的使用这些工具。

用户可以这样使用 code review agent:
- 帮我 review 当前 branch 新代码
- 帮我 review commit 13b23d 之后的代码
- 帮我 review pull request 12 的代码

仔细考虑这些需求，构建一个 SOLID 的设计文档，放在 ./specs/0002-code-review-agent-design.md 文件中，使用中文输出。

整个过程是由 LLM 驱动，agent 只是提供合适的 system prompt 和合适的 tools

system prompt 定义 code review 流程相关的所有行为规范

## 构建 code review agent

根据 @specs/0002-code-review-agent-design.md 文档，实现 code review agent 代码，使用 ../simple-agent 作为 dependency，代码要完整实现 design spec，符合其要求
