/**
 * 端到端接线测试：`createReplyPoller` + 假 IMAP 服务器 + 假 agents / sessionController。
 *
 * 验证「邮件真的变成了会话里的一条用户消息」这条链路的每一环：
 * UID 水位 → 判定 → 拉正文 → 认领会话（追加）或新建 → 投递消息；
 * 以及不投递的情况（自己的通知、重复轮询、只读检查、dryRun）。
 *
 * 全程不联网、不碰真实邮箱、不建真实会话。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createReplyPoller, normalizeConfig, renderReplyStatus } from '../index.mjs'

/** 把若干行拼成 CRLF 结尾的信头。 */
const header = (...rows) => rows.join('\r\n')

/** 一封人工回复的信头（主题是 `Re: DSH 任务完成` 的 RFC 2047 编码形式）。 */
const replyHeaders = (messageId, extra = []) =>
  header(
    'From: me@qq.com',
    'To: moodlee@qq.com',
    'Subject: =?UTF-8?B?UmU6IERTSCDku7vliqHlrozmiJA=?=',
    'In-Reply-To: <notice@qq.com>',
    'References: <notice@qq.com>',
    `Message-ID: <${messageId}>`,
    'Date: Thu, 01 Oct 2026 10:30:00 +0800',
    ...extra,
  )

/** 一封本插件自己发出的通知：不是回复，也没有引用。 */
const noticeHeaders = (messageId) =>
  header(
    'From: me@qq.com',
    'To: me@qq.com',
    'Subject: =?UTF-8?B?RFNIIOS7u+WKoeWujOaIkA==?=',
    `Message-ID: <${messageId}>`,
    'Date: Thu, 01 Oct 2026 10:00:00 +0800',
  )

/** 一封「创建对话」邮件：标题正好是那四个字（RFC 2047 编码），不回复任何通知。 */
const createHeaders = (messageId) =>
  header(
    'From: me@qq.com',
    'To: moodlee@qq.com',
    'Subject: =?UTF-8?B?5Yib5bu65a+56K+d?=',
    `Message-ID: <${messageId}>`,
    'Date: Thu, 01 Oct 2026 10:30:00 +0800',
  )

/**
 * 起一个能按 UID 提供邮件的假 IMAP 服务器。
 * @param {object} options - 初始邮箱状态。
 * @returns {Promise<object>} 服务器句柄（含可变的 mails 表与 add 方法）。
 */
async function startFakeImap({ uidValidity = 11, uidNext = 1 } = {}) {
  /** @type {Map<number, { header: string, text: string }>} */
  const mails = new Map()
  let nextUid = uidNext

  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('* OK [CAPABILITY IMAP4rev1] fake ready\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const space = line.indexOf(' ')
        const tag = line.slice(0, space)
        const command = line.slice(space + 1)
        const upper = command.toUpperCase()

        if (upper.startsWith('CAPABILITY')) {
          socket.write('* CAPABILITY IMAP4rev1\r\n')
          socket.write(`${tag} OK done\r\n`)
        } else if (upper.startsWith('LOGIN') || upper.startsWith('LOGOUT')) {
          if (upper.startsWith('LOGOUT')) socket.write('* BYE bye\r\n')
          socket.write(`${tag} OK done\r\n`)
          if (upper.startsWith('LOGOUT')) socket.end()
        } else if (upper.startsWith('SELECT')) {
          socket.write(`* ${mails.size} EXISTS\r\n`)
          socket.write(`* OK [UIDVALIDITY ${uidValidity}] ok\r\n`)
          socket.write(`* OK [UIDNEXT ${nextUid}] ok\r\n`)
          socket.write(`${tag} OK done\r\n`)
        } else if (upper.startsWith('UID SEARCH')) {
          const min = Number(/UID (\d+):/.exec(command)?.[1] ?? 0)
          const found = [...mails.keys()].filter((uid) => uid >= min).sort((a, b) => a - b)
          socket.write(`* SEARCH${found.map((uid) => ` ${uid}`).join('')}\r\n`)
          socket.write(`${tag} OK done\r\n`)
        } else if (upper.includes('BODY.PEEK[HEADER]')) {
          const uid = Number(/UID FETCH (\d+)/i.exec(command)?.[1])
          const mail = mails.get(uid)
          if (mail === undefined) {
            socket.write(`${tag} NO 没有这封邮件\r\n`)
          } else {
            const headerBytes = Buffer.from(`${mail.header}\r\n\r\n`, 'utf8')
            socket.write(`* ${uid} FETCH (UID ${uid} BODY[HEADER] {${headerBytes.length}}\r\n`)
            socket.write(headerBytes)
            socket.write(` RFC822.SIZE ${headerBytes.length + Buffer.byteLength(mail.text)})\r\n`)
            socket.write(`${tag} OK done\r\n`)
          }
        } else if (upper.includes('BODY.PEEK[TEXT]')) {
          const uid = Number(/UID FETCH (\d+)/i.exec(command)?.[1])
          const mail = mails.get(uid)
          if (mail === undefined) {
            socket.write(`${tag} NO 没有这封邮件\r\n`)
          } else {
            const text = Buffer.from(mail.text, 'utf8')
            socket.write(`* ${uid} FETCH (UID ${uid} BODY[TEXT] {${text.length}}\r\n`)
            socket.write(text)
            socket.write(')\r\n')
            socket.write(`${tag} OK done\r\n`)
          }
        } else {
          socket.write(`${tag} BAD 未知命令\r\n`)
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    port,
    mails,
    /** 追加一封邮件并返回它的 UID。 */
    add(mailHeader, text) {
      const uid = nextUid
      nextUid += 1
      mails.set(uid, { header: mailHeader, text })
      return uid
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/**
 * 造一个只提供本插件用到的那几个服务的假 ctx。
 *
 * `sessionController.resolveAgent` 默认按**真宿主**的契约返回
 * `{ agent } | { error }`（`ApiSessionAgentResult`，见
 * `@deepseek-ai/dsh-api-session-controller/lib/typert.host.js`）；
 * `bareAgent: true` 用来覆盖早期替身那种「直接返回 agent 对象」的写法。
 * @param {{ resolveError?: string | null, bareAgent?: boolean, workspaces?: object[], llmAnswer?: string | null, withoutLlm?: boolean }} [options] - `resolveError` 非空时假 sessionController 返回错误；`bareAgent` 为 true 时直接返回 agent；`workspaces` 是假工作区列表；`llmAnswer` 是假模型的回答；`withoutLlm` 为 true 时宿主没有 llm 服务。
 * @returns {object} 假上下文与观测点。
 */
function createCtx({ resolveError = null, bareAgent = false, workspaces = [], llmAnswer = null, withoutLlm = false } = {}) {
  const created = []
  const sent = []
  const mounted = []
  const attached = []
  const renamed = []
  const disposed = []
  const logs = []
  const resolveCalls = []
  const appended = []
  const llmCalls = []
  const record = (level) => (...args) => logs.push({ level, text: args.join(' ') })

  const services = {
    agents: {
      async create(options) {
        created.push(options)
        const agent = {
          session: { id: options.sessionId, header: {} },
          followup: (message) => sent.push({ sessionId: options.sessionId, message }),
          whenIdle: async () => {},
        }
        // 真宿主在发布之前会 await setup；假宿主也要照做，否则挂 preset 这条
        // 线路根本没被验证过。
        if (typeof options.setup === 'function') await options.setup({ session: agent.session }, agent)
        return {
          agent,
          dispose: async () => {
            disposed.push(options.sessionId)
          },
        }
      },
    },
    sessionController: {
      async resolveAgent(sessionId) {
        resolveCalls.push(sessionId)
        if (resolveError !== null) return { error: { message: resolveError } }
        const agent = {
          session: { id: sessionId },
          followup: (message) => appended.push({ sessionId, message }),
        }
        return bareAgent ? agent : { agent }
      },
    },
    agentPresets: {
      resolve: async () => ({ id: 'standard' }),
      mount: async (_agentCtx, id) => {
        mounted.push(id)
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    },
    workspaceRegistry: {
      create: async (path) => ({
        path,
        attachSession: async (id) => {
          attached.push(id)
        },
        detachSession: async () => {},
      }),
      // 真宿主的 list() 返回 Workspace 实体（path/title/sessionIds 都是 getter）。
      list: () => workspaces,
    },
    sessionTitle: {
      rename: (_session, title) => {
        renamed.push(title)
      },
    },
  }
  if (!withoutLlm) {
    // 假 llm：只实现 stream，吐一段文本 + 结束标记——与真宿主的 StreamChunk 同形。
    services.llm = {
      stream(options) {
        llmCalls.push(options)
        const answer = llmAnswer ?? 'UNKNOWN'
        return (async function* generate() {
          yield { type: 'text-delta', index: 0, text: answer }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  }

  return {
    ctx: {
      logger: { info: record('info'), warn: record('warn'), error: record('error') },
      get: (name) => services[name],
      on: () => () => {},
      inject: () => {},
      effect: (callback) => callback(),
    },
    created,
    sent,
    mounted,
    attached,
    renamed,
    disposed,
    logs,
    resolveCalls,
    appended,
    llmCalls,
  }
}

/** 一份开启收信触发的配置；状态文件写到临时目录，测完删除。 */
function replyConfig(port, extra = {}) {
  const stateFile = join(tmpdir(), `dsh-mail-notify-test-${randomUUID()}.json`)
  const config = normalizeConfig({
    smtp: { user: 'me@qq.com' },
    to: ['me@qq.com'],
    authCode: 'dummy',
    reply: {
      enabled: true,
      host: '127.0.0.1',
      port,
      secure: false,
      allowInsecure: true,
      from: ['me@qq.com'],
      cwd: 'C:/tmp/workspace',
      intervalSeconds: 3600,
      stateFile,
      ...extra,
    },
  })
  return { config, stateFile }
}

test('端到端：没有可追加的会话时新建（cwd/preset/模型/标题/分组都对）', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    // 1) 先放一封旧邮件：首次轮询只该建立水位，不处理它。
    server.add(replyHeaders('old@qq.com', ['X-Old: yes']), '旧邮件不该被处理\r\n')
    const baseline = await poller.run()
    assert.equal(baseline.baseline, true)
    assert.equal(harness.created.length, 0, '首次轮询建立水位，绝不回溯处理')

    // 2) 新来一封回复：状态里没有任何通知记录，所以只能新建会话。
    server.add(
      replyHeaders('reply-9@qq.com'),
      '把这个项目的测试再跑一遍\r\n\r\n在 2026年10月1日 10:07，moodlee@qq.com 写道：\r\n> 上一封通知\r\n',
    )
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.equal(harness.created.length, 1)

    const [session] = harness.created
    assert.match(session.sessionId, /^mail-/)
    assert.equal(session.meta.cwd, 'C:/tmp/workspace')
    assert.equal(session.meta.agentPreset, 'standard')
    assert.deepEqual(session.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.equal(typeof session.setup, 'function', 'preset 必须在发布前挂上')

    assert.deepEqual(harness.mounted, ['standard'])
    assert.deepEqual(harness.attached, [session.sessionId], '会话要归入项目分组')
    assert.deepEqual(harness.renamed, ['邮件：DSH 任务完成'])

    // 3) 第一条用户消息的形态：id/role/content/source 都要齐，引用历史要被剥掉。
    assert.equal(harness.sent.length, 1)
    const message = harness.sent[0].message
    assert.equal(harness.sent[0].sessionId, session.sessionId)
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
    assert.equal(message.id.length > 0, true)
    assert.deepEqual(message.source, { kind: 'cordis-host-runner' })
    assert.equal(message.content[0].type, 'text')
    assert.match(message.content[0].text, /主题: Re: DSH 任务完成/)
    assert.match(message.content[0].text, /把这个项目的测试再跑一遍/)
    assert.equal(message.content[0].text.includes('上一封通知'), false, '引用历史不该进提示词')

    assert.match(poller.status.decisions[0].reason, /新建了会话/)

    // 4) 状态文件要记下新水位与去重标识。
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.lastUid, 2)
    assert.deepEqual(saved.handled, ['reply-9@qq.com'])
    assert.equal(saved.recent.length, 1)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：追加模式把回复作为用户消息投进原来那个会话', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run() // 建立水位

    // 模拟「刚发出去一封通知」：发信成功后会把主题与所属会话登记下来。
    const subject = 'DSH 任务完成｜把标题摘要改好了'
    poller.rememberNotification('session-original', subject)
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.notifications.length, 1)
    assert.equal(saved.notifications[0].sessionId, 'session-original')
    assert.equal(saved.notifications[0].subject, subject)

    // 回复这封通知：主题带 Re:，正文是新任务，并带一段引用历史。
    server.add(
      header(
        'From: me@qq.com',
        'To: moodlee@qq.com',
        `Subject: Re: ${subject}`,
        'In-Reply-To: <notice@qq.com>',
        'References: <notice@qq.com>',
        'Message-ID: <append-1@qq.com>',
        'Date: Thu, 01 Oct 2026 10:30:00 +0800',
      ),
      '再顺手把测试补上\r\n\r\n在 2026年10月1日 10:07，moodlee@qq.com 写道：\r\n> 上一封通知的内容\r\n',
    )
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.deepEqual(harness.resolveCalls, ['session-original'], '应当去打开原来那个会话')
    assert.equal(harness.created.length, 0, '追加模式不该新建会话')
    assert.equal(harness.appended.length, 1)
    assert.equal(harness.appended[0].sessionId, 'session-original')

    const message = harness.appended[0].message
    assert.equal(message.role, 'user')
    assert.deepEqual(message.source, { kind: 'cordis-host-runner' })
    assert.match(message.content[0].text, /再顺手把测试补上/)
    assert.equal(message.content[0].text.includes('上一封通知的内容'), false)
    assert.match(message.content[0].text, new RegExp(`主题: Re: ${subject}`))

    assert.equal(result.decisions[0].how, 'subject', '应当按主题匹配上，而不是退回最近一条')
    assert.match(result.decisions[0].reason, /追加到会话 session-original/)

    // 投递结果要落到状态文件里，否则「又新建了一个会话」在报告里没有下文。
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(persisted.lastDelivery.action, 'append')
    assert.equal(persisted.lastDelivery.sessionId, 'session-original')
    assert.equal(persisted.lastDelivery.error, null)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：老式「resolveAgent 直接返回 agent」的宿主照样能追加（兼容分支）', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx({ bareAgent: true })
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    poller.rememberNotification('session-legacy', 'DSH 任务完成｜老宿主')
    server.add(replyHeaders('legacy@qq.com'), '接着干\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.equal(harness.created.length, 0, '兼容分支不该退回新建')
    assert.equal(harness.appended.length, 1)
    assert.match(result.decisions[0].reason, /追加到会话 session-legacy/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：主题对不上时退回最近一次通知的会话', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    poller.rememberNotification('session-a', 'DSH 任务完成｜第一件事')
    poller.rememberNotification('session-b', 'DSH 任务完成｜第二件事')

    server.add(replyHeaders('mismatch@qq.com'), '主题对不上也照样投递\r\n')
    const result = await poller.run()

    assert.deepEqual(harness.resolveCalls, ['session-b'], '退回最近一次通知的会话')
    assert.equal(result.decisions[0].how, 'latest')
    assert.match(result.decisions[0].reason, /未按 token 认到/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：追加失败（会话没了/写锁被占）时退回新建会话，不丢这封邮件', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx({ resolveError: 'session "session-gone" not found' })
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    poller.rememberNotification('session-gone', 'DSH 任务完成｜已经删掉的那个会话')

    server.add(replyHeaders('fallback@qq.com'), '还是得跑起来\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.deepEqual(harness.resolveCalls, ['session-gone'])
    assert.equal(harness.created.length, 1, '追加失败要退回新建会话')
    assert.match(result.decisions[0].reason, /新建了会话/)
    assert.equal(
      harness.logs.some((entry) => entry.level === 'warn' && entry.text.includes('追加到会话 session-gone 失败')),
      true,
      '追加失败要留下 warn 日志',
    )

    // 失败原因同时写进状态文件：`mail_notify status` 靠它解释「为什么又新建了」。
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.lastDelivery.action, 'new')
    assert.equal(saved.lastDelivery.target, 'session-gone')
    assert.match(saved.lastDelivery.error, /not found/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：回复里引用正文 token 时，即使标题被改也认出原会话', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()

    // 先登记两封通知：老的那封消息主题是「第一件事」，新的那封是「第二件事」。
    poller.rememberNotification('session-first', 'DSH 任务完成｜第一件事', 'DSH-0000AA')
    poller.rememberNotification('session-second', 'DSH 任务完成｜第二件事', 'DSH-0000BB')

    // 回复老的那封：标题被用户改过（仍然带关键字），和登记的两条主题都对不上，
    // 只有引用里留着它的 token —— 这时应当由 token 决定去哪条会话。
    server.add(
      header(
        'From: me@qq.com',
        'Subject: =?UTF-8?B?UmU6IERTSCDmiJHoh6rlt7HmlLnnmoTmoIfpopg=?=', // Re: DSH 我自己改的标题
        'In-Reply-To: <notice@qq.com>',
        'Message-ID: <token-1@qq.com>',
      ),
      ['接着第一件事往下干', '', '在 2026年10月1日 11:30，moodlee@qq.com 写道：', '> [DSH-0000AA]', '> 回复本邮件可以继续这条对话'].join('\r\n'),
    )
    const result = await poller.run()

    assert.deepEqual(harness.resolveCalls, ['session-first'], '要按 token 认到较旧那条会话')
    assert.equal(result.decisions[0].how, 'token')
    assert.equal(result.decisions[0].token, 'DSH-0000AA')
    assert.match(result.decisions[0].reason, /追加到会话 session-first/)
    assert.equal(harness.created.length, 0)

    // token 行不该进提示词。
    const text = harness.appended[0].message.content[0].text
    assert.match(text, /接着第一件事往下干/)
    assert.equal(text.includes('DSH-0000AA'), false)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：poller 会发 token 并登记；关掉 token 时不发', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    const token = poller.createNotificationToken()
    assert.match(token, /^DSH-[0-9A-F]{6}$/)
    const again = poller.createNotificationToken()
    assert.notEqual(again, token, '同一轮里连发两封也不能撞号')

    poller.rememberNotification('session-x', 'DSH 任务完成｜某件事', token)
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.notifications.at(-1).token, token)
    assert.equal(saved.notifications.at(-1).sessionId, 'session-x')

    // 关掉 token 时不再生成。
    const off = createReplyPoller({ ctx: harness.ctx, config: { ...config, reply: { ...config.reply, token: false } } })
    assert.equal(off.createNotificationToken(), null)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：mode 为 new 时即使登记过通知也新建会话', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port, { mode: 'new' })
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    poller.rememberNotification('session-original', 'DSH 任务完成｜上一次的活')
    server.add(replyHeaders('newmode@qq.com'), '这次要开新会话\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.deepEqual(harness.resolveCalls, [], 'new 模式不该去动已有会话')
    assert.equal(harness.created.length, 1)
    assert.match(result.decisions[0].reason, /新建了会话/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：标题「创建对话」新建会话，邮件正文原样就是对话内容', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  // 刻意用默认的追加模式：创建对话方案不该被 mode 影响，也不该被通知登记表影响。
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run() // 建立水位
    // 登记一条同主题（还带 token）的通知：普通回复会被认领，创建对话不会。
    poller.rememberNotification('session-original', '创建对话', 'DSH-0000AA')

    server.add(
      header(
        'From: me@qq.com',
        'To: moodlee@qq.com',
        'Subject: =?UTF-8?B?5Yib5bu65a+56K+d?=', // 「创建对话」
        'Message-ID: <create-1@qq.com>',
        'Date: Thu, 01 Oct 2026 10:30:00 +0800',
      ),
      [
        '帮我把 README 的错别字改掉',
        '',
        '> [DSH-0000AA]',
        '> 回复本邮件可以继续这条对话',
        '',
        '在 2026年10月1日 10:07，moodlee@qq.com 写道：',
        '> 上一封通知的原文',
        '',
      ].join('\r\n'),
    )
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.deepEqual(harness.resolveCalls, [], '创建对话不该去打开已有会话')
    assert.equal(harness.appended.length, 0, '创建对话不该追加')
    assert.equal(harness.created.length, 1, '创建对话要新建会话')
    // 标题取正文首行：固定写「创建对话」当会话名毫无信息量。
    assert.deepEqual(harness.renamed, ['帮我把 README 的错别字改掉'])

    const message = harness.sent[0].message
    assert.equal(message.role, 'user')
    assert.deepEqual(message.source, { kind: 'cordis-host-runner' })
    assert.equal(message.content[0].text, '帮我把 README 的错别字改掉', '正文原样，不加「来自邮件」表头')
    assert.match(result.decisions[0].reason, /创建对话/)
    assert.match(result.decisions[0].reason, /新建了会话/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：默认也认「创建新对话」；跳过的邮件与原因一并留在状态文件里', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run() // 建立水位
    // 第一封：带尾巴的标题，谁都不认（这一封正是线上踩过的坑：静默跳过、查不出原因）。
    server.add(
      header(
        'From: me@qq.com',
        'To: moodlee@qq.com',
        'Subject: =?UTF-8?B?5Yib5bu65paw5a+56K+d77ya6aG65L6/5pS55LiqIGJ1Zw==?=', // 「创建新对话：顺便改个 bug」
        'Message-ID: <create-new-tail@qq.com>',
      ),
      '不该触发\r\n',
    )
    // 第二封：默认三条说法里的一条，应当新建会话。
    server.add(
      header(
        'From: me@qq.com',
        'To: moodlee@qq.com',
        'Subject: =?UTF-8?B?5Yib5bu65paw5a+56K+d?=', // 「创建新对话」
        'Message-ID: <create-new@qq.com>',
      ),
      '研究通过素材最终生成视频的解决方案。\r\n',
    )
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.equal(harness.appended.length, 0)
    assert.equal(harness.created.length, 1, '「创建新对话」也该新建会话')
    assert.deepEqual(harness.renamed, ['研究通过素材最终生成视频的解决方案。'], '标题取正文首行')
    assert.equal(harness.sent[0].message.content[0].text, '研究通过素材最终生成视频的解决方案。')

    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.lastScan.decisions.length, 2)
    assert.equal(saved.lastScan.decisions[0].accepted, false)
    assert.equal(saved.lastScan.decisions[0].subject, '创建新对话：顺便改个 bug')
    assert.match(saved.lastScan.decisions[0].reason, /不像回复/, '跳过的那封也要留下原因')
    assert.equal(saved.lastScan.decisions[1].accepted, true)
    assert.match(saved.lastScan.decisions[1].reason, /创建新对话/)
    assert.match(saved.lastScan.decisions[1].reason, /新建了会话/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：创建对话要标题一字不差；关掉方案后连那四个字也不触发', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port, { createSubject: false })
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run() // 建立水位
    // 带尾巴的标题不算「创建对话」（即便方案开着也不认）。
    server.add(
      header(
        'From: me@qq.com',
        'To: moodlee@qq.com',
        'Subject: =?UTF-8?B?5Yib5bu65a+56K+d77ya5pS55LiqIGJ1Zw==?=', // 「创建对话：改个 bug」
        'Message-ID: <create-tail@qq.com>',
      ),
      '不该触发\r\n',
    )
    // 一字不差，但配置里已经关掉了这个方案。
    server.add(
      header(
        'From: me@qq.com',
        'To: moodlee@qq.com',
        'Subject: =?UTF-8?B?5Yib5bu65a+56K+d?=',
        'Message-ID: <create-off@qq.com>',
      ),
      '也不该触发\r\n',
    )
    const result = await poller.run()

    assert.equal(result.triggered, 0)
    assert.equal(harness.created.length + harness.appended.length, 0)
    assert.match(result.decisions[0].reason, /不像回复/)
    assert.match(result.decisions[1].reason, /不像回复/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('状态报告：最近一次轮询里被跳过的邮件与原因也列出来（不联网，只读状态文件）', () => {
  // 端口给个必然连不上的值：这份报告只渲染文案，不会去连任何服务器。
  const { config, stateFile } = replyConfig(1)
  writeFileSync(
    stateFile,
    JSON.stringify({
      uidValidity: 1449722906,
      lastUid: 4273,
      lastScan: {
        at: '2026-10-02T08:18:21.763Z',
        scanned: 1,
        triggered: 0,
        baseline: false,
        decisions: [
          {
            uid: 4273,
            subject: '创建新对话',
            accepted: false,
            reason: '不像回复（没有 In-Reply-To/References，主题也不以 Re: 开头）',
            from: 'moodlee@qq.com',
          },
        ],
      },
    }),
  )

  try {
    const poller = createReplyPoller({ ctx: createCtx().ctx, config })
    const text = renderReplyStatus(config, poller)
    assert.match(text, /创建对话方案：标题正好是 「创建对话」 「创建新对话」 「新建对话」 时无条件新建会话/)
    assert.match(text, /最近一次轮询：2026-10-02T08:18:21\.763Z，扫描 1 封，触发 0 次/)
    assert.match(text, /✘ 跳过 UID 4273「创建新对话」：不像回复/)
  } finally {
    rmSync(stateFile, { force: true })
  }
})

test('端到端：cwd 为 auto 时，邮件里写明了工作区路径就直接用它（不花模型的钱）', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port, { cwd: 'auto' })
  const harness = createCtx({
    workspaces: [
      { path: 'C:/work/alpha', title: 'alpha' },
      { path: 'C:/work/beta', title: 'beta', sessionIds: ['s1'] },
    ],
  })
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run() // 建立水位
    poller.rememberCwd('C:/work/beta') // 上一次活跃的是 beta，但邮件写的是 alpha
    server.add(createHeaders('create-path@qq.com'), '在 C:\\work\\alpha 里补一段日志\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.equal(harness.created[0].meta.cwd, 'C:/work/alpha', '邮件里写明了就以它为准')
    assert.equal(harness.llmCalls.length, 0, '确定性认出来了就不该再去问模型')
    assert.deepEqual(harness.attached, [harness.created[0].sessionId], '会话归入该工作区分组')

    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.match(saved.lastDelivery.workspace, /C:\/work\/alpha/)
    assert.match(saved.lastDelivery.workspace, /邮件里写的路径/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：cwd 为 auto 且邮件没线索时，让默认模型从已登记工作区里挑', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port, { cwd: 'auto' })
  const harness = createCtx({
    workspaces: [
      { path: 'C:/work/alpha', title: 'alpha' },
      { path: 'C:/work/beta', title: 'beta' },
    ],
    llmAnswer: 'C:/work/beta',
  })
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    server.add(createHeaders('create-llm@qq.com'), '帮我把那个登录页的样式调一下\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.equal(harness.created[0].meta.cwd, 'C:/work/beta')
    assert.equal(harness.llmCalls.length, 1)
    assert.equal(harness.llmCalls[0].provider, 'deepseek-official', '用当前默认模型')
    assert.match(harness.llmCalls[0].messages[0].content[0].text, /登录页/, '提示词里要带上邮件正文')
    assert.match(harness.llmCalls[0].messages[0].content[0].text, /C:\/work\/alpha/, '提示词里要带上候选列表')

    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.match(saved.lastDelivery.workspace, /C:\/work\/beta/)
    assert.match(saved.lastDelivery.workspace, /模型/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：cwd 为 auto 时，模型说 UNKNOWN 或列表外路径都退回上一次的目录', async () => {
  for (const llmAnswer of ['UNKNOWN', 'C:/work/不存在的目录']) {
    const server = await startFakeImap({ uidNext: 1 })
    const { config, stateFile } = replyConfig(server.port, { cwd: 'auto' })
    const harness = createCtx({
      workspaces: [
        { path: 'C:/work/alpha', title: 'alpha' },
        { path: 'C:/work/beta', title: 'beta' },
      ],
      llmAnswer,
    })
    const poller = createReplyPoller({ ctx: harness.ctx, config })

    try {
      await poller.run()
      poller.rememberCwd('C:/work/beta')
      server.add(createHeaders('create-unknown@qq.com'), '随便聊点别的\r\n')
      const result = await poller.run()

      assert.equal(result.triggered, 1, `llmAnswer=${llmAnswer}`)
      assert.equal(harness.created[0].meta.cwd, 'C:/work/beta', `llmAnswer=${llmAnswer} 时该退回 lastCwd`)
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
      assert.match(saved.lastDelivery.workspace, /沿用最近一次/)
    } finally {
      await server.close()
      rmSync(stateFile, { force: true })
    }
  }
})

test('端到端：cwd 为 auto 但没有 llm 服务时，安静地退回上一次的目录', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port, { cwd: 'auto' })
  const harness = createCtx({
    workspaces: [
      { path: 'C:/work/alpha', title: 'alpha' },
      { path: 'C:/work/beta', title: 'beta' },
    ],
    withoutLlm: true,
  })
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    poller.rememberCwd('C:/work/alpha')
    server.add(createHeaders('create-nollm@qq.com'), '帮我看看这个\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 1, '挑不出工作区不该让这封邮件失败')
    assert.equal(harness.created[0].meta.cwd, 'C:/work/alpha')
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：cwd 为 auto 且只登记了一个工作区时，直接用那个，不必问模型', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port, { cwd: 'auto' })
  const harness = createCtx({ workspaces: [{ path: 'C:/work/only', title: 'only' }] })
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    server.add(createHeaders('create-only@qq.com'), '随便写点什么\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 1)
    assert.equal(harness.created[0].meta.cwd, 'C:/work/only')
    assert.equal(harness.llmCalls.length, 0)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：自己的通知邮件不会触发', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run() // 建立水位
    server.add(noticeHeaders('notice-1@qq.com'), '这是通知正文\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 0)
    assert.equal(harness.created.length, 0)
    assert.equal(harness.appended.length, 0)
    assert.match(result.decisions[0].reason, /不像回复/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：重复轮询不会对同一封邮件投递第二次', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    server.add(replyHeaders('once@qq.com'), '只该投递一次\r\n')
    await poller.run()
    const second = await poller.run()

    assert.equal(second.triggered, 0)
    assert.equal(harness.created.length + harness.appended.length, 1)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：cwd 用 last 时沿用最近一次会话的目录（只在新建时用得上）', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port, { cwd: 'last' })
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    poller.rememberCwd('C:/projects/another-repo')
    server.add(replyHeaders('cwd@qq.com'), '换个项目干活\r\n')
    await poller.run()

    assert.equal(harness.created[0].meta.cwd, 'C:/projects/another-repo')
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.lastCwd, 'C:/projects/another-repo')
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：手动检查（preview）不投递、不改状态文件，但会说明落到哪个会话', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config })

  try {
    await poller.run()
    poller.rememberNotification('session-known', 'DSH 任务完成')
    const before = readFileSync(stateFile, 'utf8')
    server.add(replyHeaders('peek@qq.com'), '只是看一眼\r\n')

    const result = await poller.run({ preview: true })
    assert.equal(result.decisions[0].accepted, true, '要报告「这封会触发」')
    assert.equal(result.decisions[0].sessionId, 'session-known', '要说明会落到哪个会话')
    assert.equal(harness.created.length + harness.appended.length, 0, 'preview 绝不能投递')
    assert.equal(readFileSync(stateFile, 'utf8'), before, 'preview 绝不能改状态文件')

    // preview 之后真跑一次，仍然会触发——说明它没有被「吃掉」。
    const real = await poller.run()
    assert.equal(real.triggered, 1)
    assert.deepEqual(harness.resolveCalls, ['session-known'])
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：dryRun 开启时判定通过但只记日志', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const dry = { ...config, dryRun: true }
  const harness = createCtx()
  const poller = createReplyPoller({ ctx: harness.ctx, config: dry })

  try {
    await poller.run()
    server.add(replyHeaders('dry@qq.com'), 'dryRun 不该投递\r\n')
    const result = await poller.run()

    assert.equal(result.triggered, 0)
    assert.equal(harness.created.length + harness.appended.length, 0)
    assert.match(result.decisions[0].reason, /dryRun/)
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})

test('端到端：投递失败时只记警告并重试，不推进水位；连续失败到上限才放弃', async () => {
  const server = await startFakeImap({ uidNext: 1 })
  const { config, stateFile } = replyConfig(server.port)
  const harness = createCtx()
  const broken = {
    logger: harness.ctx.logger,
    get: () => undefined,
    on: () => () => {},
    inject: () => {},
    effect: (callback) => callback(),
  }
  const poller = createReplyPoller({ ctx: broken, config })

  try {
    await poller.run()
    const before = JSON.parse(readFileSync(stateFile, 'utf8')).lastUid
    server.add(replyHeaders('retry@qq.com'), '这次会失败\r\n')

    const first = await poller.run()
    assert.equal(first.triggered, 0)
    assert.equal(first.decisions[0].retryable, true)
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).lastUid, before, '失败不推进水位')

    const second = await poller.run()
    assert.equal(second.decisions[0].retryable, true)

    const third = await poller.run()
    assert.match(third.decisions[0].reason, /已放弃/)
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).lastUid, before + 1, '放弃之后才推进水位')
  } finally {
    await server.close()
    rmSync(stateFile, { force: true })
  }
})
