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
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
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
 * @param {{ config: object | null, failure: string | null }} state - 插件状态。
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
    lines.push(`主题：${config.subject}${config.mergeSteps ? '（正文拼接整轮）' : '（正文取最后一条回答）'}`)
    lines.push(`授权码：${describeAuthCodeSource(config)}`)
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
    '验证：调用 mail_notify 工具，action 用 test，会立刻真发一封测试邮件。',
    '查状态：调用 mail_notify 工具，action 用 status。',
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
      'Inspect, configure, or test the dsh-mail-notify plugin, which emails the agent answer when a turn ends.',
      'action "status" reports whether it will actually send, and which SMTP endpoint it resolved from the sender domain;',
      'action "guide" returns the exact file paths plus a ready-to-paste YAML snippet for turning it on;',
      'action "test" sends one real test email immediately (optionally to other recipients via "to").',
      'Call "guide" whenever the user asks how to set up email notifications, or reports that no mail arrives.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'guide', 'test'],
          description: 'status: report the current state. guide: return configuration instructions. test: send a test email now.',
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
      if (args.action !== 'test') return { text: `未知 action：${String(args.action)}；可用：status、guide、test。` }

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

  if (!config.enabled) {
    ctx.logger.info('mail-notify: 未启用（config.enabled 为 false），不注册监听器、不发送邮件')
    ctx.logger.info(`mail-notify: 让 Agent 调用 mail_notify 工具（action: guide）可以拿到开启方法`)
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
