/**
 * 每轮通知调度器的离线用例：假时钟驱动，不碰网络、不建会话。
 *
 * 这里专门验证「一轮结束」与「整段任务结束」怎么分开 —— 也就是邮件标题里
 * 「进行中」和「完成」两种前缀的判定依据：
 * 驱动循环是 `while (await turn())`，多轮之间**不会**回到 idle，只有整段跑完
 * `agent.status` 才变 idle；所以一轮结束要等安静窗口，期间来了 `turn/start`
 * 就说明它只是中途。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTurnScheduler } from '../index.mjs'

/**
 * 造一个可手动推进的假时钟。
 * @returns {{ schedule: Function, cancel: Function, advance: (ms: number) => void, pending: () => number }} 假时钟。
 */
function createClock() {
  let nextId = 1
  let now = 0
  const timers = new Map()
  return {
    schedule: (callback, delay) => {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, at: now + delay })
      return { id, unref() {}, _fake: true }
    },
    cancel: (handle) => {
      if (handle?._fake === true) timers.delete(handle.id)
    },
    /** 推进时间：累计到期的回调按到期时间顺序执行。 */
    advance: (ms) => {
      now += ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at)
        if (due.length === 0) return
        const [id, timer] = due[0]
        timers.delete(id)
        timer.callback()
      }
    },
    pending: () => timers.size,
  }
}

/** 造一个调度器 + 记录投递内容。`subagents` 是「名下正在跑的子代理会话数」。 */
function createScheduler({ notifyProgress = true, quietSeconds = 5, idle = true, sessionId = 's-1', subagents = 0 } = {}) {
  const clock = createClock()
  const sent = []
  const idleness = { value: idle }
  const subagentState = { value: subagents }
  const scheduler = createTurnScheduler({
    config: { finalQuietSeconds: quietSeconds, notifyProgress },
    isIdle: () => idleness.value,
    runningSubagents: () => subagentState.value,
    deliver: (payload) => {
      sent.push(payload)
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  const session = { id: sessionId, header: {} }
  return { scheduler, sent, clock, session, idleness, subagentState }
}

/** 造一条 turn/end 事件。 */
const turnEnd = (turn) => ({ turn, reason: { kind: 'completed' } })

test('单轮任务：只发一封，而且是「完成」', () => {
  const { scheduler, sent, clock, session } = createScheduler()
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  assert.equal(sent.length, 0, '安静窗口没过，先不发')
  assert.equal(clock.pending(), 1)

  clock.advance(5000)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'final')
  assert.equal(sent[0].text, '第一轮')
  assert.equal(sent[0].turns, 1)
})

test('多轮任务：中途发「进行中」，最后一轮发「完成」', () => {
  const { scheduler, sent, clock, session } = createScheduler()
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  assert.equal(sent.length, 0)

  // 第二轮开始 ⇒ 第一轮只是中途
  scheduler.onTurnStart(session)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'progress')
  assert.equal(sent[0].text, '第一轮')

  scheduler.onTurnEnd({ session, event: turnEnd(2), text: '第二轮' })
  clock.advance(5000)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].kind, 'final')
  assert.equal(sent[1].text, '第二轮')
  assert.equal(sent[1].turns, 2, '收尾那封要带总轮数')
})

test('发过「进行中」之后旧定时器必须失效：同一轮不会被再当一次「全部结束」', () => {
  const { scheduler, sent, clock, session } = createScheduler()
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  clock.advance(1000)

  // 第二轮开始，第一轮作为「进行中」发出；此时安静窗口必须重新计时。
  scheduler.onTurnStart(session)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'progress')

  // 推过原来那个窗口：如果没重新计时，这里就会多出一封「完成｜第一轮」。
  clock.advance(2000)
  assert.equal(sent.length, 1, '旧定时器必须已经失效')
  assert.equal(sent.filter((payload) => payload.kind === 'final').length, 0)

  scheduler.onTurnEnd({ session, event: turnEnd(2), text: '第二轮' })
  clock.advance(5000)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].kind, 'final')
  assert.equal(sent[1].text, '第二轮', '收尾那封带的必须是最后一轮的回答')
  assert.equal(sent[1].turns, 2)
})

test('notifyProgress: false —— 中途那些轮不单独发', () => {
  const { scheduler, sent, clock, session } = createScheduler({ notifyProgress: false })
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  scheduler.onTurnStart(session)
  assert.equal(sent.length, 0, '低噪音模式中途不发')
  scheduler.onTurnEnd({ session, event: turnEnd(2), text: '第二轮' })
  clock.advance(5000)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'final')
})

test('安静窗口内又开了新一轮：重新计时，不误报「全部结束」', () => {
  const { scheduler, sent, clock, session } = createScheduler()
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  clock.advance(3000)
  assert.equal(sent.length, 0)

  // 没收到 turn/start，但会话又忙起来了（例如外部驱动的自动续跑）
  scheduler.onTurnEnd({ session, event: turnEnd(2), text: '第二轮' })
  clock.advance(3000)
  assert.equal(sent.length, 0, '安静窗口每次都重新计时')

  clock.advance(2000)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].turns, 2, '两轮都算进这一波')
})

test('窗口到期但 agent 还在跑：不发，继续等；停稳后才发', () => {
  const { scheduler, sent, clock, session, idleness } = createScheduler()
  idleness.value = false
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  clock.advance(5000)
  assert.equal(sent.length, 0, '还在跑，不能报「全部结束」')
  assert.equal(clock.pending(), 1, '要重新武装等待')

  idleness.value = true
  clock.advance(5000)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'final')
})

test('多个会话各自独立计时', () => {
  const first = createScheduler({ sessionId: 's-1' })
  const second = createScheduler({ sessionId: 's-2' })
  first.scheduler.onTurnEnd({ session: first.session, event: turnEnd(1), text: '甲' })
  second.scheduler.onTurnEnd({ session: second.session, event: turnEnd(1), text: '乙' })

  // 只推进第一个会话的时钟：第二个不会受影响。
  first.clock.advance(5000)
  assert.equal(first.sent.length, 1)
  assert.equal(first.sent[0].text, '甲')
  assert.equal(second.sent.length, 0, '另一个会话的定时器不归它管')
  assert.equal(second.scheduler.pendingCount(), 1)

  second.clock.advance(5000)
  assert.equal(second.sent.length, 1)
  assert.equal(second.sent[0].text, '乙')
})

test('dispose 会清掉待发与定时器', () => {
  const { scheduler, sent, clock, session } = createScheduler()
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  scheduler.dispose()
  assert.equal(scheduler.pendingCount(), 0)
  assert.equal(clock.pending(), 0)
  clock.advance(5000)
  assert.equal(sent.length, 0)
})

test('父会话 idle 但子代理还在跑：不报「完成」，改发「进行中」并带上子代理数', () => {
  const { scheduler, sent, clock, session } = createScheduler({ subagents: 2 })
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '收口前的回答' })
  clock.advance(5000)

  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'progress', '子代理在跑时绝不能标成 final')
  assert.equal(sent[0].subagentsRunning, 2)
  assert.equal(sent[0].text, '收口前的回答')
  assert.equal(sent[0].turns, 1)
  assert.equal(scheduler.pendingCount(), 0, '这一封已经发出去了，不该再等出第二封')
})

test('notifyProgress: false + 子代理还在跑：继续等，等它们跑完才发收尾那封', () => {
  const { scheduler, sent, clock, session, subagentState } = createScheduler({
    notifyProgress: false,
    quietSeconds: 0,
    subagents: 1,
  })
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  clock.advance(0)
  assert.equal(sent.length, 0, '低噪音模式不能因为子代理而多发一封')
  assert.equal(clock.pending(), 1, '要继续等子代理跑完')

  subagentState.value = 0
  clock.advance(1000)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'final')
  assert.equal(sent[0].turns, 1)
})

test('子代理跑完后恢复完成判定：下一轮收尾照常报「完成」', () => {
  const { scheduler, sent, clock, session, subagentState } = createScheduler({ subagents: 1 })
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  clock.advance(5000)
  assert.equal(sent[0].kind, 'progress')

  subagentState.value = 0
  scheduler.onTurnEnd({ session, event: turnEnd(2), text: '第二轮' })
  clock.advance(5000)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].kind, 'final')
})

test('turn/start 重复到达只发一次「进行中」，收尾仍只发一封', () => {
  const { scheduler, sent, clock, session } = createScheduler()
  scheduler.onTurnEnd({ session, event: turnEnd(1), text: '第一轮' })
  scheduler.onTurnStart(session)
  scheduler.onTurnStart(session)
  assert.equal(sent.length, 1, '没有新的未发轮次时，turn/start 不该重复发')
  clock.advance(5000)
  assert.equal(sent.length, 2, '这一波收尾再发一封「完成」')
  assert.equal(sent[1].kind, 'final')
  assert.equal(sent[1].turns, 1)
})
