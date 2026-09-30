/**
 * dsh-mail-notify：agent 每结束一轮回答，就发一封通知邮件。
 *
 * 本包以 bundle 形式装进 dsh profile（`dsh.profile.bundles` + `link:` 依赖），
 * 由同目录的 `cordis.patch.yml` 插入一行。它是纯 ESM、零依赖的：SMTP 见
 * `smtp.mjs`，邮件组装见 `mime.mjs`，都不引用任何 harness 包或第三方包。
 *
 * 触发点是每一条 `turn/end`（一轮回答结束），正文取该轮最后一条助手消息的文本。
 *
 * @module dsh-mail-notify
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildMessage } from './mime.mjs'
import { sendMail } from './smtp.mjs'

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

/** 默认主题。 */
const DEFAULT_SUBJECT = 'DSH 任务完成'

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

  return {
    enabled: optionalBoolean(config.enabled, 'config.enabled', true),
    host,
    port,
    secure,
    user,
    from,
    to: to.map((value, index) => requireAddress(value, `config.to[${index}]`)),
    subject: optionalNonEmptyString(config.subject, 'config.subject') ?? DEFAULT_SUBJECT,
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
 * 汇总本轮邮件正文：默认只取最后一条助手消息，可配置成拼接整轮。
 * @param {object} config - 归一化后的配置。
 * @param {object} session - 结束这一轮的会话。
 * @param {{ turn: number, reason: object }} event - `turn/end` 事件的 `data`。
 * @param {{ steps: string[] }} open - 本轮已经收集到的助手文本。
 * @returns {string} 邮件正文。
 */
function composeBody(config, session, event, open) {
  const steps = config.mergeSteps ? open.steps : open.steps.slice(-1)
  let body = steps.join('\n\n').trim()
  if (body === '') body = `（本轮没有产生文本回答，结束原因：${describeReason(event.reason)}）`

  if (body.length > config.maxBodyChars) {
    body = `${body.slice(0, config.maxBodyChars)}\n\n…（正文共 ${body.length} 字，已截断到前 ${config.maxBodyChars} 字）`
  }
  if (config.includeSessionInfo) {
    body += `\n\n--\n会话: ${session.id}\n目录: ${session.header?.cwd ?? '（未知）'}\n状态: ${describeReason(event.reason)}\n时间: ${new Date().toISOString()}`
  }
  return body
}

/**
 * 真正发信：逐个收件人单独投递，避免收件人之间互相看到地址。
 * @param {object} ctx - Cordis 插件上下文，用于日志。
 * @param {object} config - 归一化后的配置。
 * @param {object} session - 结束这一轮的会话。
 * @param {{ turn: number, reason: object }} event - `turn/end` 事件的 `data`。
 * @param {{ steps: string[] }} open - 本轮已经收集到的助手文本。
 * @returns {Promise<void>} 全部收件人处理完后结束。
 * @throws {Error} 缺少授权码，或 SMTP 投递失败时。
 */
async function deliver(ctx, config, session, event, open) {
  const subject = `${config.subject}${REASON_SUFFIX[event.reason.kind] ?? `（${event.reason.kind}）`}`
  const body = composeBody(config, session, event, open)

  if (config.dryRun) {
    ctx.logger.info(
      `mail-notify: dryRun 已开启，未发送。subject=${subject} to=${config.to.join(', ')} body=${body.length} 字`,
    )
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
}

/**
 * 注册 `session/event` 监听器：累积本轮的助手文本，在该轮 `turn/end` 时发信。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {unknown} rawConfig - `cordis.patch.yml` 中该行的 `config`。
 * @returns {void}
 */
/**
 * 把任意抛出物转成一行可读文本，供日志使用。
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} 错误信息。
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    // 配置写错时保持完全不发信，而不是把异常抛回加载器；原因写进日志。
    ctx.logger.error(`mail-notify: 配置无效，插件保持不发送状态：${messageOf(error)}`)
    return
  }

  if (!config.enabled) {
    ctx.logger.info('mail-notify: config.enabled 为 false，插件不注册监听器，也不会发送任何邮件')
    return
  }
  if (config.dryRun) {
    ctx.logger.info(
      `mail-notify: dryRun 已开启，只会记录将要发送的内容。主题=「${config.subject}」收件人=${config.to.join(', ')}`,
    )
  } else if (readAuthCode(config) === null) {
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

  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      if (wanted(session)) record(session, event)
      return
    }
    if (event.type !== 'turn/end') return

    const open = openTurns.get(session)
    openTurns.delete(session)
    if (open === undefined || open.turn !== event.data.turn) return
    if (!wanted(session)) return

    // 监听器本身不能阻塞日志追加：把发送排进队列，失败只记日志。
    queue = queue.then(() => deliver(ctx, config, session, event.data, open)).catch((error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error)
      ctx.logger.error(`mail-notify: 发送失败: ${detail}`)
    })
  })
}
