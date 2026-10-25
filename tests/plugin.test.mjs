/**
 * 证明三件事，不依赖 dsh、不联网、不发信：
 *
 * 1. 没启用或配置写错时，apply 不抛异常、不注册 session/event 监听器，
 *    因此对 dsh 是纯惰性的——这正是「不会导致 dsh 用不了」的那一条保证。
 * 2. 同一情况下 `mail_notify` 引导工具**仍然注册**，因为配置出错时它正是
 *    把错因和改法讲清楚的唯一入口。
 * 3. 启用后，正文取最后一条助手消息、mergeSteps 拼接整轮、结束原因进主题后缀、
 *    子代理会话被跳过。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, composeQuestionNotification, normalizeConfig } from '../index.mjs'

/**
 * 造一个假的 ctx。
 * `inject` 模拟 tools 服务立即可用：回调立刻拿到一个只带 tools 的子上下文，
 * 工具定义收进 `tools` 数组，测试可以直接调 execute。
 * `agents` 传进来时 `ctx.get('agents')` 会返回它——那是「跳过自动化来源」判定里
 * `turn/start` 那一刻要看收件箱用的；不传就当作宿主没有这个服务。
 */
function createHarness({ agents } = {}) {
  const registered = []
  const handlers = []
  const options = []
  const logs = []
  const tools = []
  const record = (level) => (...args) => logs.push({ level, text: args.join(' ') })
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    on: (name, handler, listenerOptions) => {
      registered.push(name)
      handlers.push(handler)
      options.push(listenerOptions)
      return () => {}
    },
    inject: (_deps, callback) => {
      callback({
        tools: {
          register: (definition) => {
            tools.push(definition)
            return () => {}
          },
        },
      })
      return Promise.resolve()
    },
    // 默认没有 agents 服务：插件会把「查不到 agent」当成「已经停稳」，于是安静窗口一到就发。
    get: (name) => (name === 'agents' ? agents : undefined),
    effect: (callback) => {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
  }
  const effects = []
  return { ctx, registered, handlers, options, logs, tools, effects }
}

/** 按事件名取监听器；没注册时返回 undefined。 */
const listenerOf = (harness, name) => harness.handlers[harness.registered.indexOf(name)]

/**
 * 假 agents 服务：只实现 peek 需要的 `get(id)` → `{ status, inbox }`。
 * `inbox` 传的是同一个对象引用，测试可以中途往里塞消息，模拟「下一轮领取什么」。
 */
function agentsWithInbox(inbox = { nextStep: [], nextTurn: [] }) {
  return { get: () => ({ status: 'idle', inbox }) }
}

/** 最简的会话替身：插件只读 id 和 header.cwd / header.origin。 */
function sessionOf(origin) {
  return { id: 'session-test', header: { cwd: 'C:/tmp', origin } }
}

/**
 * 假 agents 服务：`list()` 给实时注册表（子代理判定用），`get(id)` 查单个 agent。
 * @param {object[]} agents - agent 替身列表。
 */
function agentsWithRegistry(agents) {
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  return { get: id => byId.get(id), list: () => agents }
}

/**
 * 造一个 agent 替身：会话头带上子代理判定要读的 `origin` / `parentSession`。
 * @param {{ id: string, status?: string, origin?: string, parentSession?: string }} input - 替身字段。
 */
function agentOf({ id, status = 'idle', origin, parentSession }) {
  return {
    id,
    status,
    session: {
      id,
      header: {
        cwd: 'C:/tmp',
        ...(origin === undefined ? {} : { origin }),
        ...(parentSession === undefined ? {} : { parentSession }),
      },
    },
  }
}

const assistantEvent = (turn, step, text) => ({
  type: 'assistant/message',
  data: { turn, step, message: { content: [{ type: 'text', text }] } },
})

const turnStartEvent = (turn) => ({ type: 'turn/start', data: { turn } })

/** 一条落进会话日志的用户输入；`kind` 就是宿主给的来源身份。 */
const userMessageEvent = (kind, id = 'm-1') => ({
  type: 'user/message',
  data: { id, role: 'user', content: [{ type: 'text', text: '输入' }], source: { kind } },
})

const turnEndEvent = (turn, kind = 'completed') => ({
  type: 'turn/end',
  data: { turn, reason: { kind } },
})

/** 让 apply 里那条 promise 队列跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 等一段真实时间（安静窗口是非零时必须真等）。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 安静窗口是 0 秒，所以两个 tick 足够让「全部结束」那一封落进日志。 */
const settle = async () => {
  await flush()
  await flush()
}

/**
 * 取「每轮真正投递」的那条日志。
 * 用 body= 区分：apply 时还会写一条 dryRun 日志，那条不含 body=。
 */
const delivered = (logs) => logs.find((entry) => entry.text.includes('body='))

/** 取所有投递记录的 dryRun 日志（多轮任务会不止一条）。 */
const deliveredAll = (logs) => logs.filter((entry) => entry.text.includes('body='))

/** 从 dryRun 日志里取出真正会用的主题。 */
const subjectOf = (logs) => delivered(logs).text.match(/subject=(.*?) to=/)[1]

/** 取投递记录的 kind（progress / final）。 */
const kindOf = (entry) => entry.text.match(/kind=(\w+)/)[1]

/** 取 dryRun 正文日志的内容。 */
const bodyOf = (logs, index = 0) =>
  logs.filter((entry) => entry.text.includes('dryRun 正文')).at(index)?.text.split('\n').slice(1).join('\n') ?? ''

/** 干燥运行的基础配置：dryRun 保证测试永远不碰网络。 */
const baseConfig = (extra = {}) => ({
  smtp: { user: 'someone@qq.com' },
  to: ['someone@qq.com'],
  dryRun: true,
  finalQuietSeconds: 0,
  // 把授权码环境变量钉成一个本机几乎不可能存在的名字：即使开发机刚好设了
  // QQ_SMTP_AUTH_CODE，读不到授权码的用例也不会误连真实 SMTP。
  authCodeEnv: 'MAIL_NOTIFY_TEST_UNSET_ENV',
  ...extra,
})

test('enabled: false —— 不注册监听器，但仍然注册引导工具', () => {
  const { ctx, registered, tools, logs } = createHarness()
  assert.doesNotThrow(() => apply(ctx, baseConfig({ enabled: false })))
  assert.deepEqual(registered, [], '没有注册任何事件监听器')
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['mail_notify'],
    '引导工具必须在：它是用户知道该怎么配的唯一入口',
  )
  assert.equal(logs.every((entry) => entry.level === 'info'), true)
  assert.equal(
    logs.some((entry) => entry.text.includes('未启用')),
    true,
  )
})

test('缺少 to —— apply 不抛异常，不注册监听器，但引导工具仍在', () => {
  const { ctx, registered, tools, logs } = createHarness()
  const config = baseConfig()
  delete config.to
  assert.doesNotThrow(() => apply(ctx, config))
  assert.deepEqual(registered, [])
  assert.deepEqual(tools.map((tool) => tool.name), ['mail_notify'])
  assert.equal(
    logs.some((entry) => entry.level === 'error'),
    true,
  )
})

test('收件人非法 —— apply 不抛异常，不注册监听器', () => {
  const { ctx, registered, tools } = createHarness()
  assert.doesNotThrow(() => apply(ctx, baseConfig({ to: ['not-an-address'] })))
  assert.deepEqual(registered, [])
  assert.deepEqual(tools.map((tool) => tool.name), ['mail_notify'])
})

test('发件域名认不出且没给 host —— apply 不抛异常，不注册监听器', () => {
  const { ctx, registered, tools } = createHarness()
  assert.doesNotThrow(() => apply(ctx, { smtp: { user: 'someone@unknown-domain.test' }, to: ['a@b.com'] }))
  assert.deepEqual(registered, [])
  assert.deepEqual(tools.map((tool) => tool.name), ['mail_notify'])
})

test('config 整个是 undefined —— apply 不抛异常，不注册监听器', () => {
  const { ctx, registered, tools } = createHarness()
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.deepEqual(registered, [])
  assert.deepEqual(tools.map((tool) => tool.name), ['mail_notify'])
})

test('引导工具：配置无效时 status 讲清错因，guide 给出可粘贴片段', async () => {
  const { ctx, tools } = createHarness()
  apply(ctx, baseConfig({ to: ['not-an-address'] }))
  const [tool] = tools

  const status = await tool.execute({ action: 'status' })
  assert.match(status.text, /配置无效/)
  assert.match(status.text, /not-an-address/)

  const guide = await tool.execute({ action: 'guide' })
  assert.match(guide.text, /- id: mail-notify/)
  assert.match(guide.text, /enabled: true/)
  assert.match(guide.text, /cordis\.patch\.yml/)
  assert.match(guide.text, /secret\.txt/)
})

test('引导工具：未启用时 status 明确说不会发信', async () => {
  const { ctx, tools } = createHarness()
  apply(ctx, baseConfig({ enabled: false }))
  const status = await tools[0].execute({ action: 'status' })
  assert.match(status.text, /未启用/)
  assert.match(status.text, /不会发信/)
  assert.match(status.text, /smtp\.qq\.com:465/)
  assert.match(status.text, /标题摘要：开启，最多 40 字/)
})

test('引导工具：读不到授权码时 test 不抛异常，而是返回引导', async () => {
  const { ctx, tools } = createHarness()
  // 指向一个不存在的授权码文件，确保读不到。
  apply(ctx, baseConfig({ authCodeFile: 'C:/definitely/not/here/secret.txt' }))
  const result = await tools[0].execute({ action: 'test' })
  assert.match(result.text, /读不到 SMTP 授权码/)
  assert.match(result.text, /配置引导/)
})

test('引导工具：连不上服务器时 test 返回失败原因与引导，不抛异常', async () => {
  const { ctx, tools } = createHarness()
  // 本地 1 端口必然拒连，测试不会碰真实网络。
  apply(
    ctx,
    baseConfig({
      smtp: { user: 'someone@qq.com', host: '127.0.0.1', port: 1, secure: false },
      authCode: 'dummy-auth-code',
    }),
  )
  const result = await tools[0].execute({ action: 'test' })
  assert.match(result.text, /测试发送失败/)
  assert.match(result.text, /配置引导/)
})

test('引导工具：未知 action 给出可用取值', async () => {
  const { ctx, tools } = createHarness()
  apply(ctx, baseConfig())
  const result = await tools[0].execute({ action: 'nope' })
  assert.match(result.text, /未知 action/)
})

test('启用后 —— 注册 session/event 与提问瀑布，并在 turn/end 时按最后一步发信', async () => {
  const { ctx, registered, handlers, logs } = createHarness()
  apply(ctx, baseConfig())
  assert.deepEqual(registered, ['session/event', 'user-questions/request'])

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, 'A'.repeat(10)))
  handlers[0](session, assistantEvent(1, 2, 'B'.repeat(20)))
  handlers[0](session, turnEndEvent(1))
  await settle()

  const sent = delivered(logs)
  assert.ok(sent, '应记录一条 dryRun 日志')
  assert.equal(kindOf(sent), 'final', '单轮任务只该收到「全部结束」那一封')
  assert.ok(subjectOf(logs).startsWith('DSH 任务完成'), '单轮任务直接用「完成」前缀')
  assert.ok(bodyOf(logs).includes('B'.repeat(20)), '正文要带上这一轮的回答')
  assert.ok(bodyOf(logs).includes('本次任务已全部结束'), '「全部结束」那一封要说清这是收尾')
})

test('多轮任务：中途那些轮发「进行中」，最后一轮发「完成」', async () => {
  const { ctx, handlers, logs } = createHarness()
  // 安静窗口 1 秒：够测出「一轮结束不立刻发、等下一轮开始才发」这条时序。
  apply(ctx, baseConfig({ finalQuietSeconds: 1 }))

  const session = sessionOf()
  // 第一轮
  handlers[0](session, turnStartEvent(1))
  handlers[0](session, assistantEvent(1, 1, '第一轮的回答'))
  handlers[0](session, turnEndEvent(1))
  await flush()
  assert.equal(delivered(logs), undefined, '一轮结束先不发，要等看会不会继续')

  // 第二轮开始 —— 说明第一轮只是中途
  handlers[0](session, turnStartEvent(2))
  await settle()
  const progress = deliveredAll(logs)
  assert.equal(progress.length, 1)
  assert.equal(kindOf(progress[0]), 'progress')
  assert.match(subjectOf(logs), /^DSH 任务进行中/)
  assert.ok(bodyOf(logs).includes('第一轮的回答'))

  // 第二轮结束，并且不再继续
  handlers[0](session, assistantEvent(2, 1, '第二轮的收尾回答'))
  handlers[0](session, turnEndEvent(2))
  await sleep(1200)

  const all = deliveredAll(logs)
  assert.equal(all.length, 2, '第一轮一封「进行中」+ 第二轮一封「完成」')
  assert.equal(kindOf(all[1]), 'final')
  assert.match(all[1].text.match(/subject=(.*?) to=/)[1], /^DSH 任务完成/)
  assert.ok(bodyOf(logs, 1).includes('第二轮的收尾回答'))
  assert.ok(bodyOf(logs, 1).includes('（2 轮）'), '收尾那封要说清一共跑了几轮')
})

test('notifyProgress: false —— 中途不发，只在整段结束时发一封', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig({ finalQuietSeconds: 1, notifyProgress: false }))

  const session = sessionOf()
  handlers[0](session, turnStartEvent(1))
  handlers[0](session, assistantEvent(1, 1, '第一轮的回答'))
  handlers[0](session, turnEndEvent(1))
  handlers[0](session, turnStartEvent(2))
  await settle()
  assert.equal(delivered(logs), undefined, '中途不该发')

  handlers[0](session, assistantEvent(2, 1, '第二轮的回答'))
  handlers[0](session, turnEndEvent(2))
  await sleep(1200)

  const all = deliveredAll(logs)
  assert.equal(all.length, 1)
  assert.equal(kindOf(all[0]), 'final')
  assert.ok(bodyOf(logs).includes('第二轮的回答'))
  assert.equal(bodyOf(logs).includes('第一轮的回答'), false, '低噪音模式只带最后一轮的回答')
})

test('mergeSteps: true —— 正文拼接整轮所有步骤', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig({ mergeSteps: true }))

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, 'A'.repeat(10)))
  handlers[0](session, assistantEvent(1, 2, 'B'.repeat(20)))
  handlers[0](session, turnEndEvent(1))
  await settle()

  const body = bodyOf(logs)
  assert.ok(body.includes('A'.repeat(10)), '拼接后应含第一步')
  assert.ok(body.includes('B'.repeat(20)), '拼接后应含第二步')
  assert.ok(body.includes(`${'A'.repeat(10)}\n\n${'B'.repeat(20)}`), '两步之间用空行分隔')
})

test('结束原因进主题后缀，不假装是正常完成', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(7, 1, 'boom'))
  handlers[0](session, turnEndEvent(7, 'error'))
  await settle()

  assert.match(delivered(logs).text, /（出错）/)
})

test('子代理会话被跳过', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf('subagent')
  handlers[0](session, assistantEvent(1, 1, 'subagent text'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(delivered(logs), undefined, '子代理不该发信')
})

test('父会话结束时还有子代理在跑：标题改报「进行中」并注明子代理数，绝不报「完成」', async () => {
  const agents = agentsWithRegistry([
    agentOf({ id: 'session-test', status: 'idle' }),
    agentOf({ id: 'sub-1', status: 'running', origin: 'subagent', parentSession: 'session-test' }),
    agentOf({ id: 'sub-2', status: 'running', origin: 'subagent', parentSession: 'session-test' }),
  ])
  const { ctx, handlers, logs } = createHarness({ agents })
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '成员都派出去了，等它们回来收口。'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  const sent = delivered(logs)
  assert.ok(sent)
  assert.equal(kindOf(sent), 'progress', '任务没有收口，不能发「全部结束」邮件')
  assert.equal(subjectOf(logs), 'DSH 任务进行中（2 个子代理仍在跑）｜成员都派出去了，等它们回来收口。')
  assert.ok(bodyOf(logs).includes('还有 2 个子代理会话在跑'))
  assert.equal(bodyOf(logs).includes('本次任务已全部结束'), false, '正文不能说任务已结束')
})

test('子代理已经停稳：照常报「完成」', async () => {
  const agents = agentsWithRegistry([
    agentOf({ id: 'session-test', status: 'idle' }),
    agentOf({ id: 'sub-1', status: 'idle', origin: 'subagent', parentSession: 'session-test' }),
  ])
  const { ctx, handlers, logs } = createHarness({ agents })
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '收口完成。'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(kindOf(delivered(logs)), 'final')
  assert.ok(subjectOf(logs).startsWith('DSH 任务完成'))
  assert.ok(bodyOf(logs).includes('本次任务已全部结束'))
})

test('子代理的子代理还在跑（多层血缘）：父会话照样不报「完成」', async () => {
  const agents = agentsWithRegistry([
    agentOf({ id: 'session-test', status: 'idle' }),
    agentOf({ id: 'sub-1', status: 'idle', origin: 'subagent', parentSession: 'session-test' }),
    agentOf({ id: 'sub-2', status: 'running', origin: 'subagent', parentSession: 'sub-1' }),
  ])
  const { ctx, handlers, logs } = createHarness({ agents })
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '还有一层在跑。'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(kindOf(delivered(logs)), 'progress')
  assert.match(subjectOf(logs), /1 个子代理仍在跑/)
})

test('别的会话名下的子代理在跑：不影响本会话的完成判定', async () => {
  const agents = agentsWithRegistry([
    agentOf({ id: 'session-test', status: 'idle' }),
    agentOf({ id: 'other-child', status: 'running', origin: 'subagent', parentSession: 'session-other' }),
  ])
  const { ctx, handlers, logs } = createHarness({ agents })
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '这条会话自己收口了。'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(kindOf(delivered(logs)), 'final')
  assert.ok(subjectOf(logs).startsWith('DSH 任务完成'))
})

test('没有助手文本时用结束原因兜底，仍然发信', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, 'something'))
  handlers[0](session, turnEndEvent(1, 'aborted'))
  await settle()

  assert.match(delivered(logs).text, /（已取消）/)
})

test('标题摘要：优先取回答里的第一个 Markdown 标题', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '先说一句铺垫。\n\n## 邮件标题已带摘要\n\n细节若干。'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(subjectOf(logs), 'DSH 任务完成｜邮件标题已带摘要')
})

test('标题摘要：没有标题时取首行，跳过代码块与表格分隔线', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](
    session,
    assistantEvent(1, 1, '```js\nconst a = 1\n```\n\n| 列 | 值 |\n| --- | --- |\n| 路径 | C:/tmp |\n'),
  )
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(subjectOf(logs), 'DSH 任务完成｜列 值 路径 C:/tmp')
})

test('标题摘要：首行太短时往后接一行，让标题能自解释', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '好的\n已把邮件标题改成带摘要的形式。'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(subjectOf(logs), 'DSH 任务完成｜好的 已把邮件标题改成带摘要的形式。')
})

test('标题摘要：超过 subjectSummaryChars 时截断并加省略号', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig({ subjectSummaryChars: 10 }))

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '这是一句很长的回答文本用于验证截断行为'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(subjectOf(logs), 'DSH 任务完成｜这是一句很长的回答文…')
})

test('subjectSummary: false —— 标题回到纯前缀加结束原因', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig({ subjectSummary: false }))

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '## 这个标题不该进标题'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(subjectOf(logs), 'DSH 任务完成')
})

test('结束原因排在摘要之前：出错时标题仍一眼看出结果', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(7, 1, '## 沙箱拒绝了这次写入'))
  handlers[0](session, turnEndEvent(7, 'error'))
  await settle()

  assert.equal(subjectOf(logs), 'DSH 任务完成（出错）｜沙箱拒绝了这次写入')
})

test('标题摘要：回答里只有代码块时不加分隔符', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, '```\nconst a = 1\n```'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(subjectOf(logs), 'DSH 任务完成')
  assert.ok(!delivered(logs).text.includes('｜'))
})

test('跳过来源：定时任务那一轮整轮不发信（turn/start 时就从收件箱认出来了）', async () => {
  const inbox = { nextStep: [], nextTurn: [{ id: 'm-sched', source: { kind: 'schedule' } }] }
  const { ctx, handlers, logs } = createHarness({ agents: agentsWithInbox(inbox) })
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, turnStartEvent(1))
  handlers[0](session, userMessageEvent('schedule', 'm-sched'))
  handlers[0](session, assistantEvent(1, 1, '定时提醒的回答'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(delivered(logs), undefined, '定时提醒不该产生任何邮件')
})

test('跳过来源：读不到收件箱时，按会话日志里的 user/message 来源照样跳', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, turnStartEvent(1))
  assert.equal(delivered(logs), undefined)
  handlers[0](session, userMessageEvent('schedule', 'm-1'))
  handlers[0](session, assistantEvent(1, 1, '定时提醒的回答'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(delivered(logs), undefined, '收件箱读不到也不该漏掉这条来源')
})

test('跳过来源：默认只跳定时任务，本插件自己投递的邮件照发（那条通知就是回信）', async () => {
  const inbox = { nextStep: [], nextTurn: [{ id: 'm-mail', source: { kind: 'cordis-host-runner' } }] }
  const { ctx, handlers, logs } = createHarness({ agents: agentsWithInbox(inbox) })
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, turnStartEvent(1))
  handlers[0](session, userMessageEvent('cordis-host-runner', 'm-mail'))
  handlers[0](session, assistantEvent(1, 1, '邮件那一轮的回答'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  const sent = delivered(logs)
  assert.ok(sent, '默认不该跳本插件自己的邮件')
  assert.equal(kindOf(sent), 'final')
  assert.ok(bodyOf(logs).includes('邮件那一轮的回答'))
})

test('跳过来源：skipSources: [] 关掉过滤后，定时任务那一轮照样发信', async () => {
  const inbox = { nextStep: [], nextTurn: [{ id: 'm-sched', source: { kind: 'schedule' } }] }
  const { ctx, handlers, logs } = createHarness({ agents: agentsWithInbox(inbox) })
  apply(ctx, baseConfig({ skipSources: [] }))

  const session = sessionOf()
  handlers[0](session, turnStartEvent(1))
  handlers[0](session, userMessageEvent('schedule', 'm-sched'))
  handlers[0](session, assistantEvent(1, 1, '定时提醒的回答'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(kindOf(delivered(logs)), 'final')
  assert.ok(bodyOf(logs).includes('定时提醒的回答'))
})

test('跳过来源：把 cordis-host-runner 加进列表就整轮不发信（回信代价由用户自己承担）', async () => {
  const inbox = { nextStep: [], nextTurn: [{ id: 'm-mail', source: { kind: 'cordis-host-runner' } }] }
  const { ctx, handlers, logs } = createHarness({ agents: agentsWithInbox(inbox) })
  apply(ctx, baseConfig({ skipSources: ['schedule', 'cordis-host-runner'] }))

  const session = sessionOf()
  handlers[0](session, turnStartEvent(1))
  handlers[0](session, userMessageEvent('cordis-host-runner', 'm-mail'))
  handlers[0](session, assistantEvent(1, 1, '邮件那一轮的回答'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(delivered(logs), undefined)
})

test('跳过来源：被跳过的轮次不算「中途」，上一轮照样只发一封「完成」', async () => {
  const inbox = { nextStep: [], nextTurn: [] }
  const { ctx, handlers, logs } = createHarness({ agents: agentsWithInbox(inbox) })
  apply(ctx, baseConfig({ finalQuietSeconds: 1 }))

  const session = sessionOf()

  // 第一轮：人从界面发起，正常记录，进入安静窗口。
  handlers[0](session, turnStartEvent(1))
  handlers[0](session, userMessageEvent('user', 'm-human'))
  handlers[0](session, assistantEvent(1, 1, '人类那轮的回答'))
  handlers[0](session, turnEndEvent(1))
  await flush()
  assert.equal(delivered(logs), undefined, '安静窗口没到，先不发')

  // 第二轮：定时提醒。它不能让上一轮被降级成「进行中」。
  inbox.nextTurn.push({ id: 'm-sched', source: { kind: 'schedule' } })
  handlers[0](session, turnStartEvent(2))
  await settle()
  assert.equal(delivered(logs), undefined, '跳过的轮次不是「中途」，不该触发「进行中」')

  handlers[0](session, userMessageEvent('schedule', 'm-sched'))
  handlers[0](session, assistantEvent(2, 1, '定时提醒的回答'))
  handlers[0](session, turnEndEvent(2))
  await sleep(1200)

  const all = deliveredAll(logs)
  assert.equal(all.length, 1, '只有人类那一轮的一封')
  assert.equal(kindOf(all[0]), 'final')
  assert.ok(bodyOf(logs).includes('人类那轮的回答'))
  assert.equal(bodyOf(logs).includes('定时提醒的回答'), false, '定时提醒的正文不该出现在任何邮件里')
})

test('跳过来源：注入的上下文不算发起来源（先落进日志的 agent-instructions 不该误判）', async () => {
  const inbox = { nextStep: [], nextTurn: [{ id: 'm-human', source: { kind: 'user' } }] }
  const { ctx, handlers, logs } = createHarness({ agents: agentsWithInbox(inbox) })
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, turnStartEvent(1))
  // 一轮里先落进日志的可能是注入的上下文，发起方那条排在后面。
  handlers[0](session, userMessageEvent('agent-instructions', 'm-ctx'))
  handlers[0](session, userMessageEvent('user', 'm-human'))
  handlers[0](session, assistantEvent(1, 1, '人类的回答'))
  handlers[0](session, turnEndEvent(1))
  await settle()

  assert.equal(kindOf(delivered(logs)), 'final', '人类发起的轮次必须照发')
})

test('引导工具：status 说明跳过哪些来源，并写明跳过本插件邮件的代价', async () => {
  const { ctx, tools } = createHarness()
  apply(ctx, baseConfig())
  const status = await tools[0].execute({ action: 'status' })
  assert.match(status.text, /跳过来源：schedule/)
  assert.equal(/注意：cordis-host-runner/.test(status.text), false, '默认没跳它就不该有这条提醒')

  const warned = createHarness()
  apply(warned.ctx, baseConfig({ skipSources: ['schedule', 'cordis-host-runner'] }))
  const text = (await warned.tools[0].execute({ action: 'status' })).text
  assert.match(text, /跳过来源：schedule、cordis-host-runner/)
  assert.match(text, /回复邮件触发的那一轮不再回信/)
})

test('引导工具：status 报告提问通知的开关与标题前缀', async () => {
  const { ctx, tools } = createHarness()
  apply(ctx, baseConfig())
  const status = await tools[0].execute({ action: 'status' })
  assert.match(status.text, /提问通知：开启.*DSH 等待你的回答/)

  const off = createHarness()
  apply(off.ctx, baseConfig({ notifyQuestions: false }))
  const text = (await off.tools[0].execute({ action: 'status' })).text
  assert.match(text, /提问通知：关闭/)
})

test('引导工具：总开关 enabled 为 false 时，status 不说「提问通知：开启」', async () => {
  const { ctx, tools } = createHarness()
  apply(ctx, baseConfig({ enabled: false }))
  const text = (await tools[0].execute({ action: 'status' })).text
  assert.match(text, /提问通知：配置为开启，但总开关 enabled 为 false/)
  assert.equal(/提问通知：开启，agent 提问/.test(text), false, '不能与实际「不注册监听器」自相矛盾')
})

/** 一次 ask_user_question 的问答请求替身：插件只读 `questions` 与 `agent.session`。 */
const questionRequest = (questions, session = sessionOf()) => ({ questions, agent: { session } })

/** 取「提问通知」的监听器。 */
const questionListener = (harness) => listenerOf(harness, 'user-questions/request')

test('提问：一到就发一封「等待你的回答」，正文列问题与选项，next() 照常调用', async () => {
  const harness = createHarness()
  const { ctx, registered, options, logs } = harness
  apply(ctx, baseConfig())

  const handler = questionListener(harness)
  assert.equal(typeof handler, 'function', '启用后必须注册提问监听器')
  assert.deepEqual(
    options[registered.indexOf('user-questions/request')],
    { prepend: true },
    '必须在宿主的转发器之前被调用，否则真机上永远轮不到',
  )

  let nextCalls = 0
  const returned = handler(
    questionRequest([
      {
        id: 'q1',
        header: '确认',
        question: '是否删除旧文件？',
        options: [
          { label: '删除（推荐）', description: '永久删除，不能恢复' },
          { label: '保留' },
        ],
      },
    ]),
    () => {
      nextCalls += 1
      return 'answer-from-ui'
    },
  )
  assert.equal(nextCalls, 1, '通知不能挡住宿主的瀑布链')
  assert.equal(returned, 'answer-from-ui', 'next() 的返回值要原样交还')
  await settle()

  const sent = delivered(logs)
  assert.ok(sent, '应记录一条提问通知的 dryRun 日志')
  assert.equal(kindOf(sent), 'question')
  assert.match(subjectOf(logs), /^DSH 等待你的回答｜是否删除旧文件？/)
  const body = bodyOf(logs)
  assert.ok(body.includes('【确认】是否删除旧文件？'))
  assert.ok(body.includes('删除（推荐）：永久删除，不能恢复'))
  assert.ok(body.includes('请回到 DSH 界面里回答'))
})

test('提问：多个问题逐个列出，计划审阅的 detail 与多选标记也带上', async () => {
  const harness = createHarness()
  apply(harness.ctx, baseConfig({ subjectSummary: false }))
  const handler = questionListener(harness)

  handler(
    {
      questions: [
        { id: 'a', question: '先做哪个？', options: [{ label: '邮件' }, { label: '测试' }] },
        {
          id: 'b',
          question: '这个计划可以吗？',
          detail: '第一步：改配置\n第二步：跑测试',
          multiSelect: true,
          intent: { kind: 'plan-review', approve: '同意' },
        },
      ],
    },
    () => {},
  )
  await settle()

  assert.equal(subjectOf(harness.logs), 'DSH 等待你的回答', 'subjectSummary: false 时标题只有前缀')
  const body = bodyOf(harness.logs)
  assert.ok(body.includes('2 个问题'))
  assert.ok(body.includes('1. 先做哪个？'))
  assert.ok(body.includes('2. 这个计划可以吗？'))
  assert.ok(body.includes('（待审阅的计划）'), '计划审阅的 detail 要标出来')
  assert.ok(body.includes('   第一步：改配置'))
  assert.ok(body.includes('（可以多选）'))
  assert.equal(body.includes('会话:'), false, 'includeSessionInfo 默认关闭')
})

test('提问：标题摘要跳过「只有 Markdown 标记」的题面，用下一个能读的问题', () => {
  const config = normalizeConfig({ smtp: { user: 'someone@qq.com' }, to: ['someone@qq.com'] })
  const { subject } = composeQuestionNotification(config, {
    questions: [
      { id: 'a', question: '###' },
      { id: 'b', question: '**真正的**问题是什么？' },
    ],
  })
  assert.equal(subject, 'DSH 等待你的回答｜真正的问题是什么？')
})

test('提问：没有会话（agentless 编程式提问）时不带 token、不承诺回信排队', async () => {
  const harness = createHarness()
  apply(harness.ctx, baseConfig())
  const handler = questionListener(harness)

  let nextCalls = 0
  handler(
    { questions: [{ id: 'q1', question: '程序化调用也要问用户吗？' }] },
    () => {
      nextCalls += 1
    },
  )
  assert.equal(nextCalls, 1)
  await settle()

  const body = bodyOf(harness.logs)
  assert.ok(body.includes('程序化调用也要问用户吗？'))
  assert.equal(body.includes('[DSH-'), false, '没有会话就不该附 token')
  assert.equal(body.includes('直接回复本邮件'), false, '没有会话就不该承诺回复能排队')
  assert.equal(body.includes('回信会作为这条会话'), false)
})

test('提问：notifyQuestions: false —— 不注册监听器，提问时也不发信', () => {
  const harness = createHarness()
  apply(harness.ctx, baseConfig({ notifyQuestions: false }))
  assert.deepEqual(harness.registered, ['session/event'])
  assert.equal(questionListener(harness), undefined)
})

test('提问：已被取消的请求不发提醒，next() 照常调用', async () => {
  const harness = createHarness()
  apply(harness.ctx, baseConfig())
  const handler = questionListener(harness)

  let nextCalls = 0
  handler(
    { ...questionRequest([{ id: 'q1', question: '还在吗？' }]), signal: { aborted: true } },
    () => {
      nextCalls += 1
    },
  )
  assert.equal(nextCalls, 1)
  await settle()
  assert.equal(delivered(harness.logs), undefined, '取消掉的提问不该发信')
})

test('提问：next() 抛错不吞掉（下游错误照常冒泡）', () => {
  const harness = createHarness()
  apply(harness.ctx, baseConfig())
  const handler = questionListener(harness)
  assert.throws(() => handler(questionRequest([{ id: 'q1', question: '继续吗？' }]), () => {
    throw new Error('downstream boom')
  }), /downstream boom/)
})

test('提问：没有 next（宿主换了分发方式）时也不把提问弄崩', async () => {
  const harness = createHarness()
  apply(harness.ctx, baseConfig())
  const handler = questionListener(harness)
  assert.doesNotThrow(() => handler(questionRequest([{ id: 'q1', question: '继续吗？' }])))
  await settle()
  assert.ok(delivered(harness.logs), '通知照发')
})

test('提问：发信失败只记 error，next() 仍同步返回、提问不受影响', async () => {
  const harness = createHarness()
  // dryRun 关掉、授权码又读不到：这一封必然发不出去。
  apply(harness.ctx, { ...baseConfig(), dryRun: false, authCodeFile: 'C:/definitely/not/here/secret.txt' })
  const handler = questionListener(harness)

  let nextCalls = 0
  const returned = handler(questionRequest([{ id: 'q1', question: '继续吗？' }]), () => {
    nextCalls += 1
    return 42
  })
  assert.equal(nextCalls, 1)
  assert.equal(returned, 42, 'next() 必须同步返回，不能被发信拖住')
  await settle()
  assert.equal(
    harness.logs.some((entry) => entry.level === 'error' && entry.text.includes('发送「提问通知」失败')),
    true,
    '失败要留下可查的日志',
  )
})

test('提问正文：带 token 时用提问专属页脚，明确「回信只是排队、不等于提交答案」', () => {
  const config = normalizeConfig({ smtp: { user: 'someone@qq.com' }, to: ['someone@qq.com'] })
  const { subject, body } = composeQuestionNotification(config, {
    questions: [{ id: 'q1', question: '继续吗？' }],
    session: sessionOf(),
    token: 'DSH-4F2C9A',
  })
  assert.equal(subject, 'DSH 等待你的回答｜继续吗？')
  assert.ok(body.includes('[DSH-4F2C9A]'))
  assert.ok(body.includes('回信会作为这条会话的后续消息排队'))
  assert.ok(body.includes('直接回复本邮件不会提交答案'))
  assert.equal(
    body.includes('回复本邮件可以继续这条对话'),
    false,
    '不能复用轮次通知那句「可以继续对话」，否则会诱导用户以为回信能提交答案',
  )
})

test('提问正文：超长时截断，但「回界面回答」的提醒不会被截掉', () => {
  const config = normalizeConfig({
    smtp: { user: 'someone@qq.com' },
    to: ['someone@qq.com'],
    maxBodyChars: 40,
  })
  const { body } = composeQuestionNotification(config, {
    questions: [{ id: 'q1', question: '很长的问题'.repeat(50) }],
  })
  assert.ok(body.includes('已截断到前 40 字'))
  assert.ok(body.includes('请回到 DSH 界面里回答'))
})

