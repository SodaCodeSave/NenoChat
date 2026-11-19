import { readGitInfo, resolveVersion } from '../../../scripts/version.mjs'

const info = resolveVersion({ env: process.env, gitInfo: readGitInfo() })

/** 服务端版本，随 git tag 或提交变化；容器部署时由 APP_VERSION 注入 */
export const APP_VERSION = info.appVersion

/** 客户端最低可接受版本，跟随 tag；无 tag 时沿用最近 tag */
export const MIN_CLIENT_VERSION = info.minClientVersion
