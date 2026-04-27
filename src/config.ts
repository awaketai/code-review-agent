export interface AppConfig {
  model: string
  maxSteps: number
  apiKey?: string | undefined
  baseURL?: string | undefined
}

export const defaultConfig: AppConfig = {
  model: "claude-sonnet-4-6",
  maxSteps: 20,
}
