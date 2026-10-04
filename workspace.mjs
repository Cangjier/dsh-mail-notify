/**
 * 「这条邮件该在哪个工作区里跑」的挑选逻辑。
 *
 * 邮件触发的新会话必须有一个工作目录，而配置里只能写死一个绝对路径或「沿用上一次」——
 * 多项目并存时这两个都会指错地方。于是这里补上按邮件内容挑选的能力，分三级：
 *
 * 1. **确定性**：邮件里明写了某个已登记工作区的路径或名字 → 直接用（不花模型的钱）；
 * 2. **模型**：把邮件与候选工作区列表一起交给默认模型，让它只回一行路径或 `UNKNOWN`；
 * 3. **兜底**：模型没把握、或服务不可用 → 返回 null，由调用方沿用上一次的目录。
 *
 * 本模块**不引用任何 harness 包**：`llm` 服务与候选列表都由调用方注入（`index.mjs`
 * 负责接线），所以全部规则都能离线测试。模型给的答案一律**按候选列表严格校验**，
 * 幻觉最多退化成「没挑出来」，不可能把会话放进一个列表外的目录。
 *
 * @module dsh-mail-notify/workspace
 */

/** 挑选工作区时给模型的系统提示。 */
export const WORKSPACE_PICK_SYSTEM = [
  '你在为一个自动化编码助手挑选工作目录。',
  '用户发来一封邮件，你要判断这件事该在哪个**已登记的工作区（项目目录）**里完成。',
  '规则：',
  '- 只能从给出的工作区列表里选一个，把它的 path 整行原样输出：不要引号，不要解释，不要 Markdown。',
  '- 邮件里没有任何线索、或与哪个工作区都不相关时，输出 UNKNOWN。',
  '- 宁可输出 UNKNOWN，也不要猜。',
].join('\n')

/**
 * 把路径归一化成可比较的形状：统一成正斜杠、去掉结尾分隔符、转小写。
 * @param {unknown} path - 路径。
 * @returns {string} 归一化后的比较键。
 */
export function normalizePathKey(path) {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * 归一化候选工作区列表：只认有路径的条目，按路径去重。
 *
 * 既能吃 `workspaceRegistry.list()` 返回的实体（`path` / `title` / `sessionIds`），
 * 也能吃测试里的普通对象。
 * @param {unknown} raw - 原始候选列表。
 * @returns {{ path: string, title: string, sessions: number }[]} 归一化后的候选。
 */
export function normalizeCandidates(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    const path = typeof entry?.path === 'string' ? entry.path : typeof entry?.cwd === 'string' ? entry.cwd : null
    if (path === null || path.trim() === '') continue
    const key = normalizePathKey(path)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push({
      path,
      title: typeof entry?.title === 'string' ? entry.title.trim() : '',
      sessions: Array.isArray(entry?.sessionIds) ? entry.sessionIds.length : 0,
    })
  }
  return out
}

/**
 * 候选工作区的名字是否作为**独立的一段**出现在文本里。
 *
 * 只认整块，不认嵌在更长单词里的那截：标题 `notify` 不该在 `dsh-mail-notify` 里命中。
 * 中文没有词边界，退化成子串匹配（标题本身就够长）。
 * @param {string} lowered - 已小写化的文本。
 * @param {string} title - 工作区标题。
 * @returns {boolean} 命中时为 true。
 */
export function mentionsTitle(lowered, title) {
  const needle = title.toLowerCase()
  if (needle === '') return false
  const isWord = (character) => character !== undefined && /[0-9a-z]/.test(character)
  for (let index = lowered.indexOf(needle); index !== -1; index = lowered.indexOf(needle, index + 1)) {
    const before = lowered[index - 1]
    const after = lowered[index + needle.length]
    if (isWord(before) && isWord(needle[0])) continue
    if (isWord(after) && isWord(needle[needle.length - 1])) continue
    return true
  }
  return false
}

/**
 * 从「名字命中」的一组候选里定下唯一的一个。
 *
 * 取名字最长的那个（更具体），最长者不唯一就判定为说不清——返回 null 让调用方
 * 决定是交给模型还是退回兜底。
 * @param {{ path: string, title: string }[]} hits - 命中的候选。
 * @returns {{ path: string, title: string } | null} 唯一命中；说不清时为 null。
 */
function resolveTitleHits(hits) {
  const sorted = [...hits].sort((left, right) => right.title.length - left.title.length)
  if (sorted.length === 0) return null
  if (sorted.length > 1 && sorted[0].title.length === sorted[1].title.length) return null
  return sorted[0]
}

/**
 * 在邮件正文里做**确定性**匹配：明写了哪个工作区的路径或名字。
 *
 * 路径优先（无歧义）；名字命中多个候选时取最长的那一个，若最长者不唯一就判定为
 * 说不清，交给模型。返回 null 表示「邮件里没有线索」。
 * @param {string} text - 邮件主题 + 正文。
 * @param {{ path: string, title: string }[]} candidates - 候选工作区。
 * @returns {{ path: string, how: 'path' | 'title' } | null} 命中的工作区；没有线索时为 null。
 */
export function matchWorkspace(text, candidates) {
  const haystack = String(text ?? '')
  const flattened = haystack.replace(/\\/g, '/').toLowerCase()
  for (const candidate of candidates) {
    const key = normalizePathKey(candidate.path)
    // 只认够长的路径：`C:\` 这种根目录归一化后只有两个字符，出现在任何一封提到 C 盘
    // 路径的邮件里，会把所有邮件都吸过去。
    if (key.length >= 4 && flattened.includes(key)) return { path: candidate.path, how: 'path' }
  }

  const lowered = haystack.toLowerCase()
  const hit = resolveTitleHits(
    candidates.filter((candidate) => candidate.title.length >= 2 && mentionsTitle(lowered, candidate.title)),
  )
  return hit === null ? null : { path: hit.path, how: 'title' }
}

/**
 * 拼给模型的挑选提示。
 *
 * 邮件正文与候选列表都用 JSON 框起来（与宿主给会话起标题的做法一致）：邮件里写什么都
 * 破坏不了结构，也不会被当成指令。
 * @param {{ subject: string, from?: string | null, text: string }} mail - 邮件内容（正文已剥掉引用与 token 行）。
 * @param {{ path: string, title: string, sessions?: number }[]} candidates - 候选工作区。
 * @returns {string} 提示词。
 */
export function buildPickPrompt(mail, candidates) {
  return [
    '要新建一条对话的邮件（JSON）：',
    JSON.stringify({
      subject: mail.subject ?? '',
      from: mail.from ?? '',
      body: mail.text ?? '',
    }),
    '',
    '可以选的工作区（JSON；答案是其中某个 path 的原样一行，或 UNKNOWN）：',
    JSON.stringify(candidates.map((candidate) => ({ title: candidate.title, path: candidate.path, sessions: candidate.sessions ?? 0 }))),
  ].join('\n')
}

/**
 * 严格解析模型的回答：只认候选列表里的路径或（唯一的）标题。
 * @param {string} answer - 模型回答的原文。
 * @param {{ path: string, title: string }[]} candidates - 候选工作区。
 * @returns {{ path: string, how: 'llm' } | null} 选中的工作区；没选出时为 null。
 */
export function parsePick(answer, candidates) {
  for (const rawLine of String(answer ?? '').split('\n')) {
    const line = rawLine
      .trim()
      .replace(/^[`"'\s]+/, '')
      .replace(/[`"'\s]+$/, '')
      .replace(/[.。;；,，、]+$/, '')
      .trim()
    if (line === '') continue
    if (/^unknown$/i.test(line)) return null

    const key = normalizePathKey(line)
    const byPath = candidates.find((candidate) => normalizePathKey(candidate.path) === key)
    if (byPath !== undefined) return { path: byPath.path, how: 'llm' }

    // 模型可能把答案裹在句子里（「应该是 web-app 吧」）：按名字再认一次，仍要求唯一。
    const named = resolveTitleHits(
      candidates.filter((candidate) => candidate.title.length >= 2 && mentionsTitle(line.toLowerCase(), candidate.title)),
    )
    if (named !== null) return { path: named.path, how: 'llm' }
  }
  return null
}

/**
 * 走一次模型：把 chunks 里的文本拼起来。
 *
 * 只依赖注入的 `llm` 服务（`stream(options)` 返回 `StreamChunk` 流），不 import 任何
 * harness 包，因此假 llm 就能离线测。结束原因不是 `stop` 时抛错（`max-tokens` 除外：
 * 那说明答案被截断，交给严格解析去否掉，比整条链路失败更好）。
 * @param {object} options - 调用参数。
 * @param {{ stream: Function }} options.llm - 宿主的 `llm` 服务。
 * @param {string} options.provider - 提供方。
 * @param {string} options.model - 模型。
 * @param {string} options.system - 系统提示。
 * @param {string} options.user - 用户消息。
 * @param {number} [options.maxTokens] - 输出上限。
 * @param {number} [options.timeoutMs] - 超时。
 * @param {AbortSignal} [options.signal] - 外部取消信号。
 * @returns {Promise<string>} 模型输出的文本（已 trim）。
 * @throws {Error} 服务缺失、超时、被取消或模型报错时。
 */
export async function completeOnce({
  llm,
  provider,
  model,
  system,
  user,
  maxTokens = 64,
  timeoutMs = 15_000,
  signal,
}) {
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('宿主没有加载 llm 服务（@deepseek-ai/dsh-llm），无法让模型挑选工作区')
  }

  const controller = new AbortController()
  const forward = () => controller.abort()
  signal?.addEventListener?.('abort', forward, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()

  let text = ''
  let finish
  try {
    const stream = llm.stream({
      provider,
      model,
      system,
      maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish') finish = chunk
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', forward)
  }

  if (timedOut) throw new Error(`模型在 ${timeoutMs}ms 内没有给出答案`)
  if (finish === undefined) throw new Error('模型调用没有结束标记（stream 提前断了）')
  const kind = finish.reason?.kind
  if (kind === 'error' || kind === 'aborted') {
    throw new Error(finish.reason?.failure?.message ?? `模型调用结束于 ${kind}`)
  }
  return text.trim()
}
