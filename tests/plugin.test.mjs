/**
 * 证明两件事，不依赖 dsh、不联网、不发信：
 *
 * 1. 没启用（enabled: false）或配置写错时，apply 不抛异常、不注册任何监听器，
 *    因此对 dsh 是纯惰性的——这正是「不会导致 dsh 用不了」的那一条保证。
 * 2. 启用之后，正文取最后一条助手消息、mergeSteps 拼接整轮、结束原因进主题后缀、
 *    子代理会话被跳过。
 *
 *   node --test tests/
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.mjs'

/** 造一个假的 ctx：记录注册了哪些事件、写了哪些日志。 */
function createHarness() {
  const registered = []
  const handlers = []
  const logs = []
  const record = (level) => (...args) => logs.push({ level, text: args.join(' ') })
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    on: (name, handler) => {
      registered.push(name)
      handlers.push(handler)
      return () => {}
    },
  }
  return { ctx, registered, handlers, logs }
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
  smtp: { user: 'moodlee@qq.com' },
  to: ['moodlee@qq.com'],
  dryRun: true,
  ...extra,
})

test('enabled: false —— 不注册监听器，一条日志说明原因', () => {
  const { ctx, registered, logs } = createHarness()
  assert.doesNotThrow(() => apply(ctx, baseConfig({ enabled: false })))
  assert.deepEqual(registered, [], '没有注册任何事件监听器')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].level, 'info')
})

test('缺少 to —— apply 不抛异常，且不注册监听器', () => {
  const { ctx, registered, logs } = createHarness()
  const config = baseConfig()
  delete config.to
  assert.doesNotThrow(() => apply(ctx, config))
  assert.deepEqual(registered, [])
  assert.equal(logs[0]?.level, 'error')
})

test('收件人非法 —— apply 不抛异常，且不注册监听器', () => {
  const { ctx, registered, logs } = createHarness()
  assert.doesNotThrow(() => apply(ctx, baseConfig({ to: ['not-an-address'] })))
  assert.deepEqual(registered, [])
  assert.equal(logs[0]?.level, 'error')
})

test('发件域名认不出且没给 host —— apply 不抛异常，且不注册监听器', () => {
  const { ctx, registered, logs } = createHarness()
  assert.doesNotThrow(() => apply(ctx, { smtp: { user: 'someone@unknown-domain.test' }, to: ['a@b.com'] }))
  assert.deepEqual(registered, [])
  assert.equal(logs[0]?.level, 'error')
})

test('config 整个是 undefined —— apply 不抛异常，且不注册监听器', () => {
  const { ctx, registered } = createHarness()
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.deepEqual(registered, [])
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

  const sent = delivered(logs)
  assert.ok(sent.text.includes('body=32 字'), `10 + 2(空行) + 20 = 32，实际: ${sent.text}`)
})

test('结束原因进主题后缀，不假装是正常完成', async () => {
  const { ctx, handlers, logs } = createHarness()
  apply(ctx, baseConfig())

  const session = sessionOf()
  handlers[0](session, assistantEvent(7, 1, 'boom'))
  handlers[0](session, turnEndEvent(7, 'error'))
  await flush()

  const sent = delivered(logs)
  assert.ok(sent.text.includes('（出错）'), `实际: ${sent.text}`)
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

  const sent = delivered(logs)
  assert.ok(sent.text.includes('（已取消）'))
})
