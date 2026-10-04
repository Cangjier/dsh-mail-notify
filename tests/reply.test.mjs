/**
 * 「收到回复 → 起新对话」判定与编排的离线用例：不联网、不发信、不建任何真实会话。
 *
 * 假 IMAP 客户端只实现 `pollOnce` 用到的那四个方法，因此这里验证的是判定规则、
 * UID 水位推进、失败重试、限流与去重，而不是协议本身（协议在 imap.test.mjs）。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCreatePrompt,
  buildCreateTitle,
  buildPrompt,
  buildTitle,
  createToken,
  DEFAULT_CREATE_SUBJECT,
  DEFAULT_CREATE_SUBJECTS,
  detectAutomated,
  evaluateBody,
  evaluateHeaders,
  findToken,
  formatCreateSubjects,
  hasKeyword,
  isCreateSubject,
  isRateLimited,
  looksLikeReply,
  normalizeState,
  normalizeSubject,
  pickTarget,
  pollOnce,
  recordNotification,
  recordTrigger,
  scanRecord,
  sessionTokenFooter,
} from '../reply.mjs'
import { parseHeaderBlock } from '../mail.mjs'

/** 默认的 `reply` 配置，测试里按需覆盖。 */
const config = (extra = {}) => ({
  enabled: true,
  mode: 'append',
  keyword: 'DSH',
  keywordScope: 'subject',
  requireReply: true,
  from: ['moodlee@qq.com'],
  maxPerHour: 6,
  maxMessageBytes: 524_288,
  maxPromptChars: 6000,
  mailbox: 'INBOX',
  ...extra,
})

/** 造一封邮件的信头字节。 */
const header = (...rows) => Buffer.from(rows.join('\r\n'), 'utf8')

/**
 * 假 IMAP 客户端。
 * @param {{ uidValidity?: number, uidNext?: number, mails?: Array<{ uid: number, header: Buffer, text?: string, size?: number }> }} options - 邮箱内容。
 * @returns {object} 只实现 pollOnce 所需方法的客户端。
 */
function fakeClient({ uidValidity = 7, uidNext = 100, mails = [] } = {}) {
  const calls = { fetched: [], search: [] }
  return {
    calls,
    async select() {
      return { messages: mails.length, uidNext, uidValidity }
    },
    async searchUids(criteria) {
      calls.search.push(criteria)
      const min = Number(/UID (\d+):/.exec(criteria)?.[1] ?? 0)
      return mails.map((mail) => mail.uid).filter((uid) => uid >= min).sort((a, b) => a - b)
    },
    async fetchMeta(uid) {
      const mail = mails.find((entry) => entry.uid === uid)
      if (mail === undefined) throw new Error(`没有 UID ${uid}`)
      calls.fetched.push(uid)
      const size = mail.size ?? (mail.text?.length ?? 0) + mail.header.length
      return { header: mail.header, size }
    },
    async fetchText(uid) {
      const mail = mails.find((entry) => entry.uid === uid)
      if (mail === undefined) throw new Error(`没有 UID ${uid}`)
      return Buffer.from(mail.text ?? '', 'utf8')
    },
  }
}

/** 一封「人工回复」邮件的信头。 */
const replyHeader = (extra = []) =>
  header(
    'From: moodlee@qq.com',
    'To: moodlee@qq.com',
    'Subject: Re: =?UTF-8?B?RFNIIOS7u+WKoeWujOaIkA==?=',
    'In-Reply-To: <abc@qq.com>',
    'References: <abc@qq.com>',
    'Message-ID: <reply-1@qq.com>',
    'Date: Thu, 01 Oct 2026 10:30:00 +0800',
    ...extra,
  )

/** 一封「创建对话」邮件的信头：标题就是那四个字，不是回复、也没有引用。 */
const createHeader = (subject = '创建对话') =>
  header(
    'From: moodlee@qq.com',
    'To: moodlee@qq.com',
    `Subject: ${subject}`,
    'Message-ID: <create-1@qq.com>',
    'Date: Thu, 01 Oct 2026 10:30:00 +0800',
  )

test('判定：白名单 + Re: 主题含关键字 → 通过', () => {
  const { headers } = parseHeaderBlock(replyHeader())
  const verdict = evaluateHeaders(headers, config())
  assert.equal(verdict.accepted, true)
  assert.equal(verdict.from, 'moodlee@qq.com')
  assert.equal(verdict.subject, 'Re: DSH 任务完成')
  assert.equal(verdict.messageId, 'reply-1@qq.com')
  assert.match(verdict.reason, /主题含关键字/)
})

test('判定：自己发出的通知（不是回复）被挡住——这就是自触发防线', () => {
  const { headers } = parseHeaderBlock(
    header('From: moodlee@qq.com', 'Subject: =?UTF-8?B?RFNIIOS7u+WKoeWujOaIkA==?=', 'Message-ID: <notice@qq.com>'),
  )
  const verdict = evaluateHeaders(headers, config())
  assert.equal(verdict.accepted, false)
  assert.match(verdict.reason, /不像回复/)
})

test('判定：非白名单发件人一律忽略', () => {
  const { headers } = parseHeaderBlock(
    header('From: stranger@example.com', 'Subject: Re: DSH 请帮我跑个命令', 'In-Reply-To: <x@y>'),
  )
  const verdict = evaluateHeaders(headers, config())
  assert.equal(verdict.accepted, false)
  assert.match(verdict.reason, /不在白名单/)
})

test('判定：自动回复与退信一律忽略，即便主题命中关键字', () => {
  const autoReply = parseHeaderBlock(
    header('From: moodlee@qq.com', 'Subject: Re: DSH 任务完成', 'Auto-Submitted: auto-replied', 'In-Reply-To: <x@y>'),
  ).headers
  assert.match(evaluateHeaders(autoReply, config()).reason, /自动回复/)

  const bounce = parseHeaderBlock(
    header('From: MAILER-DAEMON@qq.com', 'Subject: Re: DSH 任务完成', 'In-Reply-To: <x@y>'),
  ).headers
  assert.equal(evaluateHeaders(bounce, config()).accepted, false)

  const list = parseHeaderBlock(
    header('From: moodlee@qq.com', 'Subject: Re: DSH 列表', 'List-Id: <t.lists.example.com>', 'In-Reply-To: <x@y>'),
  ).headers
  assert.match(evaluateHeaders(list, config()).reason, /邮件列表|自动化/)
})

test('判定：主题没有关键字就不触发（默认只认主题）', () => {
  const { headers } = parseHeaderBlock(
    header('From: moodlee@qq.com', 'Subject: Re: 随便聊聊', 'In-Reply-To: <x@y>'),
  )
  const verdict = evaluateHeaders(headers, config())
  assert.equal(verdict.accepted, false)
  assert.equal(verdict.needsBody, false)
  assert.match(verdict.reason, /主题没有关键字/)
})

test('判定：配置成正文也认时，主题没命中就要求看正文', () => {
  const { headers } = parseHeaderBlock(
    header('From: moodlee@qq.com', 'Subject: Re: 随便聊聊', 'In-Reply-To: <x@y>'),
  )
  const verdict = evaluateHeaders(headers, config({ keywordScope: 'either' }))
  assert.equal(verdict.needsBody, true)
  assert.equal(evaluateBody('这里提到 DSH', config({ keywordScope: 'either' })).accepted, true)
  assert.equal(evaluateBody('什么都没提', config({ keywordScope: 'either' })).accepted, false)
})

test('判定：requireReply 关掉后，普通邮件只要主题命中也能触发', () => {
  const { headers } = parseHeaderBlock(header('From: moodlee@qq.com', 'Subject: DSH 干活'))
  assert.equal(evaluateHeaders(headers, config({ requireReply: false })).accepted, true)
})

test('小工具：关键字大小写不敏感、回复前缀识别、限流窗口', () => {
  assert.equal(hasKeyword('re: dsh 任务', 'DSH'), true)
  assert.equal(looksLikeReply(new Map(), '回复: DSH'), true)
  assert.equal(looksLikeReply(new Map(), 'DSH'), false)
  const state = normalizeState({})
  assert.equal(isRateLimited(state, Date.now(), 1), false)
  recordTrigger(state, Date.now())
  assert.equal(isRateLimited(state, Date.now(), 1), true)
  assert.equal(isRateLimited(state, Date.now() + 3_600_001, 1), false)
})

test('提示词：带邮件元信息，且剥掉引用历史', () => {
  const prompt = buildPrompt(
    {
      subject: 'Re: DSH 任务完成',
      from: 'moodlee@qq.com',
      date: 'Thu, 01 Oct 2026 10:30:00 +0800',
      text: '执行一次复检\n\n在 2026年10月1日 10:07，moodlee@qq.com 写道：\n> 上一次的通知内容',
    },
    config(),
  )
  assert.match(prompt, /主题: Re: DSH 任务完成/)
  assert.match(prompt, /执行一次复检/)
  assert.equal(prompt.includes('上一次的通知内容'), false)
})

test('标题：去掉 Re: 前缀并限长', () => {
  assert.equal(buildTitle('Re: DSH 任务完成'), '邮件：DSH 任务完成')
  assert.equal(buildTitle('').length > 0, true)
  assert.equal(Array.from(buildTitle('x'.repeat(200))).length, 61)
})

test('创建对话：判定工具只认整条标题，短语可配置、可关掉', () => {
  assert.equal(DEFAULT_CREATE_SUBJECT, '创建对话')
  assert.equal(isCreateSubject('创建对话', DEFAULT_CREATE_SUBJECT), true)
  assert.equal(isCreateSubject('  创建对话  ', DEFAULT_CREATE_SUBJECT), true)
  assert.equal(isCreateSubject('Re: 回复: 创建对话', DEFAULT_CREATE_SUBJECT), true, '客户端加的前缀要剥掉')
  assert.equal(isCreateSubject('创建对话吧', DEFAULT_CREATE_SUBJECT), false)
  assert.equal(isCreateSubject('我想创建对话', DEFAULT_CREATE_SUBJECT), false)
  assert.equal(isCreateSubject('创建对话：改个 bug', DEFAULT_CREATE_SUBJECT), false, '带尾巴就不算')
  assert.equal(isCreateSubject('创建对话', ''), false, '空短语 = 关掉该方案')
  assert.equal(isCreateSubject('创建对话', []), false, '空数组 = 关掉该方案')
  assert.equal(isCreateSubject('创建对话', undefined), false)
  assert.equal(isCreateSubject('起个新活', '起个新活'), true)
})

test('创建对话：默认认多条说法——「创建新对话」「新建对话」不再石沉大海', () => {
  assert.deepEqual(DEFAULT_CREATE_SUBJECTS, ['创建对话', '创建新对话', '新建对话'])
  for (const phrase of DEFAULT_CREATE_SUBJECTS) {
    assert.equal(isCreateSubject(phrase, DEFAULT_CREATE_SUBJECTS), true, `${phrase} 应当被认下`)
    assert.equal(isCreateSubject(`Re: ${phrase}`, DEFAULT_CREATE_SUBJECTS), true, `${phrase} 带回复前缀也认`)
  }
  assert.equal(isCreateSubject('创建新对话', DEFAULT_CREATE_SUBJECT), false, '只写一条短语时仍只认那一条')
  assert.equal(isCreateSubject('创建新对话', ['创建新对话', '开个新坑']), true, '短语表可以自己配')
  assert.equal(isCreateSubject('开个新坑', ['创建新对话', '开个新坑']), true)
  assert.equal(isCreateSubject('创建新对话吧', DEFAULT_CREATE_SUBJECTS), false, '多认几条说法不等于放宽成前缀匹配')
  assert.equal(isCreateSubject('帮我创建新对话', DEFAULT_CREATE_SUBJECTS), false)
  assert.equal(formatCreateSubjects(DEFAULT_CREATE_SUBJECTS), '「创建对话」 「创建新对话」 「新建对话」')
  assert.equal(formatCreateSubjects([]), '')
})

test('创建对话：标题正好是那四个字就通过，不必像回复、也不必含关键字', () => {
  const { headers } = parseHeaderBlock(createHeader())
  const verdict = evaluateHeaders(headers, config({ createSubject: DEFAULT_CREATE_SUBJECT }))
  assert.equal(verdict.accepted, true)
  assert.equal(verdict.create, true)
  assert.equal(verdict.needsBody, false, '关键字就在主题里，不必为判定去读正文')
  assert.equal(verdict.subject, '创建对话')
  assert.match(verdict.reason, /创建对话/)
})

test('创建对话：带尾巴的标题不触发（仍按原来的回复规则判定）', () => {
  const { headers } = parseHeaderBlock(
    header('From: moodlee@qq.com', 'To: moodlee@qq.com', 'Subject: 创建对话：改个 bug', 'Message-ID: <x@qq.com>'),
  )
  const verdict = evaluateHeaders(headers, config({ createSubject: DEFAULT_CREATE_SUBJECT }))
  assert.equal(verdict.accepted, false)
  assert.equal(verdict.create, false)
  assert.match(verdict.reason, /不像回复/)
})

test('创建对话：白名单与自动化邮件这两道门照样管用', () => {
  const stranger = parseHeaderBlock(
    header('From: stranger@example.com', 'Subject: 创建对话', 'Message-ID: <s@x>'),
  ).headers
  const strangerVerdict = evaluateHeaders(stranger, config({ createSubject: DEFAULT_CREATE_SUBJECT }))
  assert.equal(strangerVerdict.accepted, false)
  assert.match(strangerVerdict.reason, /白名单/)

  const auto = parseHeaderBlock(
    header('From: moodlee@qq.com', 'Subject: 创建对话', 'Auto-Submitted: auto-replied', 'Message-ID: <a@x>'),
  ).headers
  const autoVerdict = evaluateHeaders(auto, config({ createSubject: DEFAULT_CREATE_SUBJECT }))
  assert.equal(autoVerdict.accepted, false)
  assert.match(autoVerdict.reason, /自动回复/)
})

test('创建对话：关掉该方案后，这四个字不再有任何特权', () => {
  const { headers } = parseHeaderBlock(createHeader())
  const verdict = evaluateHeaders(headers, config({ createSubject: '' }))
  assert.equal(verdict.accepted, false)
  assert.equal(verdict.create, false)
  assert.match(verdict.reason, /不像回复/)
})

test('创建对话：提示词就是邮件正文原样——没有表头、没有 token 行，引用也剥掉', () => {
  const prompt = buildCreatePrompt(
    {
      text: [
        '帮我把 README 的错别字改掉',
        '',
        '> [DSH-0000AA]',
        '> 回复本邮件可以继续这条对话',
        '',
        '在 2026年10月1日 10:07，moodlee@qq.com 写道：',
        '> 上一封通知的原文',
      ].join('\n'),
    },
    config(),
  )
  assert.equal(prompt, '帮我把 README 的错别字改掉')
  assert.equal(prompt.includes('这一轮任务来自一封邮件'), false)
  assert.equal(prompt.includes('发件人'), false)
})

test('创建对话：正文为空时给一句兜底；标题取正文首行', () => {
  assert.match(buildCreatePrompt({ text: '' }, config()), /正文是空的/)
  assert.match(buildCreatePrompt({ text: '> 只剩引文' }, config()), /正文是空的/)
  assert.equal(buildCreateTitle({ text: '帮我把 README 的错别字改掉\n第二行' }), '帮我把 README 的错别字改掉')
  assert.equal(buildCreateTitle({ text: '' }), '邮件：创建对话')
  assert.equal(Array.from(buildCreateTitle({ text: 'x'.repeat(200) })).length, 61)
})

test('编排：首次轮询只记水位，绝不回头处理旧邮件', async () => {
  const client = fakeClient({ uidNext: 100, mails: [{ uid: 99, header: replyHeader() }] })
  const state = normalizeState({})
  const result = await pollOnce({
    client,
    config: config(),
    state,
    deliver: async () => ({ sessionId: 'x', action: 'new' }),
  })
  assert.equal(result.baseline, true)
  assert.equal(result.scanned, 0)
  assert.equal(state.lastUid, 99)
})

test('编排：命中后投递出去、推进水位、记录去重标识（默认追加模式，没有可追加对象就新建）', async () => {
  const client = fakeClient({
    uidNext: 101,
    mails: [{ uid: 100, header: replyHeader(), text: '跑一次复检\r\n' }],
  })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  const seen = []
  const result = await pollOnce({
    client,
    config: config(),
    state,
    deliver: async (mail, target) => {
      seen.push({ mail, target })
      return { sessionId: 'mail-session-1', action: 'new' }
    },
  })
  assert.equal(result.triggered, 1)
  assert.equal(result.decisions[0].sessionId, 'mail-session-1')
  assert.equal(seen[0].target, null, '没有登记过通知时没有可追加的对象')
  assert.match(seen[0].mail.text, /复检/)
  assert.equal(state.lastUid, 100)
  assert.deepEqual(state.handled, ['reply-1@qq.com'])
})

test('编排：dryRun 只判定不建会话，但水位照常推进', async () => {
  const client = fakeClient({ uidNext: 101, mails: [{ uid: 100, header: replyHeader() }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  const result = await pollOnce({
    client,
    config: config(),
    state,
    dryRun: true,
    deliver: async () => {
      throw new Error('dryRun 下不该被调用')
    },
  })
  assert.equal(result.triggered, 0)
  assert.equal(result.decisions[0].accepted, true)
  assert.match(result.decisions[0].reason, /dryRun/)
  assert.equal(state.lastUid, 100)
})

test('编排：preview（手动检查）不改状态、不建会话', async () => {
  const client = fakeClient({ uidNext: 101, mails: [{ uid: 100, header: replyHeader() }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  const result = await pollOnce({
    client,
    config: config(),
    state,
    preview: true,
    deliver: async () => {
      throw new Error('preview 下不该被调用')
    },
  })
  assert.equal(result.decisions[0].accepted, true)
  assert.equal(state.lastUid, 99, 'preview 不得推进水位')
  assert.deepEqual(state.handled, [])
})

test('编排：建会话失败时不推进水位，下一轮重试；连续失败到上限才放弃', async () => {
  const client = fakeClient({ uidNext: 101, mails: [{ uid: 100, header: replyHeader() }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })

  const first = await pollOnce({
    client,
    config: config(),
    state,
    deliver: async () => {
      throw new Error('沙箱拒绝')
    },
  })
  assert.equal(first.triggered, 0)
  assert.equal(first.decisions[0].retryable, true)
  assert.equal(state.lastUid, 99, '失败要留在原地等重试')
  assert.equal(state.attempts['reply-1@qq.com'], 1)

  await pollOnce({
    client,
    config: config(),
    state,
    deliver: async () => {
      throw new Error('沙箱拒绝')
    },
  })
  const third = await pollOnce({
    client,
    config: config(),
    state,
    deliver: async () => {
      throw new Error('沙箱拒绝')
    },
  })
  assert.match(third.decisions[0].reason, /已放弃/)
  assert.equal(state.lastUid, 100, '放弃后水位才推进')
  assert.deepEqual(state.handled, ['reply-1@qq.com'])
})

test('编排：失败后的成功邮件不会被重复触发（水位停在失败处也不会重放）', async () => {
  const client = fakeClient({
    uidNext: 102,
    mails: [
      { uid: 100, header: replyHeader() },
      {
        uid: 101,
        header: header(
          'From: moodlee@qq.com',
          'Subject: Re: DSH 第二封',
          'In-Reply-To: <abc@qq.com>',
          'Message-ID: <reply-2@qq.com>',
        ),
      },
    ],
  })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  let attempts = 0
  const call = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('第一封失败')
    return { sessionId: `s-${attempts}`, action: 'new' }
  }

  // 第一轮：第 100 封失败（水位停在 99），第 101 封成功（已记入 handled）。
  const first = await pollOnce({ client, config: config(), state, deliver: call })
  assert.equal(first.triggered, 1)
  assert.equal(state.lastUid, 99)
  assert.deepEqual(state.handled, ['reply-2@qq.com'])

  // 第二轮：重试第 100 封成功，第 101 封因已处理被跳过——不会多投递一次。
  const second = await pollOnce({
    client,
    config: config(),
    state,
    deliver: async () => ({ sessionId: 's-retry', action: 'new' }),
  })
  assert.equal(second.triggered, 1)
  assert.equal(second.decisions.find((entry) => entry.uid === 101).reason, '这封邮件已经处理过了')
  assert.equal(state.lastUid, 101)
})

test('编排：超过大小上限的邮件直接跳过', async () => {
  const client = fakeClient({
    uidNext: 101,
    mails: [{ uid: 100, header: replyHeader(), text: 'DSH 在正文里', size: 9_000_000 }],
  })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  const result = await pollOnce({
    client,
    config: config({ keywordScope: 'either' }),
    state,
    deliver: async () => ({ sessionId: 'nope', action: 'new' }),
  })
  assert.equal(result.triggered, 0)
  assert.match(result.decisions[0].reason, /超过上限/)
  assert.equal(state.lastUid, 100)
})

test('编排：每小时上限生效', async () => {
  const now = Date.now()
  const client = fakeClient({ uidNext: 101, mails: [{ uid: 100, header: replyHeader() }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 99, recent: [new Date(now).toISOString()] })
  const result = await pollOnce({
    client,
    config: config({ maxPerHour: 1 }),
    state,
    now,
    deliver: async () => ({ sessionId: 'nope', action: 'new' }),
  })
  assert.equal(result.triggered, 0)
  assert.match(result.decisions[0].reason, /每小时 1 次上限/)
})

test('编排：UIDVALIDITY 变化时重置水位，不拿旧 UID 指新邮件', async () => {
  const client = fakeClient({ uidValidity: 42, uidNext: 5, mails: [{ uid: 4, header: replyHeader() }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 4000 })
  const result = await pollOnce({
    client,
    config: config(),
    state,
    deliver: async () => ({ sessionId: 'nope', action: 'new' }),
  })
  assert.equal(result.baseline, true)
  assert.equal(state.uidValidity, 42)
  assert.equal(state.lastUid, 4)
})

test('detectAutomated：正常人工邮件返回 null', () => {
  const { headers } = parseHeaderBlock(replyHeader())
  assert.equal(detectAutomated(headers), null)
})

test('认领会话：主题归一化会剥掉层层 Re:/Fwd:/回复: 前缀', () => {
  assert.equal(normalizeSubject('Re: DSH 任务完成｜改好了'), 'dsh 任务完成｜改好了')
  assert.equal(normalizeSubject('回复: Re: Fwd:   DSH   任务完成｜改好了 '), 'dsh 任务完成｜改好了')
  assert.equal(normalizeSubject('答复：转发：DSH 任务完成'), 'dsh 任务完成')
})

test('token：形状固定、查重、能从引用文本里找出来', () => {
  const state = normalizeState({})
  const first = createToken(state, () => 0.5)
  assert.match(first, /^DSH-[0-9A-F]{6}$/)
  assert.equal(first, 'DSH-800000')

  recordNotification(state, { sessionId: 's-1', subject: '主题', token: first }, 1_000)
  // 随机源换个值，就应当拿到另一个 token；一直撞号时要明确报错而不是死循环。
  const values = [0.5, 0.25]
  const second = createToken(state, () => values.shift() ?? 0.25)
  assert.notEqual(second, first, '已经占用的 token 不能再用')
  assert.equal(second, 'DSH-400000')
  assert.throws(() => createToken(state, () => 0.5), /撞号/)

  assert.equal(findToken(`普通正文\n> [${first}]`), first, '引用行里的 token 也要找得到')
  assert.equal(findToken(`大小写 ${first.toLowerCase()}`), first, '大小写不敏感并归一化成大写')
  assert.equal(findToken('DSH-XYZ123 不是 token'), null)
  assert.equal(findToken(''), null)
})

test('token：页脚形状稳定，整行只有 ASCII 的 token 单独占一行', () => {
  const footer = sessionTokenFooter('DSH-1A2B3C')
  const lines = footer.split('\n')
  assert.equal(lines.at(-1)?.includes('回复'), true)
  assert.equal(lines.some((line) => line.trim() === '[DSH-1A2B3C]'), true, 'token 要单独占一行，避免被折行拆开')
  for (const line of lines) {
    if (line.includes('DSH-')) assert.equal(/^\[DSH-[0-9A-F]{6}\]$/.test(line), true)
  }
})

test('token：不会进到给模型的提示词里', () => {
  const prompt = buildPrompt(
    {
      subject: 'Re: DSH 任务完成',
      from: 'moodlee@qq.com',
      date: '',
      text: `顺手再检查一遍\n\n[DSH-1A2B3C]\n回复本邮件可以继续这条对话。`,
    },
    config(),
  )
  assert.match(prompt, /顺手再检查一遍/)
  assert.equal(prompt.includes('DSH-1A2B3C'), false, 'token 是我们自己的记账信息，不该给模型看')
})

test('认领会话：按主题精确匹配，匹配不到退回最近一次通知，都没有则为 null', () => {
  const state = normalizeState({})
  assert.equal(pickTarget(state, { subject: 'Re: DSH 任务完成' }), null, '还没发过通知时没有可追加的对象')

  recordNotification(state, { sessionId: 'session-a', subject: 'DSH 任务完成｜改好了' }, 1_000)
  recordNotification(state, { sessionId: 'session-b', subject: 'DSH 任务完成｜另一个活' }, 2_000)

  assert.deepEqual(pickTarget(state, { subject: 'Re: DSH 任务完成｜改好了' }), {
    sessionId: 'session-a',
    how: 'subject',
    subject: 'DSH 任务完成｜改好了',
  })
  assert.deepEqual(pickTarget(state, { subject: '回复: DSH 任务完成｜另一个活' }), {
    sessionId: 'session-b',
    how: 'subject',
    subject: 'DSH 任务完成｜另一个活',
  })
  assert.deepEqual(pickTarget(state, { subject: 'Re: 从没见过的主题' }), {
    sessionId: 'session-b',
    how: 'latest',
    subject: 'DSH 任务完成｜另一个活',
  })
})

test('认领会话：正文里的 token 最优先，改标题也能认回来', () => {
  const state = normalizeState({})
  recordNotification(state, { sessionId: 'session-a', subject: 'DSH 任务完成｜改好了', token: 'DSH-0000AA' }, 1_000)
  recordNotification(state, { sessionId: 'session-b', subject: 'DSH 任务完成｜另一个活', token: 'DSH-0000BB' }, 2_000)

  // 主题完全对不上（用户改了标题），但引用了旧通知的 token。
  assert.deepEqual(pickTarget(state, { subject: 'Re: 我自己改的标题', text: '帮我看看\n\n> [DSH-0000AA]\n> 回复本邮件可以继续这条对话' }), {
    sessionId: 'session-a',
    how: 'token',
    token: 'DSH-0000AA',
    subject: 'DSH 任务完成｜改好了',
  })

  // token 大小写不敏感；认不到的 token 退回主题匹配。
  assert.equal(pickTarget(state, { text: '[dsh-0000bb]' }).sessionId, 'session-b')
  assert.equal(pickTarget(state, { subject: 'Re: DSH 任务完成｜另一个活', text: '[DSH-FFFFFF]' }).how, 'subject')
})

test('认领会话：同一主题允许多条登记，主题匹配取最新、token 匹配取自己那条', () => {
  const state = normalizeState({})
  recordNotification(state, { sessionId: 'session-old', subject: 'DSH 任务完成', token: 'DSH-0000AA' }, 1_000)
  recordNotification(state, { sessionId: 'session-new', subject: 'DSH 任务完成', token: 'DSH-0000BB' }, 2_000)
  assert.equal(state.notifications.length, 2, '两条主题相同但 token 不同，都要留着')

  assert.equal(pickTarget(state, { subject: 'Re: DSH 任务完成' }).sessionId, 'session-new', '主题匹配取最新那条')
  assert.equal(
    pickTarget(state, { subject: 'Re: 随便', text: '[DSH-0000AA]' }).sessionId,
    'session-old',
    'token 匹配要能命中较旧那条',
  )

  // 同一 token 再登记（例如重发同一封通知）时按 token 去重。
  recordNotification(state, { sessionId: 'session-old', subject: 'DSH 任务完成', token: 'DSH-0000AA' }, 3_000)
  assert.equal(state.notifications.filter((entry) => entry.token === 'DSH-0000AA').length, 1)
})

test('认领会话：登记数量有上限，状态能往返磁盘', () => {
  const state = normalizeState({})
  for (let index = 0; index < 60; index += 1) {
    recordNotification(state, { sessionId: `s-${index}`, subject: `主题 ${index}` }, index)
  }
  assert.equal(state.notifications.length, 50)
  assert.equal(state.notifications.at(-1).sessionId, 's-59')

  const restored = normalizeState(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored.notifications, state.notifications)
  assert.deepEqual(normalizeState({ notifications: 'nope' }).notifications, [])
})

test('状态：最近一次投递结果能往返磁盘，坏字段退回 null', () => {
  const state = normalizeState({
    uidValidity: 7,
    lastUid: 99,
    lastDelivery: {
      at: '2026-10-01T00:00:00.000Z',
      action: 'new',
      target: 'session-x',
      workspace: 'C:/proj（模型按邮件内容挑的）',
      error: 'boom',
    },
  })
  assert.deepEqual(state.lastDelivery, {
    at: '2026-10-01T00:00:00.000Z',
    action: 'new',
    sessionId: null,
    target: 'session-x',
    how: null,
    workspace: 'C:/proj（模型按邮件内容挑的）',
    error: 'boom',
  })
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))).lastDelivery, state.lastDelivery)
  assert.equal(normalizeState({}).lastDelivery, null)
  assert.equal(normalizeState({ lastDelivery: { action: '随便什么' } }).lastDelivery, null)
  assert.equal(normalizeState({ lastDelivery: 'nope' }).lastDelivery, null)
  assert.equal(normalizeState({ lastDelivery: { action: 'new' } }).lastDelivery.workspace, null, '旧状态文件没有这个字段')
})

test('状态：最近一次轮询的逐封判定能往返磁盘，坏字段退回 null', () => {
  const state = normalizeState({})
  state.lastScan = scanRecord(
    {
      scanned: 2,
      triggered: 1,
      baseline: false,
      decisions: [
        { uid: 100, subject: '创建新对话', accepted: false, reason: '不像回复', from: 'moodlee@qq.com' },
        { uid: 101, subject: '创建对话', accepted: true, reason: '新建了会话 mail-x', action: 'new', sessionId: 'mail-x' },
      ],
    },
    1_000,
  )
  assert.equal(state.lastScan.at, '1970-01-01T00:00:01.000Z')
  assert.equal(state.lastScan.scanned, 2)
  assert.equal(state.lastScan.triggered, 1)
  assert.deepEqual(state.lastScan.decisions[0], {
    uid: 100,
    subject: '创建新对话',
    accepted: false,
    reason: '不像回复',
    from: 'moodlee@qq.com',
  })
  assert.equal(state.lastScan.decisions[1].action, 'new')
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))).lastScan, state.lastScan)

  assert.equal(normalizeState({}).lastScan, null, '旧状态文件没有这个字段')
  assert.equal(normalizeState({ lastScan: 'nope' }).lastScan, null)
  assert.equal(normalizeState({ lastScan: { decisions: [{}, 'x'] } }).lastScan, null, '没有时间戳、也没有一条像样的明细 = 当没有')
  const partial = normalizeState({ lastScan: { at: '2026-10-02T08:18:00.000Z', decisions: [{ uid: 5, accepted: 'yes' }] } }).lastScan
  assert.deepEqual(partial, {
    at: '2026-10-02T08:18:00.000Z',
    scanned: 0,
    triggered: 0,
    baseline: false,
    decisions: [{ uid: 5, subject: '', accepted: false, reason: '' }],
  })
})

test('编排：被跳过的邮件在状态里留下判定原因（事后还能查「为什么没触发」）', async () => {
  const client = fakeClient({ uidNext: 4280, mails: [{ uid: 4273, header: createHeader('创建新对话') }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 4272 })

  const result = await pollOnce({
    client,
    // 只认一条老说法：模拟修复之前的行为。
    config: config({ createSubject: DEFAULT_CREATE_SUBJECT }),
    state,
    deliver: async () => {
      throw new Error('不该投递')
    },
  })

  assert.equal(result.triggered, 0)
  assert.equal(state.lastUid, 4273, '跳过的邮件照样推进水位')
  state.lastScan = scanRecord(result, 1_000)
  const saved = normalizeState(JSON.parse(JSON.stringify(state))).lastScan
  assert.equal(saved.decisions.length, 1)
  assert.equal(saved.decisions[0].subject, '创建新对话')
  assert.equal(saved.decisions[0].accepted, false)
  assert.match(saved.decisions[0].reason, /不像回复/, '原因要留下来，而不是只剩「没效果」')
})

test('编排：追加模式下把目标会话交给投递方', async () => {
  const client = fakeClient({
    uidNext: 101,
    mails: [{ uid: 100, header: replyHeader(), text: '接着上次的活干\r\n' }],
  })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  recordNotification(state, { sessionId: 'session-original', subject: 'DSH 任务完成' }, 1_000)

  const seen = []
  const result = await pollOnce({
    client,
    config: config(),
    state,
    deliver: async (mail, target) => {
      seen.push({ mail, target })
      return { sessionId: target?.sessionId ?? 'new-session', action: target === null ? 'new' : 'append' }
    },
  })

  assert.equal(result.triggered, 1)
  assert.equal(seen[0].target.sessionId, 'session-original')
  assert.equal(seen[0].target.how, 'subject')
  assert.equal(result.decisions[0].sessionId, 'session-original')
  assert.equal(result.decisions[0].action, 'append')
  assert.match(result.decisions[0].reason, /追加到会话/)
})

test('编排：投递方回报「改成了新建」时，决策日志照实说，不谎报成追加', async () => {
  const client = fakeClient({ uidNext: 101, mails: [{ uid: 100, header: replyHeader() }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  recordNotification(state, { sessionId: 'session-original', subject: 'DSH 任务完成' }, 1_000)

  const result = await pollOnce({
    client,
    config: config(),
    state,
    // 宿主内部追加失败后退回新建——动作以它回报的为准。
    deliver: async () => ({ sessionId: 'mail-fallback', action: 'new' }),
  })
  assert.equal(result.decisions[0].action, 'new')
  assert.equal(result.decisions[0].sessionId, 'mail-fallback')
  assert.match(result.decisions[0].reason, /新建了会话 mail-fallback/)
  assert.equal(result.decisions[0].reason.includes('追加'), false)
})

test('编排：new 模式下即使登记过通知也要求新建会话', async () => {
  const client = fakeClient({ uidNext: 101, mails: [{ uid: 100, header: replyHeader() }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  recordNotification(state, { sessionId: 'session-original', subject: 'DSH 任务完成' }, 1_000)

  const seen = []
  const result = await pollOnce({
    client,
    config: config({ mode: 'new' }),
    state,
    deliver: async (mail, target) => {
      seen.push(target)
      return { sessionId: 'brand-new', action: 'new' }
    },
  })
  assert.equal(seen[0], null)
  assert.match(result.decisions[0].reason, /新建了会话/)
})

test('编排：preview 会说明这条回复会落到哪个会话，但不投递', async () => {
  const client = fakeClient({ uidNext: 101, mails: [{ uid: 100, header: replyHeader() }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  recordNotification(state, { sessionId: 'session-original', subject: 'DSH 任务完成' }, 1_000)

  const result = await pollOnce({
    client,
    config: config(),
    state,
    preview: true,
    deliver: async () => {
      throw new Error('preview 不该投递')
    },
  })
  assert.match(result.decisions[0].reason, /session-original/)
  assert.equal(state.lastUid, 99)
})

test('编排：创建对话方案无条件新建——即便登记过同主题通知、正文还带着 token', async () => {
  const client = fakeClient({
    uidNext: 101,
    mails: [{ uid: 100, header: createHeader(), text: '帮我把 README 的错别字改掉\n\n> [DSH-0000AA]\n' }],
  })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })
  recordNotification(state, { sessionId: 'session-old', subject: '创建对话', token: 'DSH-0000AA' }, 1_000)

  const seen = []
  const result = await pollOnce({
    client,
    // 追加模式（默认）也不该把「创建对话」追加进已有会话。
    config: config({ createSubject: DEFAULT_CREATE_SUBJECT }),
    state,
    deliver: async (mail, target) => {
      seen.push({ mail, target })
      return { sessionId: 'mail-created', action: 'new' }
    },
  })

  assert.equal(result.triggered, 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].target, null, '创建对话不认领已有会话')
  assert.equal(seen[0].mail.create, true)
  assert.equal(seen[0].mail.text.includes('DSH-0000AA'), true, '正文原样交给调用方，剥壳是提示词那一层的事')
  assert.equal(result.decisions[0].create, true)
  assert.equal(result.decisions[0].action, 'new')
  assert.match(result.decisions[0].reason, /创建对话/)
  assert.match(result.decisions[0].reason, /新建了会话 mail-created/)
})

test('编排：preview 也会照实说明「创建对话」会新建会话', async () => {
  const client = fakeClient({ uidNext: 101, mails: [{ uid: 100, header: createHeader(), text: '看一眼\r\n' }] })
  const state = normalizeState({ uidValidity: 7, lastUid: 99 })

  const result = await pollOnce({
    client,
    config: config({ createSubject: DEFAULT_CREATE_SUBJECT }),
    state,
    preview: true,
    deliver: async () => {
      throw new Error('preview 不该投递')
    },
  })
  assert.equal(result.decisions[0].accepted, true)
  assert.equal(result.decisions[0].create, true)
  assert.match(result.decisions[0].reason, /没有投递/)
  assert.equal(state.lastUid, 99)
})
