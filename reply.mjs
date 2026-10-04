/**
 * 「收到邮件 → 起一轮新对话」的判定与编排。
 *
 * 这里刻意不含任何 harness 细节：IMAP 连接由调用方注入（`client`），开新对话由
 * 调用方注入（`startConversation`），因此全部规则都能离线测试。协议在 `imap.mjs`，
 * 邮件解析在 `mail.mjs`。
 *
 * 两套方案（靠标题区分，见 {@link isCreateSubject}）：
 * - **回复续接**：命中关键字（默认 `DSH`）、且像回复 → 追加到通知所属会话，正文带来源表头；
 * - **创建对话**：标题正好是配置里的一条短语（默认三条：「创建对话」「创建新对话」
 *   「新建对话」）→ 无条件新建会话，**正文原样**作为对话内容。
 *
 * 安全模型（「邮件能驱动 agent」约等于远程执行，所以默认从严）：
 * 1. 发件人白名单——只认配置里列出的地址（两套方案都保留）；
 * 2. 必须「像回复」——有 In-Reply-To / References，或主题以 Re:/回复: 开头。
 *    这一条同时挡住本插件自己发出的通知：它既不是回复，也不引用任何邮件；
 *    「创建对话」方案免这道门（它本来就不是回复），改用「标题必须与配置里的短语一字
 *    不差」来防误触发；
 * 3. 自动回复、退信、邮件列表一律忽略（Auto-Submitted、Precedence、MAILER-DAEMON…）；
 * 4. 关键字必须出现（默认只在主题里，大小写不敏感）；
 * 5. 每小时触发次数有上限；
 * 6. 只读拉取（BODY.PEEK），绝不改动邮箱状态——不删、不标已读、不移动。
 *
 * @module dsh-mail-notify/reply
 */

import { extractText, firstAddress, headerValue, parseHeaderBlock, stripQuotedText } from './mail.mjs'

/** 每小时触发窗口。 */
const RATE_WINDOW_MS = 3_600_000

/** 一封邮件最多尝试几次后放弃，避免永久失败的邮件被每分钟重试。 */
const MAX_ATTEMPTS = 3

/** 状态里最多记住多少条已处理的邮件标识。 */
const HANDLED_LIMIT = 200

/** 状态里最多保留多少条触发时间戳（限流用）。 */
const RECENT_LIMIT = 200

/** 状态里最多记住多少条「发出过的通知」（回复靠它认领会话）。 */
const NOTIFICATION_LIMIT = 50

/** 状态里最多保留多少条「最近一次轮询」的判定明细。 */
const SCAN_LIMIT = 20

/** 主题里的回复/转发前缀：中英文客户端都会用。 */
const REPLY_PREFIX = /^\s*(re|回复|答复|回覆|回信|aw|sv|vs)\s*[:：]/i

/** 认领会话时要剥掉的前缀，比 `REPLY_PREFIX` 多含转发。 */
const FORWARD_PREFIX = /^\s*(re|fwd|fw|回复|答复|回覆|回信|转发|转寄|aw|sv|vs)\s*[:：]\s*/i

/**
 * 「创建对话」方案的默认标题短语。
 *
 * 收信触发有两套方案，靠标题区分：
 * - **回复续接**（原行为）：标题含关键字（默认 `DSH`）、且像回复，正文作为一条用户
 *   消息**追加**到通知所属会话；
 * - **创建对话**（本方案）：标题**正好**是配置里的某条短语（默认见
 *   {@link DEFAULT_CREATE_SUBJECTS}），不必像回复、也不必含关键字，
 *   一律**新建**会话，并且**邮件正文原样就是这条新对话的内容**（不加「来自邮件」表头）。
 *
 * 它回答的是「我想从零起一个话题」——新写一封邮件即可，不必先等一封通知来回复。
 */
export const DEFAULT_CREATE_SUBJECT = '创建对话'

/**
 * 默认认下的几条标题短语。
 *
 * 只有一条硬编码短语时，用户写了「创建新对话」「新建对话」这种同样自然的说法就完全
 * 没反应——实测踩过这个坑：邮件安安静静地被跳过，还因为水位已经推过去而查不出原因。
 * 多条短语彼此仍是**精确匹配**（不是子串、不是前缀），所以放宽的是「说法」而不是
 * 「匹配的松紧」。要加别的说法就在配置里写数组，要收紧就只写一条。
 */
export const DEFAULT_CREATE_SUBJECTS = [DEFAULT_CREATE_SUBJECT, '创建新对话', '新建对话']

/**
 * 把配置里的 `createSubject` 归一化成短语数组。
 *
 * 接受单个字符串、字符串数组，以及 `false` / `null` / `undefined` / `''`（都表示关掉
 * 这个方案）。空白与空串会被丢掉，所以 `[]` 与 `false` 等价。
 * @param {string | string[] | false | null | undefined} createSubject - 配置值。
 * @returns {string[]} 非空的短语数组；关掉该方案时为空数组。
 */
export function createSubjectPhrases(createSubject) {
  const list = Array.isArray(createSubject) ? createSubject : [createSubject]
  return list
    .filter((phrase) => typeof phrase === 'string')
    .map((phrase) => phrase.replace(/\s+/g, ' ').trim())
    .filter((phrase) => phrase !== '')
}

/**
 * 把短语数组渲染成给人看的「「创建对话」「创建新对话」」。
 * @param {string | string[] | false | null | undefined} createSubject - 配置值或短语数组。
 * @returns {string} 用空格分开的带引号短语；没有短语时为空串。
 */
export function formatCreateSubjects(createSubject) {
  return createSubjectPhrases(createSubject)
    .map((phrase) => `「${phrase}」`)
    .join(' ')
}

/**
 * 会话 token 的前缀与形状。
 *
 * token 写在**通知正文**里：邮件客户端回复时会把原文引用回来，于是 token 跟着回到
 * 我们手里，比主题匹配可靠得多（用户改了标题也照样认得出）。刻意只用 ASCII、且
 * 整行很短，避免被客户端按列宽折断。
 */
const TOKEN_PREFIX = 'DSH-'

/** token 本体：6 位十六进制。 */
const TOKEN_PATTERN = new RegExp(`${TOKEN_PREFIX}([0-9A-F]{6})`, 'i')

/** 在文本里找会话 token（含被 `>` 引用的行），返回规范化后的大写形式。 */
const TOKEN_SEARCH = new RegExp(`\\b${TOKEN_PREFIX}([0-9A-F]{6})\\b`, 'i')

/**
 * 造一个没被占用过的会话 token。
 * @param {object} state - 收信状态（用它的通知登记表查重）。
 * @param {() => number} [random] - 0..1 的随机源，便于测试。
 * @returns {string} 形如 `DSH-4F2C9A` 的 token。
 */
export function createToken(state, random = Math.random) {
  const used = new Set(state.notifications.map((entry) => entry.token).filter(Boolean))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // 0x1000000 = 16^6，取满六位十六进制的整个空间。
    const value = Math.floor(random() * 0x1000000)
    const token = `${TOKEN_PREFIX}${value.toString(16).toUpperCase().padStart(6, '0')}`
    if (!used.has(token)) return token
  }
  throw new Error('dsh-mail-notify: 生成会话 token 时连续撞号，请清空 reply-state.json 里的 notifications')
}

/**
 * 从文本（**包含引用部分**）里找出会话 token。
 * @param {string} text - 邮件正文原文。
 * @returns {string | null} 大写 token；找不到时为 null。
 */
export function findToken(text) {
  const match = TOKEN_SEARCH.exec(text ?? '')
  return match === null ? null : `${TOKEN_PREFIX}${match[1].toUpperCase()}`
}

/**
 * 去掉正文里的会话 token 行，避免它进到给模型的提示词里。
 *
 * 只删「整行基本只有 token」的那种行——正常句子里偶然出现 token 形状时不动它。
 * @param {string} text - 正文。
 * @returns {string} 去掉 token 行之后的正文。
 */
export function stripTokenLines(text) {
  return (text ?? '')
    .split('\n')
    .filter((line) => !new RegExp(`^\\s*>?\\s*\\[?\\s*${TOKEN_PREFIX}[0-9A-F]{6}\\s*\\]?[^0-9A-Za-z]*$`, 'i').test(line))
    .join('\n')
}

/**
 * 通知正文末尾那段「回复可继续」的页脚。
 *
 * token 单独占一行且只有 ASCII，这样客户端按列宽折行时也不会把它拆开；
 * 解释文字放在下一行，即使被折行也不影响识别。
 * @param {string} token - 会话 token。
 * @returns {string} 可直接接在正文后面的页脚。
 */
export function sessionTokenFooter(token) {
  return ['', '——', `[${token}]`, '回复本邮件可以继续这条对话（保留上面这一行即可，改标题也不影响）。'].join('\n')
}

/**
 * 归一化主题，用来把「回复邮件」和「我们发出去的通知」对上。
 *
 * 反复剥掉 `Re:` / `回复:` / `转发:` 这类前缀（客户端可能层层叠加），压缩空白并
 * 统一大小写。之所以不优先用 `In-Reply-To` 对：实测 QQ 会把我们生成的 `Message-ID`
 * 换成自家的（`<tencent_…@qq.com>`），所以回复里的引用串对不上我们发出去的东西。
 * token 是更可靠的线索（见 {@link findToken}），主题匹配是认不到 token 时的退路。
 * @param {string} subject - 原始主题。
 * @returns {string} 归一化后的主题。
 */
export function normalizeSubject(subject) {
  let text = subject ?? ''
  for (;;) {
    const next = text.replace(FORWARD_PREFIX, '')
    if (next === text) break
    text = next
  }
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 这封邮件的标题是不是「创建对话」那一类短语。
 *
 * 归一化后再比（剥掉层层 `Re:`/`回复:`/`转发:` 前缀、压缩空白、统一大小写），
 * 所以「Re: 创建对话」也认；但要求**整条标题就是其中一条**——「创建对话：改个 bug」
 * 这种带尾巴的标题不算，避免把普通邮件误当指令。
 * @param {string} subject - 已解码的主题。
 * @param {string | string[] | false | null | undefined} createSubject - 配置里的短语（一条或多条）；空/未配置时该方案关闭。
 * @returns {boolean} 命中「创建对话」方案时为 true。
 */
export function isCreateSubject(subject, createSubject) {
  const actual = normalizeSubject(subject)
  if (actual === '') return false
  return createSubjectPhrases(createSubject).some((phrase) => normalizeSubject(phrase) === actual)
}

/**
 * 选一条要追加消息的目标会话。
 *
 * 三级：先看正文里有没有我们发出去的会话 token（回复会引用原文，所以最可靠）；
 * 再按主题精确匹配（回复哪封通知就进哪个会话）；最后退到「最近一次发过通知的会话」。
 * 都没有（还没发过通知，或状态文件丢了）时返回 null，由调用方决定新建还是放弃。
 * @param {object} state - 收信状态。
 * @param {{ subject?: string, text?: string }} mail - 这封回复邮件的主题与正文（正文含引用部分）。
 * @returns {{ sessionId: string, how: 'token' | 'subject' | 'latest', token?: string, subject: string } | null} 目标会话；没有可追加的对象时为 null。
 */
export function pickTarget(state, mail = {}) {
  const token = findToken(mail.text ?? '')
  if (token !== null) {
    for (let index = state.notifications.length - 1; index >= 0; index -= 1) {
      const record = state.notifications[index]
      if (record.token === token) {
        return { sessionId: record.sessionId, how: 'token', token, subject: record.subject }
      }
    }
  }

  const wanted = normalizeSubject(mail.subject ?? '')
  for (let index = state.notifications.length - 1; index >= 0; index -= 1) {
    const record = state.notifications[index]
    if (normalizeSubject(record.subject) === wanted) {
      return { sessionId: record.sessionId, how: 'subject', subject: record.subject }
    }
  }

  const newest = state.notifications.at(-1)
  return newest === undefined ? null : { sessionId: newest.sessionId, how: 'latest', subject: newest.subject }
}

/**
 * 记一条「发出去的通知」，供之后的回复认领会话。
 *
 * 按 token 去重（token 本来就是唯一的）；同一主题允许出现多条，因为主题匹配取的是
 * 最新那条，而按 token 匹配要能命中较旧的那条。
 * @param {object} state - 收信状态。
 * @param {{ sessionId: string, subject: string, token?: string }} notification - 通知所属会话、主题与 token。
 * @param {number} [now] - 当前毫秒时间戳，便于测试。
 * @returns {void}
 */
export function recordNotification(state, notification, now = Date.now()) {
  const token = typeof notification.token === 'string' && TOKEN_PATTERN.test(notification.token)
    ? findToken(notification.token) ?? undefined
    : undefined
  state.notifications = state.notifications.filter((entry) => token === undefined || entry.token !== token)
  state.notifications.push({
    sessionId: notification.sessionId,
    subject: notification.subject,
    ...(token === undefined ? {} : { token }),
    at: new Date(now).toISOString(),
  })
  if (state.notifications.length > NOTIFICATION_LIMIT) {
    state.notifications = state.notifications.slice(-NOTIFICATION_LIMIT)
  }
}

/**
 * 判断是不是自动回复/退信/邮件列表——这类邮件绝不能驱动 agent。
 * @param {Map<string, string>} headers - 信头映射。
 * @returns {string | null} 命中原因；人工邮件返回 null。
 */
export function detectAutomated(headers) {
  const autoSubmitted = headers.get('auto-submitted')
  if (autoSubmitted !== undefined && !/^\s*no\s*$/i.test(autoSubmitted)) return 'Auto-Submitted 声明这是自动回复'
  for (const name of ['x-autoreply', 'x-autorespond', 'x-auto-response-suppress']) {
    if (headers.has(name)) return `信头 ${name} 存在`
  }
  const precedence = (headers.get('precedence') ?? '').trim().toLowerCase()
  if (/^(bulk|junk|list|auto_reply)$/.test(precedence)) return `Precedence: ${precedence}`
  if (headers.has('list-id') || headers.has('list-unsubscribe')) return '邮件列表邮件'

  const from = firstAddress(headers.get('from'))
  if (from === null) return '没有可识别的发件地址'
  const at = from.indexOf('@')
  const local = at === -1 ? from : from.slice(0, at)
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/.test(local)) return `自动化发件人 ${local}@`
  return null
}

/**
 * 判断这封邮件是否「像一封回复」。
 *
 * 本插件发出的通知既没有 In-Reply-To/References，主题也不以 Re: 开头，所以这条
 * 同时是一道自触发防线：自己的通知永远进不来。
 * @param {Map<string, string>} headers - 信头映射。
 * @param {string} subject - 已解码的主题。
 * @returns {boolean} 像回复时为 true。
 */
export function looksLikeReply(headers, subject) {
  if ((headers.get('in-reply-to') ?? '').trim() !== '') return true
  if ((headers.get('references') ?? '').trim() !== '') return true
  return REPLY_PREFIX.test(subject)
}

/**
 * 关键字是否出现在文本里（大小写不敏感）。
 * @param {string} text - 待检文本。
 * @param {string} keyword - 关键字。
 * @returns {boolean} 命中时为 true。
 */
export function hasKeyword(text, keyword) {
  return text.toLowerCase().includes(keyword.toLowerCase())
}

/**
 * 按信头做第一轮判定。
 *
 * 关键字只允许出现在正文时（`keywordScope` 为 body/either），这里返回
 * `needsBody: true`，由调用方取回正文再判一次。
 * @param {Map<string, string>} headers - 信头映射。
 * @param {object} config - 归一化后的 `reply` 配置。
 * @returns {{ accepted: boolean, reason: string, needsBody: boolean, create: boolean, subject: string, from: string | null, messageId: string, date: string }} 判定结果；`create` 为 true 表示走「创建对话」方案（新建会话、正文原样当提示词）。
 */
export function evaluateHeaders(headers, config) {
  const subject = headerValue(headers, 'subject').replace(/\s+/g, ' ').trim()
  const from = firstAddress(headers.get('from'))
  const messageId = (headers.get('message-id') ?? '').trim().replace(/^</, '').replace(/>$/, '')
  const date = (headers.get('date') ?? '').trim()
  const base = { subject, from, messageId, date, create: false }

  if (from === null) return { ...base, accepted: false, needsBody: false, reason: '没有可识别的发件地址' }
  if (!config.from.includes(from)) {
    return { ...base, accepted: false, needsBody: false, reason: `发件人 ${from} 不在白名单里` }
  }

  const automated = detectAutomated(headers)
  if (automated !== null) return { ...base, accepted: false, needsBody: false, reason: automated }

  // 「创建对话」方案排在最前：它本来就不是回复，也不该被回复关键字挡住。
  if (isCreateSubject(subject, config.createSubject)) {
    return {
      ...base,
      accepted: true,
      needsBody: false,
      create: true,
      reason: `主题正好是 ${formatCreateSubjects(config.createSubject)}——按「创建对话」方案新建会话，邮件正文原样作为对话内容`,
    }
  }

  if (config.requireReply && !looksLikeReply(headers, subject)) {
    return {
      ...base,
      accepted: false,
      needsBody: false,
      reason: '不像回复（没有 In-Reply-To/References，主题也不以 Re: 开头）',
    }
  }

  if (hasKeyword(subject, config.keyword)) {
    return { ...base, accepted: true, needsBody: false, reason: `主题含关键字「${config.keyword}」` }
  }
  if (config.keywordScope === 'subject') {
    return { ...base, accepted: false, needsBody: false, reason: `主题没有关键字「${config.keyword}」` }
  }
  return { ...base, accepted: false, needsBody: true, reason: '主题没有关键字，需要看正文' }
}

/**
 * 正文拿到之后的第二轮判定。
 * @param {string} text - 已解析的正文文本。
 * @param {object} config - 归一化后的 `reply` 配置。
 * @returns {{ accepted: boolean, reason: string }} 判定结果。
 */
export function evaluateBody(text, config) {
  if (config.keywordScope === 'subject') return { accepted: false, reason: '配置只认主题里的关键字' }
  if (hasKeyword(text, config.keyword)) return { accepted: true, reason: `正文含关键字「${config.keyword}」` }
  return { accepted: false, reason: `正文也没有关键字「${config.keyword}」` }
}

/**
 * 按 `maxPromptChars` 截断提示词（按字符，不切开代理对）。
 * @param {string} prompt - 提示词。
 * @param {object} config - 归一化后的 `reply` 配置。
 * @returns {string} 可能被截断的提示词。
 */
function clipPrompt(prompt, config) {
  return prompt.length <= config.maxPromptChars ? prompt : `${prompt.slice(0, config.maxPromptChars)}\n\n…（邮件过长，已截断）`
}

/**
 * 把一封邮件变成新对话的第一条提示词。
 * @param {{ subject: string, from: string | null, date: string, text: string }} mail - 邮件内容。
 * @param {object} config - 归一化后的 `reply` 配置。
 * @returns {string} 提示词。
 */
export function buildPrompt(mail, config) {
  const body = stripQuotedText(stripTokenLines(mail.text)).trim()
  const header = [
    '这一轮任务来自一封邮件回复（由 dsh-mail-notify 触发）。',
    '',
    `主题: ${mail.subject === '' ? '（无主题）' : mail.subject}`,
    `发件人: ${mail.from ?? '（未知）'}`,
    ...(mail.date === '' ? [] : [`时间: ${mail.date}`]),
  ].join('\n')
  const prompt = `${header}\n\n${body === '' ? '（邮件正文为空或只有引用内容）' : body}`
  return clipPrompt(prompt, config)
}

/**
 * 「创建对话」方案的提示词：**邮件正文原样就是对话内容**。
 *
 * 刻意不加「这一轮任务来自一封邮件」的表头，也不带主题/发件人——用户写这封邮件的
 * 时候就是在写对话框里的第一句话，多一层包装只会污染上下文。引用历史与本插件自己的
 * token 行仍然剥掉（那是客户端自动加的，不是用户写的）。
 * @param {{ text: string }} mail - 邮件内容。
 * @param {object} config - 归一化后的 `reply` 配置。
 * @returns {string} 提示词。
 */
export function buildCreatePrompt(mail, config) {
  const body = stripQuotedText(stripTokenLines(mail.text)).trim()
  return clipPrompt(body === '' ? '（这是一封主题为「创建对话」的邮件，但正文是空的。）' : body, config)
}

/**
 * 给新会话起一个侧栏里认得出的标题。
 * @param {string} subject - 邮件主题。
 * @returns {string} 标题。
 */
export function buildTitle(subject) {
  const cleaned = subject.replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim()
  const characters = Array.from(`邮件：${cleaned === '' ? '（无主题）' : cleaned}`)
  return characters.length <= 60 ? characters.join('') : `${characters.slice(0, 60).join('')}…`
}

/**
 * 「创建对话」方案的新会话标题：取正文首行的前 60 个字符。
 *
 * 这类邮件的标题固定是「创建对话」，拿它当会话名毫无信息量；正文首行通常就是
 * 用户自己写的话题，侧栏里一眼能认出来。
 * @param {{ text: string }} mail - 邮件内容。
 * @returns {string} 标题。
 */
export function buildCreateTitle(mail) {
  const body = stripQuotedText(stripTokenLines(mail.text)).trim()
  const firstLine = body.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
  if (firstLine === '') return `邮件：${DEFAULT_CREATE_SUBJECT}`
  const characters = Array.from(firstLine)
  return characters.length <= 60 ? characters.join('') : `${characters.slice(0, 60).join('')}…`
}

/**
 * 归一化「最近一次投递结果」。
 *
 * 没有这个字段（旧状态文件）或字段坏掉时返回 null——它只是一条给人看的诊断，
 * 不该让整份状态失效。
 * @param {unknown} raw - 状态文件里的 `lastDelivery`。
 * @returns {{ at: string, action: 'append' | 'new', sessionId: string | null, target: string | null, how: string | null, workspace: string | null, error: string | null } | null} 归一化后的记录；没有时为 null。
 */
export function normalizeDelivery(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const text = (value) => (typeof value === 'string' && value !== '' ? value : null)
  const action = raw.action === 'append' || raw.action === 'new' ? raw.action : null
  if (action === null) return null
  return {
    at: text(raw.at) ?? '',
    action,
    sessionId: text(raw.sessionId),
    target: text(raw.target),
    how: text(raw.how),
    workspace: text(raw.workspace),
    error: text(raw.error),
  }
}

/**
 * 归一化「最近一次轮询」的记录。
 *
 * 为什么要把判定明细落盘：被跳过的邮件**不写 `handled`**，水位照样推过去，于是过后
 * 再查什么也看不见——`reply_check` 只扫水位之后的新邮件。实测踩过：一封标题差一个字
 * 的邮件被静默跳过，只剩「没效果」三个字可查。所以每轮把判定结果留一份，让
 * `reply_status` 能回答「上一轮那封为什么没触发」。
 * @param {unknown} raw - 状态文件里的 `lastScan`。
 * @returns {{ at: string, scanned: number, triggered: number, baseline: boolean, decisions: object[] } | null} 归一化后的记录；没有时为 null。
 */
export function normalizeScan(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const count = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0)
  const decisions = (Array.isArray(raw.decisions) ? raw.decisions : [])
    .filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        // 空对象、只剩一个坏字段的条目都不是「一次判定」，留着只会在报告里显示成一行噪声。
        (typeof entry.reason === 'string' ||
          typeof entry.subject === 'string' ||
          (typeof entry.uid === 'number' && Number.isSafeInteger(entry.uid))),
    )
    .map((entry) => ({
      uid: typeof entry.uid === 'number' && Number.isSafeInteger(entry.uid) ? entry.uid : null,
      subject: typeof entry.subject === 'string' ? entry.subject : '',
      accepted: entry.accepted === true,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      ...(typeof entry.from === 'string' ? { from: entry.from } : {}),
      ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
      ...(typeof entry.action === 'string' ? { action: entry.action } : {}),
    }))
    .slice(-SCAN_LIMIT)
  const at = typeof raw.at === 'string' ? raw.at : ''
  if (at === '' && decisions.length === 0) return null
  return { at, scanned: count(raw.scanned), triggered: count(raw.triggered), baseline: raw.baseline === true, decisions }
}

/**
 * 把一次 `pollOnce` 的结果压成可落盘的记录。
 * @param {{ scanned: number, triggered: number, baseline: boolean, decisions: object[] }} result - 轮询结果。
 * @param {number} [now] - 当前毫秒时间戳，便于测试。
 * @returns {object} 归一化后的记录。
 */
export function scanRecord(result, now = Date.now()) {
  return normalizeScan({
    at: new Date(now).toISOString(),
    scanned: result.scanned,
    triggered: result.triggered,
    baseline: result.baseline,
    decisions: result.decisions,
  })
}

/**
 * 归一化从磁盘读到的状态；字段缺失或类型不对时退回安全默认值。
 * @param {unknown} raw - 状态文件内容。
 * @returns {{ uidValidity: number | null, lastUid: number, lastCwd: string | null, recent: string[], handled: string[], attempts: Record<string, number>, notifications: { sessionId: string, subject: string, at: string }[], lastDelivery: object | null, lastScan: object | null }} 归一化后的状态。
 */
export function normalizeState(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const count = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)
  const strings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [])
  const attempts = {}
  if (typeof source.attempts === 'object' && source.attempts !== null) {
    for (const [key, value] of Object.entries(source.attempts)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) attempts[key] = value
    }
  }
  const notifications = (Array.isArray(source.notifications) ? source.notifications : [])
    .filter((entry) => typeof entry?.sessionId === 'string' && typeof entry?.subject === 'string')
    .map((entry) => ({
      sessionId: entry.sessionId,
      subject: entry.subject,
      ...(typeof entry.token === 'string' && TOKEN_PATTERN.test(entry.token) ? { token: findToken(entry.token) } : {}),
      at: typeof entry.at === 'string' ? entry.at : '',
    }))
    .slice(-NOTIFICATION_LIMIT)

  return {
    uidValidity: count(source.uidValidity),
    lastUid: count(source.lastUid) ?? 0,
    lastCwd: typeof source.lastCwd === 'string' && source.lastCwd !== '' ? source.lastCwd : null,
    recent: strings(source.recent).slice(-RECENT_LIMIT),
    handled: strings(source.handled).slice(-HANDLED_LIMIT),
    attempts,
    notifications,
    lastDelivery: normalizeDelivery(source.lastDelivery),
    lastScan: normalizeScan(source.lastScan),
  }
}

/**
 * 当前是否已超过每小时触发上限。
 * @param {object} state - 归一化后的状态。
 * @param {number} now - 当前毫秒时间戳。
 * @param {number} maxPerHour - 每小时上限。
 * @returns {boolean} 超限时为 true。
 */
export function isRateLimited(state, now, maxPerHour) {
  const recent = state.recent.filter((stamp) => now - Date.parse(stamp) < RATE_WINDOW_MS)
  return recent.length >= maxPerHour
}

/**
 * 记一次触发，并清掉过期时间戳。
 * @param {object} state - 归一化后的状态。
 * @param {number} now - 当前毫秒时间戳。
 * @returns {void}
 */
export function recordTrigger(state, now) {
  state.recent = state.recent.filter((stamp) => now - Date.parse(stamp) < RATE_WINDOW_MS)
  state.recent.push(new Date(now).toISOString())
  if (state.recent.length > RECENT_LIMIT) state.recent = state.recent.slice(-RECENT_LIMIT)
}

/**
 * 记一条已处理的邮件（Message-ID 去重，超上限丢最旧的）。
 *
 * 它同时承担重试去重：若第 5 封失败、第 6 封成功，水位会停在 4 以便重试第 5 封，
 * 而第 6 封靠这份记录不会被再触发一次。
 * @param {object} state - 归一化后的状态。
 * @param {string} id - 邮件标识。
 * @returns {void}
 */
export function recordHandled(state, id) {
  state.handled = state.handled.filter((entry) => entry !== id)
  state.handled.push(id)
  if (state.handled.length > HANDLED_LIMIT) state.handled = state.handled.slice(-HANDLED_LIMIT)
  delete state.attempts[id]
}

/**
 * 轮询一次邮箱：找出新邮件、判定、必要时开新对话。
 *
 * 水位语义：`lastUid` 之前的邮件不再处理；UIDVALIDITY 变化（服务器重建 UID 空间）
 * 时只记录新水位，绝不回头处理旧邮件。`preview` 为 true 时完全不改动状态，
 * 供 `mail_notify` 工具的手动检查使用——手动看一眼不该把邮件「吃掉」。
 * @param {object} options - 本轮所需的一切。
 * @param {{ select: Function, searchUids: Function, fetchMeta: Function, fetchText: Function }} options.client - 已登录的 IMAP 客户端。
 * @param {object} options.config - 归一化后的 `reply` 配置。
 * @param {object} options.state - 归一化后的状态；`preview` 时不会被修改。
 * @param {number} [options.now] - 当前毫秒时间戳，便于测试。
 * @param {boolean} [options.dryRun] - true 时判定通过也不投递。
 * @param {boolean} [options.preview] - true 时只读检查，不改状态、不投递。
 * @param {(mail: object, target: object | null) => Promise<{ sessionId: string, action: 'append' | 'new' }>} [options.deliver] - 把邮件交出去：`target` 非空表示请追加到那个会话，为 null 表示新建；返回**实际**落到的会话与动作（追加可能失败后改为新建，所以动作以返回值为准）。
 * @param {(level: 'info' | 'warn' | 'error', message: string) => void} [options.log] - 日志回调。
 * @returns {Promise<{ scanned: number, triggered: number, baseline: boolean, decisions: object[] }>} 本轮结果。
 */
export async function pollOnce({
  client,
  config,
  state: rawState,
  now = Date.now(),
  dryRun = false,
  preview = false,
  deliver,
  log = () => {},
}) {
  const state = preview ? normalizeState(structuredClone(rawState)) : rawState
  const box = await client.select(config.mailbox)
  const decisions = []
  let triggered = 0

  // 「还没建立水位」的哨兵是 uidValidity 为空（或服务器换了 UID 空间），
  // 不能用 lastUid === 0——空邮箱的水位本来就是 0，用 0 当哨兵会把空邮箱里
  // 收到的第一封邮件当成基线吞掉。
  if (state.uidValidity === null || state.uidValidity !== box.uidValidity) {
    if (!preview) {
      state.uidValidity = box.uidValidity
      state.lastUid = Math.max(0, box.uidNext - 1)
    }
    log('info', `mail-notify: 建立收信水位 uidValidity=${box.uidValidity} lastUid=${state.lastUid}（更早的邮件不处理）`)
    return { scanned: 0, triggered: 0, baseline: true, decisions }
  }

  const uids = (await client.searchUids(`UID ${state.lastUid + 1}:*`)).filter((uid) => uid > state.lastUid)
  // 水位只能「连续」推进：前面有邮件没结算（失败待重试）时，后面的成功不能把水位
  // 跨过去，否则那封失败的邮件就再也不会被重试了。
  let settled = state.lastUid
  let blocked = false

  for (const uid of uids) {
    /** @type {{ header: Buffer, size: number | null }} */
    let meta
    try {
      meta = await client.fetchMeta(uid)
    } catch (error) {
      log('warn', `mail-notify: 拉取 UID ${uid} 信头失败：${describe(error)}`)
      break
    }

    const { headers } = parseHeaderBlock(meta.header)
    const verdict = evaluateHeaders(headers, config)
    const identity = verdict.messageId === '' ? `uid:${uid}` : verdict.messageId
    const entry = { uid, from: verdict.from, subject: verdict.subject, accepted: false, reason: verdict.reason }

    const settle = () => {
      entry.settled = true
      if (!blocked) settled = uid
    }

    if (state.handled.includes(identity)) {
      entry.reason = '这封邮件已经处理过了'
      settle()
      decisions.push(entry)
      continue
    }

    const tooBig = meta.size !== null && meta.size > config.maxMessageBytes
    let accepted = verdict.accepted
    let reason = verdict.reason
    let text = ''

    if (!accepted && verdict.needsBody && !tooBig) {
      try {
        text = extractText(headers, await client.fetchText(uid))
      } catch (error) {
        entry.reason = `下载正文失败：${describe(error)}`
        decisions.push(entry)
        continue
      }
      const bodyVerdict = evaluateBody(text, config)
      accepted = bodyVerdict.accepted
      reason = bodyVerdict.reason
    }

    if (!accepted) {
      entry.reason = tooBig && verdict.needsBody ? `邮件 ${meta.size} 字节，超过上限 ${config.maxMessageBytes}` : reason
      settle()
      decisions.push(entry)
      continue
    }

    if (tooBig) {
      entry.reason = `邮件 ${meta.size} 字节，超过上限 ${config.maxMessageBytes}`
      settle()
      decisions.push(entry)
      continue
    }

    if (isRateLimited(state, now, config.maxPerHour)) {
      entry.reason = `超过每小时 ${config.maxPerHour} 次上限，本轮跳过`
      settle()
      decisions.push(entry)
      continue
    }

    if (text === '') {
      try {
        text = extractText(headers, await client.fetchText(uid))
      } catch (error) {
        entry.reason = `下载正文失败：${describe(error)}`
        decisions.push(entry)
        continue
      }
    }

    const mail = { ...verdict, text }
    // 追加模式：正文到手之后才认领会话——会话 token 就写在通知正文里，回复会把
    // 它引用回来，所以先按 token 认，再按主题认，最后退回最近一次通知。
    // 「创建对话」方案不参与认领：它的语义就是「起一条新对话」，哪怕登记表里正好
    // 有同主题的通知也不该被追加进去。
    const target = config.mode === 'append' && verdict.create !== true ? pickTarget(state, { subject: verdict.subject, text }) : null
    if (verdict.create === true) entry.create = true
    if (target !== null) {
      entry.sessionId = target.sessionId
      entry.how = target.how
      if (target.token !== undefined) entry.token = target.token
    }
    if (preview) {
      entry.accepted = true
      const how =
        target === null
          ? ''
          : target.how === 'token'
            ? `按正文里的 token ${target.token} 认到`
            : target.how === 'subject'
              ? '按主题匹配到'
              : '退回最近一次通知的'
      entry.reason = `${reason}；只是检查，没有投递` + (target === null ? '' : `（${how}会话 ${target.sessionId}）`)
      decisions.push(entry)
      continue
    }
    if (dryRun) {
      entry.accepted = true
      entry.reason = `${reason}；dryRun 已开启，只记录不投递`
      settle()
      decisions.push(entry)
      continue
    }

    try {
      const outcome = await deliver(mail, target)
      recordTrigger(state, now)
      recordHandled(state, identity)
      triggered += 1
      entry.accepted = true
      entry.sessionId = outcome.sessionId
      entry.action = outcome.action
      const fellBack = outcome.action === 'append' && target !== null && target.how !== 'token'
      entry.reason =
        outcome.action === 'new'
          ? `${reason}；新建了会话 ${outcome.sessionId}`
          : `${reason}；已作为用户消息追加到会话 ${outcome.sessionId}${
              fellBack ? `（未按 token 认到，靠${target.how === 'subject' ? '主题' : '最近一次通知'}认领）` : ''
            }`
      settle()
      log('info', `mail-notify: 邮件「${entry.subject}」→ ${outcome.action === 'new' ? '新建' : '追加到'}会话 ${outcome.sessionId}`)
    } catch (error) {
      const attempts = (state.attempts[identity] ?? 0) + 1
      state.attempts[identity] = attempts
      const action = target === null ? '新建会话' : '投递到会话'
      if (attempts >= MAX_ATTEMPTS) {
        recordHandled(state, identity)
        entry.reason = `${action}失败（第 ${attempts} 次，已放弃）：${describe(error)}`
        settle()
        log('error', `mail-notify: 邮件「${entry.subject}」${action}失败并放弃：${describe(error)}`)
      } else {
        entry.retryable = true
        entry.reason = `${action}失败（第 ${attempts} 次，下一轮重试）：${describe(error)}`
        blocked = true
        log('warn', `mail-notify: 邮件「${entry.subject}」${action}失败，稍后重试：${describe(error)}`)
      }
    }
    decisions.push(entry)
  }

  if (!preview) state.lastUid = settled
  return { scanned: uids.length, triggered, baseline: false, decisions }
}

/**
 * 把抛出物转成一行可读文本。
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} 错误信息。
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
