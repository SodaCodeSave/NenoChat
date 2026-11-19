export interface GitInfo {
  exactTag: string
  latestTag: string
  shortHash: string
}

export interface VersionInfo {
  appVersion: string
  minClientVersion: string
  packageVersion: string
  shortHash: string
  exactTag: string
  latestTag: string
}

export function readGitInfo(run?: (args: string[]) => string): GitInfo

export function resolveVersion(options?: {
  env?: Record<string, string | undefined>
  gitInfo?: GitInfo
}): VersionInfo
