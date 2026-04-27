export type ReviewTarget =
  | { type: "working-tree" }
  | { type: "staged" }
  | { type: "current-branch" }
  | { type: "commit"; commit: string }
  | { type: "commit-range"; from: string }
  | { type: "pull-request"; prNumber: number }
  | { type: "file"; paths: string[] }

export interface ReviewContext {
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
