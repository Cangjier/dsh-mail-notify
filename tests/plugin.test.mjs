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

import { apply } from '../index.mjs'

/**
 * 造一个假的 ctx。
 * `inject` 模拟 tools 服务立即可用：回调立刻拿到一个只带 tools 的子上下文，
 * 工具定义收进 `tools` 数组，测试可以直接调 execute。
 */
function createHarness() {
  const registered = []
  const handlers = []
  const logs = []
  const tools = []
  const record = (level) => (...args) => logs.push({ level, text: args.join(' ') })
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    on: (name, handler) => {
      registered.push(name)
      handlers.push(handler)
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
    // 没有 agents 服务：插件会把「查不到 agent」当成「已经停稳」，于是安静窗口一到就发。
    get: () => undefined,
    effect: (callback) => {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
  }
  const effects = []
  return { ctx, registered, handlers, logs, tools, effects }
}

/** 最简的会话替身：插件只读 id 和 header.cwd / header.origin。 */
function sessionOf(origin) {
  return { id: 'session-test', header: { cwd: 'C:/tmp', origin } }
}

const assistantEvent = (turn, step, text) => ({
  type: 'assistant/message',
  data: { turn, step, message: { content: [{ type: 'text', text }] } },
})

const turnStartEvent = (turn) => ({ type: 'turn/start', data: { turn } })

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

test('启用后 —— 只注册 session/event，并在 turn/end 时按最后一步发信', async () => {
  const { ctx, registered, handlers, logs } = createHarness()
  apply(ctx, baseConfig())
  assert.deepEqual(registered, ['session/event'])

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
