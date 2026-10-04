/**
 * dsh-mail-notify：agent 每结束一轮回答，就发一封通知邮件。
 *
 * 本包以 bundle 形式装进 dsh profile（`dsh.profile.bundles` + `link:` 依赖），
 * 由同目录的 `cordis.patch.yml` 插入一行。它是纯 ESM、零依赖的：SMTP 见
 * `smtp.mjs`，邮件组装见 `mime.mjs`，都不引用任何 harness 包或第三方包。
 *
 * 触发点是每一条 `turn/end`（一轮回答结束），正文取该轮最后一条助手消息的文本，
 * 标题在固定前缀之后带上这轮回答的摘要（首个标题或首行，可用 `subjectSummary` 关掉）。
 *
 * @module dsh-mail-notify
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ImapClient } from './imap.mjs'
import { stripQuotedText } from './mail.mjs'
import { buildMessage } from './mime.mjs'
import {
  buildCreatePrompt,
  buildCreateTitle,
  buildPrompt,
  buildTitle,
  createToken,
  DEFAULT_CREATE_SUBJECTS,
  formatCreateSubjects,
  normalizeState,
  pickTarget,
  pollOnce,
  recordNotification,
  scanRecord,
  sessionTokenFooter,
  stripTokenLines,
} from './reply.mjs'
import { sendMail } from './smtp.mjs'
import {
  buildPickPrompt,
  completeOnce,
  matchWorkspace,
  normalizeCandidates,
  parsePick,
  WORKSPACE_PICK_SYSTEM,
} from './workspace.mjs'

/** 稳定的 Cordis 插件名。 */
export const name = 'mail-notify'

/** 本模块所在目录；相对路径的授权码文件以它为基准。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 按**发件**邮箱域名推断的 SMTP 端点。
 *
 * 发信服务器只由发件账号决定，与收件人域名无关：收件人可以是 qq.com，也可以是
 * 任意其他域名，不需要在这里登记。`secure: true` 表示 465 隐式 TLS，
 * `false` 表示 587 等端口上的 STARTTLS。
 */
const SMTP_PRESETS = {
  'qq.com': { host: 'smtp.qq.com', port: 465, secure: true },
  'vip.qq.com': { host: 'smtp.qq.com', port: 465, secure: true },
  'foxmail.com': { host: 'smtp.qq.com', port: 465, secure: true },
  '163.com': { host: 'smtp.163.com', port: 465, secure: true },
  '126.com': { host: 'smtp.126.com', port: 465, secure: true },
  'yeah.net': { host: 'smtp.yeah.net', port: 465, secure: true },
  'sina.com': { host: 'smtp.sina.com', port: 465, secure: true },
  '139.com': { host: 'smtp.139.com', port: 465, secure: true },
  'aliyun.com': { host: 'smtp.aliyun.com', port: 465, secure: true },
  'gmail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
  'outlook.com': { host: 'smtp.office365.com', port: 587, secure: false },
  'hotmail.com': { host: 'smtp.office365.com', port: 587, secure: false },
  'live.com': { host: 'smtp.office365.com', port: 587, secure: false },
  'icloud.com': { host: 'smtp.mail.me.com', port: 587, secure: false },
  'me.com': { host: 'smtp.mail.me.com', port: 587, secure: false },
}

/** 默认主题（**全部结束**那一封的前缀）。 */
const DEFAULT_SUBJECT = 'DSH 任务完成'

/**
 * 默认主题前缀（**中间某一轮结束**时用的）。
 *
 * 一个任务常常要连跑好几轮（`while (await turn())` 不会中途回到 idle），所以邮件分两种：
 * 中途那几轮用「进行中」，整段跑完（agent 变 idle）那一封用「完成」。两者标题前缀不同，
 * 收件箱里一眼能分出哪封才是真的结束了。
 */
const DEFAULT_SUBJECT_PROGRESS = 'DSH 任务进行中'

/**
 * 按**发件**邮箱域名推断的 IMAP 端点，用于「收信触发」。
 *
 * 与 SMTP 一样只由发件账号决定；不支持 STARTTLS 的服务器不要写在这里，
 * 因为 `secure: false` 时客户端会强制要求 STARTTLS，绝不明文发授权码。
 */
const IMAP_PRESETS = {
  'qq.com': { host: 'imap.qq.com', port: 993, secure: true },
  'vip.qq.com': { host: 'imap.qq.com', port: 993, secure: true },
  'foxmail.com': { host: 'imap.qq.com', port: 993, secure: true },
  '163.com': { host: 'imap.163.com', port: 993, secure: true },
  '126.com': { host: 'imap.126.com', port: 993, secure: true },
  'yeah.net': { host: 'imap.yeah.net', port: 993, secure: true },
  'sina.com': { host: 'imap.sina.com', port: 993, secure: true },
  '139.com': { host: 'imap.139.com', port: 993, secure: true },
  'aliyun.com': { host: 'imap.aliyun.com', port: 993, secure: true },
  'gmail.com': { host: 'imap.gmail.com', port: 993, secure: true },
  'outlook.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'hotmail.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'live.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'icloud.com': { host: 'imap.mail.me.com', port: 993, secure: true },
  'me.com': { host: 'imap.mail.me.com', port: 993, secure: true },
}

/** 关键字可以出现的位置。 */
const KEYWORD_SCOPES = ['subject', 'body', 'either']

/** 邮件投递到哪儿：追加到该通知所属会话，还是每次新建会话。 */
const REPLY_MODES = ['append', 'new']

/**
 * `reply.cwd` 的 `auto` 取值：新会话的工作目录按邮件内容挑（见 `workspace.mjs`）。
 *
 * 挑不出来时退回「最近一次发过通知的会话目录」，也就是 `last` 的行为——所以它是
 * `last` 的超集，默认就用它。
 */
const CWD_AUTO = 'auto'

/** `reply_status` 里最多列几条「最近一次轮询」的逐封判定。 */
const STATUS_DECISIONS = 5

/** 主题后缀：非正常结束时把真实结果写进主题，避免「任务完成」四个字误导人。 */
const REASON_SUFFIX = {
  completed: '',
  aborted: '（已取消）',
  blocked: '（已阻塞）',
  error: '（出错）',
  'max-tokens': '（输出达到上限）',
  interrupted: '（被中断）',
  forked: '（已分叉）',
}

/** 标题里固定前缀与摘要之间的分隔符。 */
const SUBJECT_SUMMARY_SEPARATOR = '｜'

/** 首选内容短于这个长度时，再往后接一行，免得标题只有「好的」两个字。 */
const SUBJECT_SUMMARY_MIN_CHARS = 8

/** 拼摘要时最多看几条候选行。 */
const SUBJECT_SUMMARY_MAX_LINES = 3

/** 结束原因的中文描述，用于正文兜底和可选页脚。 */
const REASON_TEXT = {
  completed: '正常完成',
  aborted: '被取消',
  blocked: '被阻塞',
  'max-tokens': '输出达到上限',
  interrupted: '被中断（进程重启后补记）',
  forked: '在分叉边界关闭',
}

/** 实用型邮箱地址校验：dot-atom 形式的本地部分加至少一个点的域名。 */
const ADDRESS_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/**
 * 校验邮箱地址。
 * @param {unknown} value - 待校验的值。
 * @param {string} field - 出错信息里显示的字段名。
 * @returns {string} 合法的地址。
 * @throws {TypeError} 值不是合法邮箱地址时。
 */
function requireAddress(value, field) {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new TypeError(`dsh-mail-notify: ${field} 必须是合法的邮箱地址，当前值为 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 校验非空字符串。
 * @param {unknown} value - 待校验的值。
 * @param {string} field - 出错信息里显示的字段名。
 * @returns {string} 去掉首尾空白后的值。
 * @throws {TypeError} 值不是非空字符串时。
 */
function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-mail-notify: ${field} 必须是非空字符串，当前值为 ${JSON.stringify(value)}`)
  }
  return value.trim()
}

/**
 * 校验可选的非空字符串。
 * @param {unknown} value - 待校验的值。
 * @param {string} field - 出错信息里显示的字段名。
 * @returns {string | null} 归一化后的值，缺省时为 null。
 * @throws {TypeError} 值存在但不是非空字符串时。
 */
function optionalNonEmptyString(value, field) {
  if (value === undefined || value === null) return null
  return requireNonEmptyString(value, field)
}

/**
 * 校验布尔值。
 * @param {unknown} value - 待校验的值。
 * @param {string} field - 出错信息里显示的字段名。
 * @returns {boolean} 校验后的值。
 * @throws {TypeError} 值不是布尔值时。
 */
function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`dsh-mail-notify: ${field} 必须是布尔值，当前值为 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 校验可选的布尔值。
 * @param {unknown} value - 待校验的值。
 * @param {string} field - 出错信息里显示的字段名。
 * @param {boolean} fallback - 值缺省时的默认值。
 * @returns {boolean} 校验后的值。
 * @throws {TypeError} 值存在但不是布尔值时。
 */
function optionalBoolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  return requireBoolean(value, field)
}

/**
 * 校验端口号。
 * @param {unknown} value - 待校验的值。
 * @param {string} field - 出错信息里显示的字段名。
 * @returns {number} 1..65535 的整数。
 * @throws {TypeError} 值不是合法端口时。
 */
function requirePort(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`dsh-mail-notify: ${field} 必须是 1..65535 的整数，当前值为 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 校验可选的超时毫秒数。
 * @param {unknown} value - 待校验的值。
 * @param {string} field - 出错信息里显示的字段名。
 * @param {number} fallback - 值缺省时的默认值。
 * @returns {number} 正整数毫秒数。
 * @throws {TypeError} 值存在但不是正整数时。
 */
function optionalPositiveInt(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`dsh-mail-notify: ${field} 必须是正整数，当前值为 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 校验可选的非负整数（0 有意义时用，例如「安静窗口为 0 = 立刻发」）。
 * @param {unknown} value - 待校验的值。
 * @param {string} field - 出错信息里显示的字段名。
 * @param {number} fallback - 值缺省时的默认值。
 * @returns {number} 非负整数。
 * @throws {TypeError} 值存在但不是非负整数时。
 */
function optionalNonNegativeInt(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`dsh-mail-notify: ${field} 必须是非负整数，当前值为 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 校验并归一化 profile 里的 `config` 块；配置写错在加载时就抛错，不拖到发信时才失败。
 * @param {unknown} raw - `cordis.patch.yml` 中该行的 `config`。
 * @returns {object} 归一化后的配置。
 * @throws {TypeError} 任一字段类型或取值非法时。
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const smtp = config.smtp ?? {}
  if (typeof smtp !== 'object' || smtp === null || Array.isArray(smtp)) {
    throw new TypeError('dsh-mail-notify: config.smtp 必须是一个对象')
  }

  const user = requireAddress(smtp.user, 'config.smtp.user')
  const from = smtp.from === undefined || smtp.from === null ? user : requireAddress(smtp.from, 'config.smtp.from')
  const domain = from.slice(from.indexOf('@') + 1).toLowerCase()
  const preset = SMTP_PRESETS[domain] ?? {}

  const host =
    smtp.host === undefined || smtp.host === null
      ? preset.host
      : requireNonEmptyString(smtp.host, 'config.smtp.host')
  if (host === undefined) {
    throw new TypeError(
      `dsh-mail-notify: 无法为发件域名 ${domain} 推断 SMTP 服务器；请在 config.smtp.host 里明确指定 host/port/secure`,
    )
  }

  const secure = optionalBoolean(smtp.secure, 'config.smtp.secure', preset.secure ?? true)
  const port =
    smtp.port === undefined || smtp.port === null
      ? preset.port ?? (secure ? 465 : 587)
      : requirePort(smtp.port, 'config.smtp.port')

  const to = config.to
  if (!Array.isArray(to) || to.length === 0) {
    throw new TypeError('dsh-mail-notify: config.to 必须是非空的收件人邮箱数组，例如 ["someone@qq.com"]')
  }
  const recipients = to.map((value, index) => requireAddress(value, `config.to[${index}]`))

  return {
    enabled: optionalBoolean(config.enabled, 'config.enabled', true),
    host,
    port,
    secure,
    user,
    from,
    to: recipients,
    subject: optionalNonEmptyString(config.subject, 'config.subject') ?? DEFAULT_SUBJECT,
    subjectProgress: optionalNonEmptyString(config.subjectProgress, 'config.subjectProgress') ?? DEFAULT_SUBJECT_PROGRESS,
    notifyProgress: optionalBoolean(config.notifyProgress, 'config.notifyProgress', true),
    finalQuietSeconds: optionalNonNegativeInt(config.finalQuietSeconds, 'config.finalQuietSeconds', 5),
    subjectSummary: optionalBoolean(config.subjectSummary, 'config.subjectSummary', true),
    subjectSummaryChars: optionalPositiveInt(config.subjectSummaryChars, 'config.subjectSummaryChars', 40),
    reply: normalizeReplyConfig(config.reply, {
      domain,
      to: recipients,
      defaultStateFile: resolvePath(HERE, 'reply-state.json'),
    }),
    authCode: optionalNonEmptyString(config.authCode, 'config.authCode'),
    authCodeEnv: optionalNonEmptyString(config.authCodeEnv, 'config.authCodeEnv') ?? 'QQ_SMTP_AUTH_CODE',
    authCodeFile: optionalNonEmptyString(config.authCodeFile, 'config.authCodeFile') ?? resolvePath(HERE, 'secret.txt'),
    skipSubagentSessions: optionalBoolean(config.skipSubagentSessions, 'config.skipSubagentSessions', true),
    mergeSteps: optionalBoolean(config.mergeSteps, 'config.mergeSteps', false),
    maxBodyChars: optionalPositiveInt(config.maxBodyChars, 'config.maxBodyChars', 20_000),
    includeSessionInfo: optionalBoolean(config.includeSessionInfo, 'config.includeSessionInfo', false),
    dryRun: optionalBoolean(config.dryRun, 'config.dryRun', false),
    timeoutMs: optionalPositiveInt(config.timeoutMs, 'config.timeoutMs', 30_000),
  }
}

/**
 * 校验并归一化 `config.reply`：收信触发（回复邮件 → 新对话）。
 *
 * 默认**关闭**，而且只有 `enabled: true` 时才要求能推断出 IMAP 服务器。
 * `from` 缺省时取通知收件人——也就是你自己的地址，作为唯一允许的触发来源。
 * `createSubject` 是「创建对话」方案的标题短语：一条、一组，或者 `false` 关掉
 * （默认见 `DEFAULT_CREATE_SUBJECTS`，三条自然说法，彼此都是整条标题精确匹配）。
 * @param {unknown} raw - `config.reply`。
 * @param {{ domain: string, to: string[], defaultStateFile: string }} context - 推断端点与默认值所需的上下文。
 * @returns {object} 归一化后的收信配置。
 * @throws {TypeError} 任一字段非法时。
 */
export function normalizeReplyConfig(raw, context) {
  const config = raw ?? {}
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new TypeError('dsh-mail-notify: config.reply 必须是一个对象')
  }

  const enabled = optionalBoolean(config.enabled, 'config.reply.enabled', false)
  const keyword = optionalNonEmptyString(config.keyword, 'config.reply.keyword') ?? 'DSH'
  const keywordScope = optionalNonEmptyString(config.keywordScope, 'config.reply.keywordScope') ?? 'subject'
  if (!KEYWORD_SCOPES.includes(keywordScope)) {
    throw new TypeError(`dsh-mail-notify: config.reply.keywordScope 只能是 ${KEYWORD_SCOPES.join(' / ')}，当前为 ${keywordScope}`)
  }

  const preset = IMAP_PRESETS[context.domain] ?? {}
  const host = config.host === undefined || config.host === null
    ? preset.host
    : requireNonEmptyString(config.host, 'config.reply.host')
  if (enabled && host === undefined) {
    throw new TypeError(
      `dsh-mail-notify: 无法为发件域名 ${context.domain} 推断 IMAP 服务器；请在 config.reply.host 里明确指定 host/port/secure`,
    )
  }

  const secure = optionalBoolean(config.secure, 'config.reply.secure', preset.secure ?? true)
  const port = config.port === undefined || config.port === null
    ? preset.port ?? (secure ? 993 : 143)
    : requirePort(config.port, 'config.reply.port')

  const from = config.from === undefined || config.from === null
    ? context.to
    : Array.isArray(config.from)
      ? config.from.map((value, index) => requireAddress(value, `config.reply.from[${index}]`))
      : (() => {
          throw new TypeError('dsh-mail-notify: config.reply.from 必须是邮箱地址数组')
        })()

  const cwd = optionalNonEmptyString(config.cwd, 'config.reply.cwd') ?? CWD_AUTO
  if (cwd !== CWD_AUTO && cwd !== 'last' && !isAbsolute(cwd)) {
    throw new TypeError(`dsh-mail-notify: config.reply.cwd 必须是绝对路径、'${CWD_AUTO}' 或 'last'，当前为 ${JSON.stringify(cwd)}`)
  }

  const mode = optionalNonEmptyString(config.mode, 'config.reply.mode') ?? 'append'
  if (!REPLY_MODES.includes(mode)) {
    throw new TypeError(`dsh-mail-notify: config.reply.mode 只能是 ${REPLY_MODES.join(' / ')}，当前为 ${mode}`)
  }

  // 「创建对话」方案的标题短语：一条或多条（都按整条标题精确匹配）；写 false 或空数组
  // 即关闭该方案（只剩原来的回复续接）。
  const createSubject = normalizeCreateSubjects(config.createSubject)

  return {
    enabled,
    mode,
    createSubject,
    token: optionalBoolean(config.token, 'config.reply.token', true),
    host,
    port,
    secure,
    allowInsecure: optionalBoolean(config.allowInsecure, 'config.reply.allowInsecure', false),
    mailbox: optionalNonEmptyString(config.mailbox, 'config.reply.mailbox') ?? 'INBOX',
    keyword,
    keywordScope,
    requireReply: optionalBoolean(config.requireReply, 'config.reply.requireReply', true),
    from,
    cwd,
    intervalSeconds: optionalPositiveInt(config.intervalSeconds, 'config.reply.intervalSeconds', 60),
    maxPerHour: optionalPositiveInt(config.maxPerHour, 'config.reply.maxPerHour', 6),
    maxMessageBytes: optionalPositiveInt(config.maxMessageBytes, 'config.reply.maxMessageBytes', 512 * 1024),
    maxPromptChars: optionalPositiveInt(config.maxPromptChars, 'config.reply.maxPromptChars', 6000),
    stateFile: optionalNonEmptyString(config.stateFile, 'config.reply.stateFile') ?? context.defaultStateFile,
    timeoutMs: optionalPositiveInt(config.timeoutMs, 'config.reply.timeoutMs', 30_000),
  }
}

/**
 * 校验并归一化 `config.reply.createSubject`：一条短语、一组短语，或 `false` 关掉。
 *
 * 数组让「创建对话」方案能同时认几种自然说法（默认三条），彼此仍是整条标题精确匹配；
 * 空数组与 `false` 等价（都没有短语可匹配）。
 * @param {unknown} raw - 配置值。
 * @returns {string[]} 归一化后的短语数组；关掉该方案时为空数组。
 * @throws {TypeError} 任一条不是非空字符串、或整体不是字符串/字符串数组/false 时。
 */
function normalizeCreateSubjects(raw) {
  if (raw === false) return []
  if (raw === undefined || raw === null) return [...DEFAULT_CREATE_SUBJECTS]
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((value, index) =>
    requireNonEmptyString(value, Array.isArray(raw) ? `config.reply.createSubject[${index}]` : 'config.reply.createSubject'),
  )
}

/**
 * 返回授权码文件的绝对路径，用于提示信息。
 * @param {object} config - 归一化后的配置。
 * @returns {string} 绝对路径。
 */
function authCodeFilePath(config) {
  return isAbsolute(config.authCodeFile) ? config.authCodeFile : resolvePath(HERE, config.authCodeFile)
}

/**
 * 按 内联 -> 环境变量 -> 文件 的顺序读取 SMTP 授权码，每次都重新读文件。
 *
 * 因此把授权码补进文件后**不需要重启**，下一轮结束就能发信。
 * @param {object} config - 归一化后的配置。
 * @returns {string | null} 授权码；三个来源都没有时返回 null。
 */
function readAuthCode(config) {
  if (config.authCode !== null) return config.authCode.replace(/\s+/g, '')

  const fromEnv = process.env[config.authCodeEnv]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.replace(/\s+/g, '')

  try {
    const value = readFileSync(authCodeFilePath(config), 'utf8').replace(/\s+/g, '')
    if (value !== '') return value
  } catch (error) {
    // 授权码文件尚未创建是首次配置时的正常状态；调用方会给出可操作的提示。
    void error
  }
  return null
}

/**
 * 描述结束原因，用于正文兜底与可选页脚。
 * @param {{ kind: string, error?: { message?: string }, reason?: { kind?: string } }} reason - `turn/end` 的原因。
 * @returns {string} 中文描述。
 */
function describeReason(reason) {
  if (reason.kind === 'error') return `出错：${reason.error?.message ?? '未知错误'}`
  if (reason.kind === 'aborted') return `被取消（${reason.reason?.kind ?? '未知原因'}）`
  // TurnEndReason 是可合并扩展的：不认识的结束原因原样显示，不假装它是正常完成。
  return REASON_TEXT[reason.kind] ?? reason.kind
}

/**
 * 按字符（而不是 UTF-16 码元）截断，避免把 emoji 或代理对切成半个。
 * @param {string} text - 原文本。
 * @param {number} limit - 最多保留多少个字符。
 * @returns {string} 截断后的文本；被截断时以省略号结尾。
 */
function clipCharacters(text, limit) {
  const characters = Array.from(text)
  if (characters.length <= limit) return text
  return `${characters.slice(0, limit).join('').trimEnd()}…`
}

/**
 * 把一行 Markdown 还原成纯文本：剥掉图片/链接语法、引用与列表标记、强调符号与表格竖线。
 * @param {string} line - 原始行。
 * @returns {string} 清理并压缩空白后的文本。
 */
function plainTextLine(line) {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>+\s?/, '')
    .replace(/^\s{0,3}(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从本轮回答里摘一句能进标题的话。
 *
 * 纯本地推断，不调模型、不联网：跳过代码块，优先用第一个 Markdown 标题，否则用第一行；
 * 首选内容太短就往后接一行，让标题能自解释；最后按 `limit` 个字符截断。
 * @param {string} text - 本轮回答文本。
 * @param {number} limit - 摘要最多多少个字符。
 * @returns {string} 摘要；文本里没有可用内容（例如只有代码块）时返回空串。
 */
function summarizeText(text, limit) {
  /** @type {string[]} 清理后的候选行。 */
  const candidates = []
  let inFence = false
  let heading = -1
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const line = plainTextLine(raw)
    // 空行、表格分隔线（|---|---|）和纯符号行都不是内容。
    if (line === '' || /^[-:.\s]+$/.test(line)) continue
    if (heading === -1 && /^\s{0,3}#{1,6}\s/.test(raw)) heading = candidates.length
    candidates.push(line)
  }
  if (candidates.length === 0) return ''

  const start = heading === -1 ? 0 : heading
  let summary = candidates[start]
  const last = Math.min(candidates.length, start + SUBJECT_SUMMARY_MAX_LINES)
  for (let index = start + 1; index < last && summary.length < SUBJECT_SUMMARY_MIN_CHARS; index += 1) {
    summary = `${summary} ${candidates[index]}`
  }
  return clipCharacters(summary, limit)
}

/**
 * 拼标题：前缀 + 结束原因后缀 + 摘要。
 * @param {string} prefix - 固定前缀（进行中用 `subjectProgress`，全部结束用 `subject`）。
 * @param {string} suffix - 结束原因后缀；正常完成时为空串。
 * @param {string} text - 这一轮的回答文本。
 * @param {object} config - 归一化后的配置。
 * @returns {string} 邮件主题。
 */
function composeSubject(prefix, suffix, text, config) {
  const summary = config.subjectSummary ? summarizeText(text, config.subjectSummaryChars) : ''
  if (summary === '') return `${prefix}${suffix}`
  return `${prefix}${suffix}${SUBJECT_SUMMARY_SEPARATOR}${summary}`
}

/**
 * 选取本轮进邮件的助手文本：默认只取最后一条，可配置成拼接整轮。
 * @param {object} config - 归一化后的配置。
 * @param {{ steps: string[] }} open - 本轮已经收集到的助手文本。
 * @returns {string} 去掉首尾空白的合并文本。
 */
function selectAnswerText(config, open) {
  const steps = config.mergeSteps ? open.steps : open.steps.slice(-1)
  return steps.join('\n\n').trim()
}

/**
 * 汇总本轮邮件正文。
 * @param {object} config - 归一化后的配置。
 * @param {object} session - 结束这一轮的会话。
 * @param {{ turn: number, reason: object }} event - `turn/end` 事件的 `data`。
 * @param {string} text - `selectAnswerText` 选出的回答文本。
 * @param {string | null} [token] - 会话 token；给出时会附一段「回复可继续」的页脚。
 * @returns {string} 邮件正文。
 */
function composeBody(config, session, event, text, token = null) {
  let body = text
  if (body === '') body = `（本轮没有产生文本回答，结束原因：${describeReason(event.reason)}）`

  if (body.length > config.maxBodyChars) {
    body = `${body.slice(0, config.maxBodyChars)}\n\n…（正文共 ${body.length} 字，已截断到前 ${config.maxBodyChars} 字）`
  }
  if (config.includeSessionInfo) {
    body += `\n\n--\n会话: ${session.id}\n目录: ${session.header?.cwd ?? '（未知）'}\n状态: ${describeReason(event.reason)}\n时间: ${new Date().toISOString()}`
  }
  // token 页脚放在最后：即使上面被截断，它也不会被截掉。
  if (token !== null) body += `\n${sessionTokenFooter(token)}`
  return body
}

/**
 * 组装一封通知邮件的主题与正文。
 *
 * 两种邮件的差别只在标题前缀，以及「全部结束」那一封会先说清这是一波任务的收尾：
 * - `progress`：某一轮结束、但任务还在继续（下一轮已经开始了）→ 前缀 `subjectProgress`。
 * - `final`：整段跑完（agent 回到 idle）→ 前缀 `subject`（默认「DSH 任务完成」）。
 * 两种都带上这一轮的回答正文，所以一轮的任务只会收到一封、且是 `final`。
 * @param {object} config - 归一化后的配置。
 * @param {object} options - 内容来源。
 * @param {'progress' | 'final'} options.kind - 邮件类型。
 * @param {object} options.session - 会话。
 * @param {{ turn: number, reason: object }} options.event - 对应那一轮的 `turn/end`。
 * @param {string} options.text - 对应那一轮的回答文本。
 * @param {string | null} [options.token] - 会话 token。
 * @returns {{ prefix: string, subject: string, body: string }} 前缀、主题与正文。
 */
export function composeNotification(config, { kind, session, event, text, token = null }) {
  const prefix = kind === 'final' ? config.subject : config.subjectProgress
  const suffix = REASON_SUFFIX[event.reason.kind] ?? `（${event.reason.kind}）`
  const subject = composeSubject(prefix, suffix, text, config)
  const answer = composeBody(config, session, event, text, token)
  if (kind === 'progress') return { prefix, subject, body: answer }
  return {
    prefix,
    subject,
    body: `本次任务已全部结束（${event.turn} 轮）。\n\n${answer}`,
  }
}

/**
 * 造一个「每轮通知」的调度器：把「某一轮结束」和「整段任务结束」分开。
 *
 * 为什么需要它：驱动循环是 `while (await turn())`，一个任务的很多轮之间**不会**回到
 * idle，只有整段跑完 `agent.status` 才变成 `idle`。所以：
 * - 某一轮 `turn/end` 之后不立刻发信，先等 `finalQuietSeconds`（安静窗口）；
 * - 期间如果收到下一轮的 `turn/start`，说明上一轮只是中途 —— 立刻把它发成「进行中」；
 * - 安静窗口到期、且 agent 确实 idle，才发「全部结束」那一封。
 *
 * 因此单轮任务只发一封（标题是「完成」），多轮任务才会多出几封「进行中」。
 * 关掉 `notifyProgress` 后中途那些轮不再单独发信，只在最后汇总发一封。
 * @param {object} options - 依赖注入，便于用假时钟测试。
 * @param {object} options.config - 归一化后的配置。
 * @param {(sessionId: string) => boolean} options.isIdle - 这个会话是不是已经停稳。
 * @param {(payload: object) => Promise<void> | void} options.deliver - 真正发信。
 * @param {(level: string, message: string) => void} [options.log] - 日志。
 * @param {typeof setTimeout} [options.schedule] - 定时器（测试可注入假时钟）。
 * @param {typeof clearTimeout} [options.cancel] - 取消定时器。
 * @returns {{ onTurnEnd: Function, onTurnStart: Function, pendingCount: () => number, dispose: () => void }} 调度器。
 */
export function createTurnScheduler({ config, isIdle, deliver, log = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  /** @type {Map<string, object>} 每个会话当前这一波任务的累积。 */
  const pending = new Map()
  const quietMs = config.finalQuietSeconds * 1000

  const send = (payload) => {
    try {
      Promise.resolve(deliver(payload)).catch((error) => {
        log('error', `mail-notify: 发送「${payload.kind === 'final' ? '全部结束' : '进行中'}」邮件失败：${messageOf(error)}`)
      })
    } catch (error) {
      log('error', `mail-notify: 发送「${payload.kind === 'final' ? '全部结束' : '进行中'}」邮件失败：${messageOf(error)}`)
    }
  }

  /** （重新）武装安静窗口：窗口内又有新轮就重来。 */
  const arm = (entry) => {
    if (entry.timer !== undefined) cancel(entry.timer)
    entry.timer = schedule(() => {
      entry.timer = undefined
      if (!pending.has(entry.sessionId)) return
      // 还在跑（例如新的一轮已经开始、但我们没收到 turn/start）：不发「全部结束」，继续等。
      if (!isIdle(entry.sessionId)) {
        arm(entry)
        return
      }
      pending.delete(entry.sessionId)
      send({
        kind: 'final',
        session: entry.session,
        event: entry.event,
        text: entry.text,
        turns: entry.turns,
      })
    }, quietMs)
    entry.timer?.unref?.()
  }

  const onTurnEnd = ({ session, event, text }) => {
    const sessionId = session.id
    let entry = pending.get(sessionId)
    if (entry === undefined) {
      entry = { sessionId, session, turns: 0, steps: [], unsent: [], text: '', event }
      pending.set(sessionId, entry)
    }
    entry.turns += 1
    entry.steps.push(text)
    entry.text = text
    entry.event = event
    entry.unsent.push({ event, text })
    arm(entry)
  }

  const onTurnStart = (session) => {
    const entry = pending.get(session.id)
    if (entry === undefined || entry.unsent.length === 0) return
    // 新一轮开始了 ⇒ 之前那些轮只是中途。
    const unsent = entry.unsent.splice(0, entry.unsent.length)
    // 安静窗口必须重新计时：否则那个还没到期的旧定时器会把刚发过的这一轮
    // 再当成「全部结束」发一次（真机上表现为多一封同名不同内容的「完成」邮件）。
    arm(entry)
    if (!config.notifyProgress) return
    for (const item of unsent) {
      send({
        kind: 'progress',
        session: entry.session,
        event: item.event,
        text: item.text,
        turns: entry.turns,
      })
    }
  }

  return {
    onTurnEnd,
    onTurnStart,
    pendingCount: () => pending.size,
    dispose: () => {
      if (pending.size > 0) {
        log(
          'warn',
          `mail-notify: 有 ${pending.size} 波任务的「全部结束」邮件还没到安静窗口（${config.finalQuietSeconds} 秒）就遇到插件卸载/进程退出，这几封不会发出；` +
            '把 finalQuietSeconds 调小可以缩短这个窗口。',
        )
      }
      for (const entry of pending.values()) {
        if (entry.timer !== undefined) cancel(entry.timer)
      }
      pending.clear()
    },
  }
}

/**
 * 真正发信：逐个收件人单独投递，避免收件人之间互相看到地址。
 *
 * 收信触发器在场时，正文末尾会附一段会话 token，并在全部投递成功后把它登记下来——
 * 之后你回复这封通知，插件就靠这段 token 认出该往哪条会话里追加消息（比主题可靠：
 * 你改了标题也照样认得出）。
 * @param {object} ctx - Cordis 插件上下文，用于日志。
 * @param {object} config - 归一化后的配置。
 * @param {{ kind: 'progress' | 'final', session: object, event: object, text: string }} payload - 调度器给出的内容。
 * @param {object | null} [replyPoller] - 收信触发器（可选）：取 token、登记通知。
 * @returns {Promise<void>} 全部收件人处理完后结束。
 * @throws {Error} 缺少授权码，或 SMTP 投递失败时。
 */
async function deliver(ctx, config, payload, replyPoller = null) {
  const token = replyPoller?.createNotificationToken?.() ?? null
  const { subject, body } = composeNotification(config, { ...payload, token })

  if (config.dryRun) {
    ctx.logger.info(
      `mail-notify: dryRun 已开启，未发送。kind=${payload.kind} subject=${subject} to=${config.to.join(', ')} body=${body.length} 字${
        token === null ? '' : ` token=${token}`
      }`,
    )
    ctx.logger.info(`mail-notify: dryRun 正文（最多显示 2000 字）:\n${body.slice(0, 2000)}`)
    return
  }

  const authCode = readAuthCode(config)
  if (authCode === null) {
    throw new Error(
      `没有读到 SMTP 授权码。请把授权码写入 ${authCodeFilePath(config)}（只有一行），或设置环境变量 ${config.authCodeEnv}`,
    )
  }

  for (const recipient of config.to) {
    const message = buildMessage({ from: config.from, to: recipient, subject, body })
    await sendMail({
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      password: authCode,
      from: config.from,
      recipients: [recipient],
      message,
      timeoutMs: config.timeoutMs,
    })
    ctx.logger.info(`mail-notify: 已发送「${subject}」到 ${recipient}`)
  }
  replyPoller?.rememberNotification?.(payload.session.id, subject, token ?? undefined)
}

/**
 * 注册 `session/event` 监听器：累积本轮的助手文本，在该轮 `turn/end` 时发信。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {unknown} rawConfig - `cordis.patch.yml` 中该行的 `config`。
 * @returns {void}
 */
/**
 * 构造一条用户消息。
 *
 * 这里不用 harness 的 `createUserMessage()`：本包是零依赖的 `link:` 插件，不能
 * import 宿主内部模块。会话侧只校验 `id` 非空、`role` 与事件类型匹配、
 * `content` 是数组、`source.kind` 非空，所以字面量对象就是合法输入。
 * @param {string} text - 消息正文。
 * @returns {object} 用户消息。
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'cordis-host-runner' },
  }
}

/**
 * 挑这一封邮件该用哪套提示词。
 *
 * 「创建对话」方案的 `create` 标记由判定阶段打在邮件上：那时正文是原样的对话内容，
 * 不该再套一层「这一轮任务来自一封邮件」的表头。
 * @param {{ create?: boolean }} mail - 邮件内容。
 * @param {object} config - 归一化后的配置。
 * @returns {string} 提示词。
 */
function promptFor(mail, config) {
  return mail.create === true ? buildCreatePrompt(mail, config.reply) : buildPrompt(mail, config.reply)
}

/**
 * 挑这一封邮件该用哪个会话标题（只在新建会话时用得上）。
 * @param {{ create?: boolean, subject: string, text?: string }} mail - 邮件内容。
 * @param {object} config - 归一化后的配置。
 * @returns {string} 标题。
 */
function titleFor(mail, config) {
  return mail.create === true ? buildCreateTitle(mail) : buildTitle(mail.subject)
}

/**
 * 把邮件作为一条用户消息**追加到已有会话**（活的直接用，冷的先 resume）。
 *
 * 走的是 `ctx.sessionController.resolveAgent()`：这是产品自己往已有会话投递消息的
 * 路径（`dsh-schedule` 投递提醒用的就是它），它会按会话持久化的 `agentPreset`
 * 重新组合作用域、带上当前默认模型把冷会话 resume 起来，并处理写锁冲突。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 归一化后的配置。
 * @param {string} sessionId - 目标会话。
 * @param {{ subject: string, from: string | null, date: string, text: string }} mail - 邮件内容。
 * @returns {Promise<string>} 目标会话 id。
 * @throws {Error} 服务缺失、会话不存在、写锁被占或 resume 失败时。
 */
async function appendToSession(ctx, config, sessionId, mail) {
  const controller = ctx.get('sessionController')
  if (controller === undefined || controller === null) {
    throw new Error('宿主没有加载 sessionController（@deepseek-ai/dsh-api-session-controller），无法把消息追加到已有会话')
  }
  const resolved = await controller.resolveAgent(sessionId)
  if (resolved?.error !== undefined) {
    throw new Error(`打开会话 ${sessionId} 失败：${messageOf(resolved.error)}`)
  }
  // 宿主的签名是 `resolveAgent(sessionId): Promise<ApiSessionAgentResult>`，其中
  // `ApiSessionAgentResult = { agent: Agent } | { error: ... }`——**agent 在 `.agent`
  // 里**（dsh-schedule 投递提醒时写的也是 `resolved.agent.followup(...)`）。
  // 早期版本的替身直接返回 agent 本身，这里一并认下，免得再退回新建会话。
  const agent = resolved?.agent ?? (typeof resolved?.followup === 'function' ? resolved : null)
  if (agent === null || typeof agent.followup !== 'function') {
    throw new Error(`打开会话 ${sessionId} 失败：resolveAgent 没有返回可用的 agent`)
  }
  agent.followup(userMessage(promptFor(mail, config)))
  await flushSession(ctx, sessionId, agent)
  return sessionId
}

/**
 * 尽力把刚追加的消息落盘（`ctx.sessions.flush`）。
 *
 * 宿主自己投递提醒时是等它确认的；这里失败只记 warn 不抛——消息已经进了收件箱，
 * 退回「新建会话」反而会把同一封邮件投两遍。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {string} sessionId - 目标会话。
 * @param {{ session?: object }} agent - 目标 agent。
 * @returns {Promise<void>} 完成时结束。
 */
async function flushSession(ctx, sessionId, agent) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.flush !== 'function' || agent.session === undefined) return
  try {
    const flushed = await sessions.flush(agent.session)
    if (flushed === false) ctx.logger.warn(`mail-notify: 会话 ${sessionId} 未确认落盘（消息已排队，不影响本轮）`)
  } catch (error) {
    ctx.logger.warn(`mail-notify: 会话 ${sessionId} 落盘失败（消息已排队）：${messageOf(error)}`)
  }
}

/**
 * 把一封判定通过的邮件投递出去：能认领会话就追加，否则新建。
 *
 * 追加失败（会话被删了、写锁被另一个进程占着……）不该把邮件整封丢掉，所以退回
 * 新建一个会话，并记一条 warn——至少这轮任务会跑起来。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 归一化后的配置。
 * @param {object} state - 收信状态（新建会话时读 `lastCwd`）。
 * @param {{ subject: string, from: string | null, date: string, text: string }} mail - 邮件内容。
 * @param {{ sessionId: string, how: string } | null} target - 目标会话；null 表示新建。
 * @returns {Promise<{ sessionId: string, action: 'append' | 'new' }>} 实际落到的会话与动作。
 * @throws {Error} 追加与新建都失败时。
 */
async function deliverMail(ctx, config, state, mail, target) {
  let appendError = null
  if (target !== null) {
    try {
      const sessionId = await appendToSession(ctx, config, target.sessionId, mail)
      rememberDelivery(state, { action: 'append', target: target.sessionId, how: target.how, sessionId, error: null })
      return { sessionId, action: 'append' }
    } catch (error) {
      // 追加失败只留一条 warn 日志的话，用户看到的只是「又开了一个新会话」，
      // 看不到原因——所以同时写进状态文件，`mail_notify status` 能直接说明白。
      appendError = messageOf(error)
      ctx.logger.warn(`mail-notify: 追加到会话 ${target.sessionId} 失败，改为新建会话：${appendError}`)
    }
  }
  const created = await startConversation(ctx, config, state, mail)
  rememberDelivery(state, {
    action: 'new',
    target: target === null ? null : target.sessionId,
    how: target === null ? null : target.how,
    sessionId: created.sessionId,
    workspace: `${created.cwd}（${describeCwdSource(created.how)}）`,
    error: appendError,
  })
  return { sessionId: created.sessionId, action: 'new' }
}

/**
 * 记下最近一次投递的结果（动作、落到哪条会话、开在哪个工作区、追加失败的原因）。
 *
 * 状态文件里有了它，「又新建了一个会话」就不再是一句没有下文的现象：
 * `mail_notify status` 会把上一封回复到底追加成功没有、失败原因是什么一并报出来。
 * @param {object} state - 收信状态。
 * @param {{ action: 'append' | 'new', sessionId: string | null, target: string | null, how: string | null, workspace?: string | null, error: string | null }} patch - 本次结果。
 * @returns {void}
 */
function rememberDelivery(state, patch) {
  state.lastDelivery = {
    at: new Date().toISOString(),
    action: patch.action,
    sessionId: patch.sessionId ?? null,
    target: patch.target ?? null,
    how: patch.how ?? null,
    workspace: patch.workspace ?? null,
    error: patch.error ?? null,
  }
}

/**
 * 收信状态文件的绝对路径。
 * @param {object} config - 归一化后的配置。
 * @returns {string} 绝对路径。
 */
function replyStatePath(config) {
  return isAbsolute(config.reply.stateFile) ? config.reply.stateFile : resolvePath(HERE, config.reply.stateFile)
}

/**
 * 读回收信状态（UID 水位、最近一次会话目录、触发时间戳、已处理邮件）。
 * @param {object} config - 归一化后的配置。
 * @returns {object} 归一化后的状态；文件缺失或损坏时返回空状态。
 */
function readReplyState(config) {
  try {
    return normalizeState(JSON.parse(readFileSync(replyStatePath(config), 'utf8')))
  } catch {
    // 文件不存在或写坏了都从空状态开始：最坏结果是重新建立一次水位。
    return normalizeState({})
  }
}

/**
 * 写回收信状态。
 * @param {object} config - 归一化后的配置。
 * @param {object} state - 要写入的状态。
 * @param {object} logger - 用于记录写失败。
 * @returns {void}
 */
function writeReplyState(config, state, logger) {
  try {
    writeFileSync(replyStatePath(config), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch (error) {
    logger.warn(`mail-notify: 收信状态写不进去（下次仍会重试）：${messageOf(error)}`)
  }
}

/**
 * 已登记的工作区里有哪些可以选（`ctx.workspaceRegistry.list()`）。
 *
 * 只认登记过的工作区：模型挑出来的路径必须是其中之一（`parsePick` 会严格校验），
 * 所以它不可能把会话放进一个列表外的目录。「最近一次发过通知的目录」不进这个列表，
 * 它由 {@link resolveReplyCwd} 兜底——挑不出来时才用它。
 * 拿不到服务、或列表读失败时返回空数组：调用方同样会退回兜底行为。
 * @param {object} ctx - Cordis 插件上下文。
 * @returns {{ path: string, title: string, sessions: number }[]} 归一化后的候选。
 */
function workspaceCandidates(ctx) {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
    return normalizeCandidates(registry.list())
  } catch (error) {
    ctx.logger.warn(`mail-notify: 读工作区列表失败，这次不挑工作区：${messageOf(error)}`)
    return []
  }
}

/**
 * 按邮件内容挑一个工作区：先确定性匹配，再让默认模型在候选里挑。
 *
 * 任何一步不成立都返回 null（没候选、模型没把握、模型服务不可用、调用失败），由调用方
 * 兜底——绝不因为「挑不出来」让这封邮件失败。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 归一化后的配置。
 * @param {{ subject: string, from: string | null, text: string }} mail - 邮件内容。
 * @returns {Promise<{ cwd: string, how: 'path' | 'title' | 'only' | 'llm' } | null>} 选中的目录与依据；没挑出来时为 null。
 */
async function pickWorkspace(ctx, config, mail) {
  const candidates = workspaceCandidates(ctx)
  if (candidates.length === 0) return null

  const text = `${mail.subject}\n${mail.text}`
  const direct = matchWorkspace(text, candidates)
  if (direct !== null) {
    ctx.logger.info(
      `mail-notify: 邮件里写到了工作区 ${direct.path}（按${direct.how === 'path' ? '路径' : '名字'}认到）`,
    )
    return { cwd: direct.path, how: direct.how }
  }
  // 只有一个候选时不必问模型：挑不出别的。
  if (candidates.length === 1) return { cwd: candidates[0].path, how: 'only' }

  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  const selection = defaultModel === undefined || defaultModel === null ? null : defaultModel.currentSelection()
  if (selection === null || typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return null

  try {
    const answer = await completeOnce({
      llm,
      provider: selection.provider,
      model: selection.model,
      system: WORKSPACE_PICK_SYSTEM,
      user: buildPickPrompt(mail, candidates),
      // 答案只有一行路径（几十个字符），但推理型的默认模型会先花掉一批推理 token，
      // 上限给太小会连一个字的正文都吐不出来。解析是严格的，多吐的部分只是浪费。
      maxTokens: 512,
      timeoutMs: config.reply.timeoutMs,
    })
    const picked = parsePick(answer, candidates)
    if (picked === null) {
      ctx.logger.info('mail-notify: 模型没从已登记的工作区里挑出合适的，沿用上一次的目录')
      return null
    }
    ctx.logger.info(`mail-notify: 模型按邮件内容挑了工作区 ${picked.path}`)
    return { cwd: picked.path, how: 'llm' }
  } catch (error) {
    ctx.logger.warn(`mail-notify: 让模型挑工作区失败，沿用上一次的目录：${messageOf(error)}`)
    return null
  }
}

/**
 * 决定邮件触发的新会话在哪个目录里工作。
 *
 * 顺序：配置里写死的绝对路径 → `auto`（邮件内容 → 模型 → 最近一次目录）→ 用户主目录。
 * 必须是绝对路径，会话头会校验这一点。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 归一化后的配置。
 * @param {object} state - 收信状态。
 * @param {{ subject: string, from: string | null, text: string }} mail - 邮件内容。
 * @returns {Promise<{ cwd: string, how: 'config' | 'path' | 'title' | 'only' | 'llm' | 'last' | 'home' }>} 目录与依据。
 */
async function resolveReplyCwd(ctx, config, state, mail) {
  if (isAbsolute(config.reply.cwd)) return { cwd: config.reply.cwd, how: 'config' }
  if (config.reply.cwd === CWD_AUTO) {
    const picked = await pickWorkspace(ctx, config, mail)
    if (picked !== null) return picked
  }
  if (typeof state.lastCwd === 'string' && isAbsolute(state.lastCwd)) return { cwd: state.lastCwd, how: 'last' }
  return { cwd: homedir(), how: 'home' }
}

/**
 * 把「工作目录是怎么定的」翻成一句给人看的话。
 * @param {string} how - 依据。
 * @returns {string} 中文说明。
 */
function describeCwdSource(how) {
  switch (how) {
    case 'config': return '配置里写死的路径'
    case 'path': return '邮件里写的路径'
    case 'title': return '邮件里提到的项目名'
    case 'only': return '只登记了这一个工作区'
    case 'llm': return '模型按邮件内容挑的'
    case 'last': return '沿用最近一次发过通知的会话目录'
    default: return '没有线索，用了用户主目录'
  }
}

/**
 * 把一封邮件变成一轮新对话：新建会话 + 投递第一条用户消息。
 *
 * 走的是官方路径 `ctx.agents.create()`：会话会被持久化，并通过 `api-session/added`
 * 立刻出现在 Web GUI 的会话列表里。成功之后**故意不 dispose**——循环会把这一轮
 * 跑完然后进入 idle，之后它就是普通会话（与 dsh-webhook 的做法一致）。
 *
 * 这里不需要 `await handle.agent.whenIdle()`：答案由既有的通知链路回信，等它没有意义。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 归一化后的配置。
 * @param {object} state - 收信状态（读 `lastCwd`）。
 * @param {{ subject: string, from: string | null, date: string, text: string }} mail - 邮件内容。
 * @returns {Promise<{ sessionId: string, cwd: string, how: string }>} 新会话的 id，以及工作目录是怎么定下来的。
 * @throws {Error} 缺少 agents/默认模型服务，或创建过程失败时。
 */
async function startConversation(ctx, config, state, mail) {
  const agents = ctx.get('agents')
  if (agents === undefined || agents === null) {
    throw new Error('宿主没有加载 agents 服务（@deepseek-ai/dsh-agent），无法新建会话')
  }

  const registry = ctx.get('agentPresets')
  const preset = registry === undefined || registry === null ? null : await registry.resolve()
  const defaultModel = ctx.get('agentDefaultModel')
  const selection = defaultModel === undefined || defaultModel === null ? null : defaultModel.currentSelection()
  if (selection === null || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('拿不到默认模型（agentDefaultModel 服务不可用），无法新建会话')
  }

  const { cwd, how } = await resolveReplyCwd(ctx, config, state, mail)
  ctx.logger.info(`mail-notify: 新会话的工作目录 ${cwd}（${describeCwdSource(how)}）`)
  const sessionId = `mail-${randomUUID()}`
  const handle = await agents.create({
    sessionId,
    meta: { cwd, ...(preset === null ? {} : { agentPreset: preset.id }) },
    agentOptions: selection,
    ...(preset === null || registry === undefined || registry === null
      ? {}
      : {
          // preset 必须在发布之前挂上，否则新会话没有工具、也没有 persona。
          setup: async (agentCtx) => {
            await registry.mount(agentCtx, preset.id)
          },
        }),
  })

  try {
    const workspaces = ctx.get('workspaceRegistry')
    if (workspaces !== undefined && workspaces !== null) {
      try {
        const workspace = await workspaces.create(cwd)
        await workspace.attachSession(sessionId)
      } catch (error) {
        // 只是侧栏分组信息，失败不该拖垮这轮对话。
        ctx.logger.warn(`mail-notify: 会话 ${sessionId} 归入项目分组失败（不影响对话）：${messageOf(error)}`)
      }
    }
    try {
      ctx.get('sessionTitle')?.rename?.(handle.agent.session, titleFor(mail, config))
    } catch (error) {
      ctx.logger.warn(`mail-notify: 会话 ${sessionId} 改名失败（不影响对话）：${messageOf(error)}`)
    }
    handle.agent.followup(userMessage(promptFor(mail, config)))
  } catch (error) {
    try {
      await handle.dispose()
    } catch (rollbackError) {
      ctx.logger.warn(`mail-notify: 回滚会话 ${sessionId} 失败：${messageOf(rollbackError)}`)
    }
    throw error
  }
  return { sessionId, cwd, how }
}

/**
 * 造一个收信轮询器：定时连 IMAP 取新邮件，命中就开新对话。
 *
 * 轮询串行化（同一时刻只有一个连接）；失败只记日志，不抛出到定时器外面。
 * 只有「手动检查」（`preview`）完全不改状态，普通轮询会把 UID 水位写回状态文件。
 *
 * 导出是为了让集成测试能直接驱动它（用假 IMAP 服务器 + 假 agents 服务），
 * 不必等真的定时器。
 * @param {{ ctx: object, config: object }} options - 插件上下文与配置。
 * @returns {{ run: (options?: { preview?: boolean }) => Promise<object>, status: object, rememberCwd: (cwd: unknown) => void, state: object }} 轮询器。
 */
export function createReplyPoller({ ctx, config }) {
  const state = readReplyState(config)
  const status = {
    lastPollAt: null,
    lastError: null,
    scanned: 0,
    triggered: 0,
    baseline: false,
    decisions: [],
  }
  let chain = Promise.resolve()

  const log = (level, message) => {
    if (level === 'warn') ctx.logger.warn(message)
    else if (level === 'error') ctx.logger.error(message)
    else ctx.logger.info(message)
  }

  const connectAndPoll = async (options) => {
    const authCode = readAuthCode(config)
    if (authCode === null) {
      throw new Error(
        `没有读到授权码（IMAP 与 SMTP 共用同一个）。请写入 ${authCodeFilePath(config)}，或设置环境变量 ${config.authCodeEnv}`,
      )
    }
    const client = await ImapClient.connect({
      host: config.reply.host,
      port: config.reply.port,
      secure: config.reply.secure,
      allowInsecure: config.reply.allowInsecure,
      user: config.user,
      password: authCode,
      timeoutMs: config.reply.timeoutMs,
    })
    try {
      return await pollOnce({
        client,
        config: config.reply,
        state,
        dryRun: config.dryRun,
        preview: options.preview === true,
        deliver: (mail, target) => deliverMail(ctx, config, state, mail, target),
        log,
      })
    } finally {
      await client.logout().catch(() => {})
    }
  }

  const run = (options = {}) => {
    const task = chain.then(async () => {
      try {
        const result = await connectAndPoll(options)
        status.lastPollAt = new Date().toISOString()
        status.lastError = null
        status.scanned = result.scanned
        status.triggered = result.triggered
        status.baseline = result.baseline
        status.decisions = result.decisions
        if (options.preview !== true) {
          // 落盘最近一次判定：被跳过的邮件不写 handled、水位又照样推过去，不留一份记录
          // 就再也查不出「那封为什么没触发」。
          state.lastScan = scanRecord(result)
          writeReplyState(config, state, ctx.logger)
        }
        return result
      } catch (error) {
        status.lastPollAt = new Date().toISOString()
        status.lastError = messageOf(error)
        status.decisions = []
        if (options.preview !== true) writeReplyState(config, state, ctx.logger)
        throw error
      }
    })
    chain = task.then(
      () => {},
      () => {},
    )
    return task
  }

  const rememberCwd = (cwd) => {
    if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd) || state.lastCwd === cwd) return
    state.lastCwd = cwd
    writeReplyState(config, state, ctx.logger)
  }

  /** 已发出但还没登记的 token，避免同一轮里连发两封时撞号。 */
  const pendingTokens = new Set()

  /**
   * 取一个写进通知正文的会话 token。
   * @returns {string | null} 形如 `DSH-4F2C9A` 的 token；关闭该功能或连续撞号时返回 null。
   */
  const createNotificationToken = () => {
    if (config.reply.token !== true) return null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const token = createToken(state)
      if (!pendingTokens.has(token)) {
        pendingTokens.add(token)
        return token
      }
    }
    // 极端情况下宁可不附 token，也不要卡住发信。
    return null
  }

  /**
   * 记一条刚发出去的通知：之后的回复靠 token（以及主题）认领回这个会话。
   * @param {string} sessionId - 通知所属会话。
   * @param {string} subject - 通知主题。
   * @param {string | undefined} token - 正文里写的会话 token。
   * @returns {void}
   */
  const rememberNotification = (sessionId, subject, token) => {
    recordNotification(state, { sessionId, subject, ...(token === undefined ? {} : { token }) })
    writeReplyState(config, state, ctx.logger)
  }

  return { run, status, rememberCwd, rememberNotification, createNotificationToken, state }
}

/**
 * 渲染收信触发的状态报告。
 *
 * 导出是为了让测试能直接断言这段文案（它不联网、不建会话，只是把配置与状态读出来）。
 * @param {object} config - 归一化后的配置。
 * @param {object | null} poller - 轮询器；未启用时为 null。
 * @returns {string} 多行中文报告。
 */
export function renderReplyStatus(config, poller) {
  const reply = config.reply
  if (!reply.enabled) {
    return [
      '收信触发：未启用（config.reply.enabled 为 false），回复邮件不会触发任何对话。',
      '  开启方法：在配置里加 reply: { enabled: true }，其余字段都有默认值。',
      '  默认安全策略：只认白名单发件人、必须像回复、关键字默认只认主题里的 DSH。',
    ].join('\n')
  }

  const lines = [
    `收信触发：已启用，每 ${reply.intervalSeconds} 秒查一次 ${reply.mailbox}`,
    `IMAP：${reply.host}:${reply.port}（${reply.secure ? '隐式 TLS' : 'EHLO 后 STARTTLS'}）`,
    `关键字：「${reply.keyword}」出现在${
      reply.keywordScope === 'subject' ? '主题' : reply.keywordScope === 'body' ? '正文' : '主题或正文'
    }里（大小写不敏感）`,
    `必须像回复：${reply.requireReply ? '是（有 In-Reply-To/References，或主题以 Re: 开头）' : '否'}`,
    reply.createSubject.length === 0
      ? '创建对话方案：已关闭（reply.createSubject 为 false）'
      : `创建对话方案：标题正好是 ${formatCreateSubjects(reply.createSubject)} 时无条件新建会话，邮件正文原样作为对话内容（不必像回复、也不必含关键字）`,
    `发件人白名单：${reply.from.join(', ')}`,
    `每小时上限：${reply.maxPerHour} 次`,
    reply.mode === 'append'
      ? `投递方式：追加到该通知所属会话（正文 token 优先，其次主题匹配，最后退回最近一次通知；都没有才新建）`
      : '投递方式：每封邮件新建一个会话',
    reply.token
      ? '通知正文：末尾附一段 [DSH-XXXXXX] 会话 token，回复时引用它会自动跟回来'
      : '通知正文：不附会话 token（回复只能靠主题或「最近一次通知」认领）',
    `新会话工作目录：${
      isAbsolute(reply.cwd)
        ? `${reply.cwd}（配置里写死的）`
        : reply.cwd === CWD_AUTO
          ? `auto —— 先认邮件里写的路径/项目名，再让默认模型从已登记的工作区里挑，` +
            `挑不到才沿用最近一次通知的会话目录（当前记录：${poller?.state.lastCwd ?? '（还没有）'}）`
          : `沿用最近一次通知的会话目录（当前记录：${poller?.state.lastCwd ?? '（还没有）'}）`
    }`,
    `状态文件：${replyStatePath(config)}`,
  ]
  if (poller !== null && poller !== undefined) {
    const notifications = poller.state.notifications ?? []
    const newest = notifications.at(-1)
    lines.push(
      `已登记通知：${notifications.length} 条${
        newest === undefined
          ? ''
          : `；最近一条「${newest.subject}」属于会话 ${newest.sessionId}${newest.token === undefined ? '' : `（token ${newest.token}）`}`
      }`,
    )
    lines.push(`UID 水位：uidValidity=${poller.state.uidValidity ?? '（未建立）'} lastUid=${poller.state.lastUid}`)
    const scan = poller.state.lastScan
    if (scan === null || scan === undefined) {
      lines.push(
        `最近一次轮询：${poller.status.lastPollAt ?? '（还没跑过）'}，扫描 ${poller.status.scanned} 封，触发 ${poller.status.triggered} 次`,
      )
    } else {
      lines.push(`最近一次轮询：${scan.at}，扫描 ${scan.scanned} 封，触发 ${scan.triggered} 次${scan.baseline ? '（只建立了 UID 水位）' : ''}`)
      // 明细只留最后几条：够回答「刚才那封为什么没触发」，又不会把报告撑爆。
      const shown = scan.decisions.slice(-STATUS_DECISIONS)
      for (const entry of shown) {
        lines.push(
          `  ${entry.accepted ? '✔ 已触发' : '✘ 跳过'} UID ${entry.uid ?? '?'}${
            entry.subject === '' ? '（无主题）' : `「${entry.subject}」`
          }：${entry.reason}`,
        )
      }
      if (scan.decisions.length > shown.length) lines.push(`  …另有 ${scan.decisions.length - shown.length} 封，见状态文件里的 lastScan`)
    }
    const delivery = poller.state.lastDelivery
    if (delivery !== null && delivery !== undefined) {
      const where =
        delivery.action === 'append'
          ? `追加到会话 ${delivery.sessionId}`
          : `新建了会话 ${delivery.sessionId ?? '（失败）'}${
              delivery.target === null ? '（状态里没有可追加的通知记录）' : `（原目标是 ${delivery.target}）`
            }`
      const workspace = delivery.workspace === null || delivery.workspace === undefined ? '' : `；工作目录 ${delivery.workspace}`
      lines.push(`最近一次投递：${delivery.at} ${where}${workspace}${delivery.error === null ? '' : `；原因：${delivery.error}`}`)
    }
    if (poller.status.lastError !== null) lines.push(`最近一次错误：${poller.status.lastError}`)
  }
  return lines.join('\n')
}

/**
 * 渲染一次「手动检查」的结果。
 * @param {{ scanned: number, baseline: boolean, decisions: object[] }} result - 轮询结果。
 * @returns {string} 多行中文报告。
 */
function renderReplyCheck(result) {
  const lines = [`手动检查（只读：不改状态、不建会话）：扫描 ${result.scanned} 封新邮件`]
  if (result.baseline) {
    lines.push('本轮只建立了 UID 水位：更早的邮件不会处理，下一封新邮件才会被判定。')
    return lines.join('\n')
  }
  if (result.decisions.length === 0) {
    lines.push('没有新邮件。')
    return lines.join('\n')
  }
  for (const entry of result.decisions) {
    lines.push(`  ${entry.accepted ? '✔ 会触发' : '✘ 跳过'}  UID ${entry.uid}  ${entry.subject === '' ? '（无主题）' : entry.subject}`)
    lines.push(`      ${entry.reason}`)
    if (entry.from !== null) lines.push(`      发件人 ${entry.from}`)
  }  return lines.join('\n')
}

/**
 * 把任意抛出物转成一行可读文本，供日志使用。
 *
 * 宿主的 `resolveAgent` 返回的是 `{ error: RemoteError }`——它是 Error，但也有宿主
 * 版本/测试替身给的是普通的 `{ message }` 对象，所以两种都要认，别把原因写成
 * `[object Object]`。
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} 错误信息。
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && typeof error.message === 'string') return error.message
  return String(error)
}

/** 本包的 bundle patch：改 enabled / 发件账号 / 收件人的地方。 */
const CONFIG_FILE = join(HERE, 'cordis.patch.yml')

/**
 * profile 自己的覆盖层路径，用户真正该写个人配置的地方。
 *
 * 这里放真实邮箱地址而不是本包的 patch，公开仓库里就不会留下个人地址。
 * @returns {string} 路径；环境变量缺失时返回一段说明。
 */
function profilePatchFile() {
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && home !== '' && typeof profile === 'string' && profile !== '') {
    return join(home, 'profiles', profile, 'cordis.patch.yml')
  }
  return '$DSH_HOME/profiles/<profile>/cordis.patch.yml'
}

/**
 * 生成一份可直接粘贴进 profile 覆盖层的配置片段。
 * @returns {string} YAML 文本。
 */
function configurationSnippet() {
  return [
    '- id: mail-notify',
    "  name: 'dsh-mail-notify'",
    '  config:',
    '    enabled: true',
    '    smtp:',
    '      user: 你的账号@qq.com',
    '      from: 你的账号@qq.com',
    '    to:',
    '      - 收件人@qq.com',
  ].join('\n')
}

/**
 * 描述授权码当前从哪里读、能不能读到。
 * @param {object} config - 归一化后的配置。
 * @returns {string} 中文说明。
 */
function describeAuthCodeSource(config) {
  const path = authCodeFilePath(config)
  if (config.authCode !== null) return 'config.authCode（内联在配置里，不推荐）'
  const fromEnv = process.env[config.authCodeEnv]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return `环境变量 ${config.authCodeEnv}（已设置）`
  if (readAuthCode(config) !== null) return `文件 ${path}（已读到）`
  return `文件 ${path}（读不到）且环境变量 ${config.authCodeEnv}（未设置）`
}

/**
 * 渲染「现在到底会不会发信」的状态报告。
 * @param {{ config: object | null, failure: string | null, poller?: object | null }} state - 插件状态。
 * @returns {string} 多行中文报告。
 */
function renderStatus(state) {
  const { config, failure } = state
  const lines = []
  if (failure !== null) lines.push(`状态：配置无效，不会发信 —— ${failure}`)
  else if (!config.enabled) lines.push('状态：已安装但未启用（config.enabled 为 false），不会发信。')
  else if (config.dryRun) lines.push('状态：已启用，但 dryRun 为 true，只记日志不发信。')
  else if (readAuthCode(config) === null) lines.push('状态：已启用，但读不到 SMTP 授权码，不会发信。')
  else lines.push('状态：已启用，每轮回答结束都会发信。')

  if (config !== null) {
    lines.push(`SMTP：${config.host}:${config.port}（${config.secure ? '隐式 TLS' : 'EHLO 后 STARTTLS'}）`)
    lines.push(`发件：${config.user}`)
    lines.push(`收件：${config.to.join(', ')}`)
    lines.push(
      `主题：${config.subject}（全部结束）／${config.subjectProgress}（中途每轮）${
        config.mergeSteps ? '（正文拼接整轮）' : '（正文取最后一条回答）'
      }`,
    )
    lines.push(
      config.subjectSummary
        ? `标题摘要：开启，最多 ${config.subjectSummaryChars} 字，取回答里的第一个标题或首行`
        : '标题摘要：关闭，标题只有固定前缀加结束原因',
    )
    lines.push(
      config.notifyProgress
        ? `中途通知：开启，任务连跑多轮时每轮发一封「进行中」（安静 ${config.finalQuietSeconds} 秒后仍未继续才算整段结束）`
        : `中途通知：关闭，只在整段任务结束时发一封（安静 ${config.finalQuietSeconds} 秒判定）`,
    )
    lines.push(`授权码：${describeAuthCodeSource(config)}`)
    lines.push('')
    lines.push(renderReplyStatus(config, state.poller ?? null))
  }
  lines.push(`本包配置：${CONFIG_FILE}`)
  lines.push(`个人覆盖层：${profilePatchFile()}`)
  return lines.join('\n')
}

/**
 * 渲染一份从零到能发信的配置引导。
 * @returns {string} 多行中文引导。
 */
function renderGuide() {
  return [
    'dsh-mail-notify 配置引导',
    '',
    '第 1 步 · 填发件账号和收件人',
    `  把下面这段追加到 ${profilePatchFile()} 末尾：`,
    '',
    configurationSnippet(),
    '',
    '  只写这几个字段就够：host/port/secure 会按发件域名自动推断（qq.com → smtp.qq.com:465），',
    '  其余字段（主题、超时、正文长度上限等）都有默认值。',
    '  标题分两种：中途每轮是「DSH 任务进行中｜本轮摘要」，整段任务跑完那一封是',
    '  「DSH 任务完成｜最后一轮摘要」（正文开头写清「本次任务已全部结束（N 轮）」）。',
    '  不想要中途那些封就写 notifyProgress: false，一个任务只发一封。',
    '  标题摘要默认开启，不想要就写 subjectSummary: false。',
    '  注意 patch 是整体替换 config：这段会覆盖本包 cordis.patch.yml 里的默认值，所以要从 enabled 开始写全。',
    '',
    '第 2 步 · 放授权码',
    '  QQ 邮箱：设置 → 账户 → POP3/IMAP/SMTP 服务 → 开启服务并生成授权码。',
    '  授权码是 16 位，不是登录密码。把它单独写进下面这个文件（只有一行）：',
    `    ${join(HERE, 'secret.txt')}`,
    `  或者改用一个环境变量，默认读 ${'QQ_SMTP_AUTH_CODE'}。`,
    '  授权码每次发信都会重新读文件，所以补进去之后不需要重启。',
    '',
    '第 3 步 · 生效',
    '  保存配置文件即可，dsh 会重新加载这一行（profile 层改动要重启）。',
    '',
    '第 4 步 ·（可选）让邮件能驱动对话（回复续接 + 创建对话）',
    '  在 config 里加一段：',
    '',
    '    reply:',
    '      enabled: true',
    '',
    '  之后直接「回复」任何一封通知邮件就行——通知标题自带 DSH，回复自带 Re: 前缀，',
    '  两个条件自动满足。默认追加到那封通知所属的会话：通知正文末尾会附一段 [DSH-XXXXXX]',
    '  会话 token，回复把它引用回来即可精确认领（改标题也认得出）；token 不在时才退回',
    '  主题匹配、再退回最近一次通知，都没有才新建。想每封都开新对话就写 mode: new。',
    '  默认从严：白名单只认 to 里的地址、必须像回复、非自动回复，关键字只认主题，',
    '  每小时最多触发 6 次。首次运行只记录 UID 水位，更早的邮件不处理，所以要触发就再回一封新的。',
    '',
    '  另一种玩法（创建对话方案，默认就开着）：新写一封邮件，标题**正好**写「创建对话」',
    '  （默认也认「创建新对话」「新建对话」），正文就是你想要的对话内容——它会新建一条会话，',
    '  正文原样作为第一句话（不加任何表头），不需要像回复、标题里也不需要 DSH。标题带尾巴',
    '  （「创建对话：改个 bug」）不算，必须整条标题就是其中一条说法（大小写与 Re:/转发: 前缀',
    '  不影响）。想加别的说法就写 createSubject 数组（例如 [起个新活, 开个新对话]），',
    '  不想要这个方案就写 createSubject: false。',
    '',
    '  新建的会话在哪个工作区里干活（reply.cwd，默认 auto）？先看邮件里有没有写明某个已登记',
    '  工作区的路径或项目名；没有就让默认模型看着邮件内容从工作区列表里挑一个；都不成，才沿用',
    '  最近一次发过通知的会话目录。写死一个绝对路径就固定用它，写 last 则回到「沿用上一次」。',
    '',
    '验证：调用 mail_notify 工具，action 用 test，会立刻真发一封测试邮件。',
    '查状态：调用 mail_notify 工具，action 用 status。',
    '查收信：调用 mail_notify 工具，action 用 reply_check（只读检查一次邮箱，逐封给出判定原因）。',
  ].join('\n')
}

/**
 * 注册模型可见的 `mail_notify` 工具：查状态、出引导、试发一封。
 *
 * 配置无效时也会注册——那时它正好是把错因和改法讲清楚的唯一入口。
 * @param {object} toolsCtx - 已经拿到 `tools` 服务的子上下文。
 * @param {{ config: object | null, failure: string | null }} state - 插件状态。
 * @param {object} logger - 宿主插件上下文的 logger，用于记录试发结果。
 * @returns {void}
 */
function registerGuideTool(toolsCtx, state, logger) {
  toolsCtx.tools.register({
    name: 'mail_notify',
    description: [
      'Inspect, configure, or test the dsh-mail-notify plugin: it emails the agent answer when a turn ends,',
      'and it can also start a NEW conversation when a mail arrives (the "reply trigger").',
      'Replying to a notice appends to that notice\'s conversation; a mail whose subject is exactly one of the configured create phrases (by default 「创建对话」/「创建新对话」/「新建对话」) always starts a brand-new conversation whose first prompt is the mail body verbatim.',
      'action "status" reports whether mail will actually be sent, which SMTP endpoint was resolved, and the reply-trigger state;',
      'action "guide" returns the exact file paths plus a ready-to-paste YAML snippet for turning either direction on;',
      'action "test" sends one real test email immediately (optionally to other recipients via "to");',
      'action "reply_status" explains the reply trigger: keyword, allowlist, IMAP endpoint, UID watermark, create-conversation phrases, and the per-mail verdicts of the last poll;',
      'action "reply_check" polls the mailbox right now in a read-only preview and prints the verdict for every new mail',
      '(use it when the user asks "why did my reply not start a conversation?"); it never changes state and never starts a conversation.',
      'Call "guide" whenever the user asks how to set up email notifications or email-triggered conversations, or reports that no mail arrives.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'guide', 'test', 'reply_status', 'reply_check'],
          description:
            'status: report the current state (sending + reply trigger). guide: return configuration instructions. test: send a test email now. reply_status: reply-trigger details. reply_check: read-only preview poll of the mailbox right now.',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test-only recipients, for example ["someone@qq.com"]. Defaults to the configured "to" list.',
        },
        subject: { type: 'string', description: 'Test-only subject. Defaults to the configured subject plus 「（测试）」.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      if (args.action === 'status') return { text: renderStatus(state) }
      if (args.action === 'guide') return { text: renderGuide() }
      if (args.action === 'reply_status') {
        return { text: state.config === null ? `配置无效：${state.failure}` : renderReplyStatus(state.config, state.poller ?? null) }
      }
      if (args.action === 'reply_check') {
        if (state.config === null) return { text: `无法检查，配置无效：${state.failure}` }
        if (state.poller === undefined || state.poller === null) {
          return {
            text: [
              '收信触发未启用，没有可用的轮询器。',
              '',
              renderReplyStatus(state.config, null),
            ].join('\n'),
          }
        }
        try {
          const result = await state.poller.run({ preview: true })
          return { text: renderReplyCheck(result) }
        } catch (error) {
          return { text: `检查失败：${messageOf(error)}\n\n${renderReplyStatus(state.config, state.poller)}` }
        }
      }
      if (args.action !== 'test') {
        return { text: `未知 action：${String(args.action)}；可用：status、guide、test、reply_status、reply_check。` }
      }

      const { config, failure } = state
      if (config === null) return { text: `无法试发，配置无效：${failure}\n\n${renderGuide()}` }

      const recipients = Array.isArray(args.to) && args.to.length > 0 ? args.to : config.to
      for (const recipient of recipients) {
        if (typeof recipient !== 'string' || !ADDRESS_PATTERN.test(recipient)) {
          return { text: `收件人不是合法邮箱地址：${JSON.stringify(recipient)}` }
        }
      }

      const authCode = readAuthCode(config)
      if (authCode === null) return { text: `无法试发，读不到 SMTP 授权码。\n\n${renderGuide()}` }

      const subject = typeof args.subject === 'string' && args.subject !== '' ? args.subject : `${config.subject}（测试）`
      const body = [
        '这是一封 dsh-mail-notify 的测试邮件。',
        '',
        '收到它说明 SMTP 链路、TLS、认证和中文主题编码都正常。',
        '',
        '—— mail_notify 工具',
      ].join('\n')

      try {
        const sentTo = []
        for (const recipient of recipients) {
          const message = buildMessage({ from: config.from, to: recipient, subject, body })
          await sendMail({
            host: config.host,
            port: config.port,
            secure: config.secure,
            user: config.user,
            password: authCode,
            from: config.from,
            recipients: [recipient],
            message,
            timeoutMs: config.timeoutMs,
          })
          sentTo.push(recipient)
        }
        logger.info(`mail-notify: 测试邮件已发送到 ${sentTo.join(', ')}`)
        return {
          text: [
            `测试邮件已发送到：${sentTo.join(', ')}`,
            `SMTP：${config.host}:${config.port}`,
            '',
            config.enabled
              ? '插件已启用，之后每轮回答结束都会自动发信。'
              : '插件当前未启用。把配置里的 enabled 改成 true，之后每轮回答结束就会自动发信。',
          ].join('\n'),
          sentTo,
        }
      } catch (error) {
        return { text: `测试发送失败：${messageOf(error)}\n\n${renderGuide()}` }
      }
    },
  })
}

export function apply(ctx, rawConfig) {
  let config = null
  let failure = null
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    // 配置写错时保持完全不发信，而不是把异常抛回加载器；原因写进日志。
    failure = messageOf(error)
  }
  const state = { config, failure }

  // 引导工具是附加能力，配置无效时也要在：它正是把错因和改法讲清楚的入口。
  // 它注册失败也不能连累发信本身，所以单独兜住。
  try {
    ctx.inject(['tools'], (toolsCtx) => {
      try {
        registerGuideTool(toolsCtx, state, ctx.logger)
      } catch (error) {
        ctx.logger.warn(`mail-notify: 引导工具注册失败（不影响发信）：${messageOf(error)}`)
      }
    })
  } catch (error) {
    ctx.logger.warn(`mail-notify: 无法注册引导工具（不影响发信）：${messageOf(error)}`)
  }

  if (failure !== null) {
    ctx.logger.error(`mail-notify: 配置无效，插件保持不发送状态：${failure}`)
    ctx.logger.error(`mail-notify: 让 Agent 调用 mail_notify 工具（action: guide）可以拿到改法；本包配置 ${CONFIG_FILE}`)
    return
  }

  // 发信与收信触发是两个独立开关：可以只发通知，也可以只让邮件来触发对话。
  const replyPoller = config.reply.enabled ? createReplyPoller({ ctx, config }) : null
  state.poller = replyPoller

  if (!config.enabled && replyPoller === null) {
    ctx.logger.info('mail-notify: 发信与收信触发都未启用，不注册监听器、不发信、不连邮箱')
    ctx.logger.info('mail-notify: 让 Agent 调用 mail_notify 工具（action: guide）可以拿到开启方法')
    return
  }

  if (config.enabled && config.dryRun) {
    ctx.logger.info(
      `mail-notify: dryRun 已开启，只会记录将要发送的内容。主题=「${config.subject}」收件人=${config.to.join(', ')}`,
    )
  } else if (config.enabled && readAuthCode(config) === null) {
    ctx.logger.warn(
      `mail-notify: 还没有读到 SMTP 授权码，现在不会发信。请把授权码写入 ${authCodeFilePath(config)}（只有一行），或设置环境变量 ${config.authCodeEnv}`,
    )
  }

  /** 每个会话当前打开的那一轮已经产生的助手文本；键是会话对象，随会话回收。 */
  const openTurns = new WeakMap()
  /** 串行化发送，避免多轮同时结束时并发连同一个 SMTP 服务器。 */
  let queue = Promise.resolve()

  const wanted = (session) => !(config.skipSubagentSessions && session.header?.origin === 'subagent')

  const record = (session, event) => {
    const texts = []
    for (const block of event.data.message.content) {
      // ContentBlockMap 是可合并扩展的：只把 text 块当正文，推理和工具调用都不算。
      if (block.type === 'text') texts.push(block.text)
    }
    if (texts.length === 0) return

    const open = openTurns.get(session)
    if (open === undefined || open.turn !== event.data.turn) {
      openTurns.set(session, { turn: event.data.turn, steps: [texts.join('')] })
      return
    }
    open.steps.push(texts.join(''))
  }

  /** 这个会话是不是已经停稳（拿不到 agents 服务时按已停稳处理，宁可发也不漏）。 */
  const agentIsIdle = (sessionId) => {
    const agents = ctx.get('agents')
    if (agents === undefined || agents === null) return true
    const agent = agents.get(sessionId)
    return agent === undefined || agent.status !== 'running'
  }

  const scheduler = createTurnScheduler({
    config,
    isIdle: agentIsIdle,
    deliver: (payload) => {
      // 监听器/定时器都不能阻塞：把发送排进队列，失败只记日志。
      queue = queue.then(() => deliver(ctx, config, payload, replyPoller)).catch((error) => {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error)
        ctx.logger.error(`mail-notify: 发送失败: ${detail}`)
      })
      return queue
    },
    log: (level, message) => {
      if (level === 'warn') ctx.logger.warn(message)
      else if (level === 'error') ctx.logger.error(message)
      else ctx.logger.info(message)
    },
  })
  ctx.effect(() => () => scheduler.dispose(), 'mail-notify.turns()')

  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      if (config.enabled && wanted(session)) record(session, event)
      return
    }

    if (event.type === 'turn/start') {
      // 新一轮开始了 ⇒ 上一轮只是「中途」，立刻把它发出去（标题是「进行中」）。
      if (config.enabled && wanted(session)) scheduler.onTurnStart(session)
      return
    }

    if (event.type !== 'turn/end') return

    // 记住最近一次有活动的会话目录：邮件触发的新对话默认在同一个项目里干活。
    replyPoller?.rememberCwd(session.header?.cwd)

    if (!config.enabled) return
    const open = openTurns.get(session)
    openTurns.delete(session)
    if (open === undefined || open.turn !== event.data.turn) return
    if (!wanted(session)) return

    // 不在这里直接发信：先交给调度器等「安静窗口」，看这一轮是真结束还是还要继续。
    scheduler.onTurnEnd({ session, event: event.data, text: selectAnswerText(config, open) })
  })

  if (replyPoller !== null) {
    const intervalMs = config.reply.intervalSeconds * 1000
    const poll = (label) => {
      // 定时器里绝不能抛出去：轮询失败只记日志，下一轮继续。
      void replyPoller.run().catch((error) => {
        ctx.logger.warn(`mail-notify: 收信轮询（${label}）失败：${messageOf(error)}`)
      })
    }    // 首次轮询稍微晚一点，别和启动抢资源；它同时会把 UID 水位建起来。
    const startup = setTimeout(() => poll('启动'), Math.min(10_000, intervalMs))
    const timer = setInterval(() => poll('定时'), intervalMs)
    startup.unref?.()
    timer.unref?.()
    ctx.effect(
      () => () => {
        clearTimeout(startup)
        clearInterval(timer)
      },
      'mail-notify.reply.poll()',
    )
    ctx.logger.info(
      `mail-notify: 收信触发已启用——每 ${config.reply.intervalSeconds} 秒查一次 ${config.reply.host} 的 ${config.reply.mailbox}；` +
        `关键字「${config.reply.keyword}」只认${config.reply.keywordScope === 'subject' ? '主题' : '主题或正文'}` +
        `${config.reply.createSubject.length === 0 ? '' : `；标题正好是 ${formatCreateSubjects(config.reply.createSubject)} 时新建会话、正文即对话内容`}，` +
        `发件人限 ${config.reply.from.join(', ')}`,
    )
  }
}
