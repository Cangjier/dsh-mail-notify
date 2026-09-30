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
  }
  return { ctx, registered, handlers, logs, tools }
}

/** 最简的会话替身：插件只读 id 和 header.cwd / header.origin。 */
function sessionOf(origin) {
  return { id: 'session-test', header: { cwd: 'C:/tmp', origin } }
}

const assistantEvent = (turn, step, text) => ({
  type: 'assistant/message',
  data: { turn, step, message: { content: [{ type: 'text', text }] } },
})

const turnEndEvent = (turn, kind = 'completed') => ({
  type: 'turn/end',
  data: { turn, reason: { kind } },
})

/** 让 apply 里那条 promise 队列跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 取「每轮真正投递」的那条日志。
 * 用 body= 区分：apply 时还会写一条 dryRun 日志，那条不含 body=。
 */
const delivered = (logs) => logs.find((entry) => entry.text.includes('body='))

/** 干燥运行的基础配置：dryRun 保证测试永远不碰网络。 */
const baseConfig = (extra = {}) => ({
  smtp: { user: 'someone@qq.com' },
  to: ['someone@qq.com'],
  dryRun: true,
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
  await flush()

  const sent = delivered(logs)
  assert.ok(sent, '应记录一条 dryRun 日志')
  assert.ok(sent.text.includes('body=20 字'), `默认只取最后一步，实际: ${sent.text}`)
  assert.ok(sent.text.includes('DSH 任务完成'), '正常完成时主题不加后缀')
})

test('mergeSteps: true —— 正文拼接整轮所有步骤', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig({ mergeSteps: true }))

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, 'A'.repeat(10)))
  handlers[0](session, assistantEvent(1, 2, 'B'.repeat(20)))
  handlers[0](session, turnEndEvent(1))
  await flush()

  assert.ok(delivered(logs).text.includes('body=32 字'), `10 + 2(空行) + 20 = 32，实际: ${delivered(logs).text}`)
})

test('结束原因进主题后缀，不假装是正常完成', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(7, 1, 'boom'))
  handlers[0](session, turnEndEvent(7, 'error'))
  await flush()

  assert.match(delivered(logs).text, /（出错）/)
})

test('子代理会话被跳过', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf('subagent')
  handlers[0](session, assistantEvent(1, 1, 'subagent text'))
  handlers[0](session, turnEndEvent(1))
  await flush()

  assert.equal(delivered(logs), undefined, '子代理不该发信')
})

test('没有助手文本时用结束原因兜底，仍然发信', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(1, 1, 'something'))
  handlers[0](session, turnEndEvent(1, 'aborted'))
  await flush()

  assert.match(delivered(logs).text, /（已取消）/)
})
