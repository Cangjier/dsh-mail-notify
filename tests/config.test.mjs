/**
 * `config.reply`（收信触发）配置校验的离线用例。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../index.mjs'

/** 一份最小可用的发信配置，reply 部分按需覆盖。 */
const base = (reply) => ({
  smtp: { user: 'someone@qq.com' },
  to: ['someone@qq.com'],
  reply,
})

/** 发件域名认不出（但 SMTP 端点手写）的配置，用来单独考 IMAP 推断。 */
const unknownDomain = (reply) => ({
  smtp: { user: 'someone@unknown-domain.test', host: 'smtp.internal' },
  to: ['a@b.com'],
  reply,
})

test('通知节奏：两种主题前缀、中途通知开关、安静窗口（允许 0）', () => {
  const defaults = normalizeConfig(base(undefined))
  assert.equal(defaults.subject, 'DSH 任务完成', '「全部结束」那一封的前缀')
  assert.equal(defaults.subjectProgress, 'DSH 任务进行中', '中途每轮的前缀')
  assert.equal(defaults.notifyProgress, true)
  assert.equal(defaults.finalQuietSeconds, 5)

  const custom = normalizeConfig({
    ...base(undefined),
    subject: '任务完成',
    subjectProgress: '还在跑',
    notifyProgress: false,
    finalQuietSeconds: 0,
  })
  assert.equal(custom.subject, '任务完成')
  assert.equal(custom.subjectProgress, '还在跑')
  assert.equal(custom.notifyProgress, false)
  assert.equal(custom.finalQuietSeconds, 0, '0 = 不等，立刻算整段结束')

  assert.throws(() => normalizeConfig({ ...base(undefined), subjectProgress: '  ' }), /subjectProgress 必须是非空字符串/)
  assert.throws(() => normalizeConfig({ ...base(undefined), notifyProgress: 'yes' }), /notifyProgress 必须是布尔值/)
  assert.throws(() => normalizeConfig({ ...base(undefined), finalQuietSeconds: -1 }), /finalQuietSeconds 必须是非负整数/)
})

test('提问通知：默认开启、可关、标题前缀可改，类型写错在加载时就报错', () => {
  const defaults = normalizeConfig(base(undefined))
  assert.equal(defaults.notifyQuestions, true, '默认：agent 提问时也发一封')
  assert.equal(defaults.subjectQuestion, 'DSH 等待你的回答')

  const custom = normalizeConfig({
    ...base(undefined),
    notifyQuestions: false,
    subjectQuestion: '等你拍板',
  })
  assert.equal(custom.notifyQuestions, false)
  assert.equal(custom.subjectQuestion, '等你拍板')

  assert.throws(() => normalizeConfig({ ...base(undefined), notifyQuestions: 'yes' }), /notifyQuestions 必须是布尔值/)
  assert.throws(() => normalizeConfig({ ...base(undefined), subjectQuestion: '  ' }), /subjectQuestion 必须是非空字符串/)
})

test('reply：默认关闭，且关闭时不要求能推断出 IMAP 服务器', () => {
  const config = normalizeConfig(unknownDomain(undefined))
  assert.equal(config.reply.enabled, false)
  assert.equal(config.reply.host, undefined, '关闭时不必能推断出 IMAP 端点')
  assert.equal(config.reply.keyword, 'DSH')
  assert.equal(config.reply.keywordScope, 'subject')
  assert.equal(config.reply.requireReply, true)
  assert.equal(config.reply.intervalSeconds, 60)
  assert.equal(config.reply.maxPerHour, 6)
  assert.equal(config.reply.cwd, 'auto', '默认按邮件内容挑工作区')
  assert.equal(config.reply.mailbox, 'INBOX')
  assert.deepEqual(config.reply.from, ['a@b.com'], '白名单默认取通知收件人')
  assert.match(config.reply.stateFile, /reply-state\.json$/)
})

test('reply：按发件域名推断 IMAP 端点（qq.com → imap.qq.com:993 隐式 TLS）', () => {
  const config = normalizeConfig(base({ enabled: true }))
  assert.equal(config.reply.host, 'imap.qq.com')
  assert.equal(config.reply.port, 993)
  assert.equal(config.reply.secure, true)
})

test('reply：开启但域名认不出时必须显式给 host', () => {
  assert.throws(() => normalizeConfig(unknownDomain({ enabled: true })), /IMAP 服务器/)
  const config = normalizeConfig(unknownDomain({ enabled: true, host: 'imap.internal', port: 143, secure: false }))
  assert.equal(config.reply.host, 'imap.internal')
  assert.equal(config.reply.port, 143)
})

test('reply：白名单可以显式覆盖，且必须是合法地址数组', () => {
  const config = normalizeConfig(base({ enabled: true, from: ['A@QQ.com', 'b@163.com'] }))
  assert.deepEqual(config.reply.from, ['A@QQ.com', 'b@163.com'])
  assert.throws(() => normalizeConfig(base({ enabled: true, from: 'a@qq.com' })), /必须是邮箱地址数组/)
  assert.throws(() => normalizeConfig(base({ enabled: true, from: ['nope'] })), /合法的邮箱地址/)
})

test('reply：keywordScope 只接受三个取值', () => {
  for (const scope of ['subject', 'body', 'either']) {
    assert.equal(normalizeConfig(base({ enabled: true, keywordScope: scope })).reply.keywordScope, scope)
  }
  assert.throws(() => normalizeConfig(base({ enabled: true, keywordScope: 'subject-only' })), /keywordScope/)
})

test('reply：cwd 必须是绝对路径、auto 或 last', () => {
  assert.equal(normalizeConfig(base({ enabled: true, cwd: 'C:/projects/x' })).reply.cwd, 'C:/projects/x')
  assert.equal(normalizeConfig(base({ enabled: true, cwd: 'last' })).reply.cwd, 'last')
  assert.equal(normalizeConfig(base({ enabled: true, cwd: 'auto' })).reply.cwd, 'auto')
  assert.throws(() => normalizeConfig(base({ enabled: true, cwd: 'relative/path' })), /绝对路径/)
})

test('reply：创建对话方案的标题短语默认认三条自然说法，可改、可加、可关', () => {
  assert.deepEqual(normalizeConfig(base(undefined)).reply.createSubject, ['创建对话', '创建新对话', '新建对话'])
  assert.deepEqual(normalizeConfig(base({ enabled: true, createSubject: '起个新活' })).reply.createSubject, ['起个新活'])
  assert.deepEqual(
    normalizeConfig(base({ enabled: true, createSubject: ['起个新活', ' 开个新坑 '] })).reply.createSubject,
    ['起个新活', '开个新坑'],
  )
  assert.deepEqual(normalizeConfig(base({ enabled: true, createSubject: false })).reply.createSubject, [])
  assert.deepEqual(normalizeConfig(base({ enabled: true, createSubject: [] })).reply.createSubject, [], '空数组 = 关掉')
  assert.throws(() => normalizeConfig(base({ enabled: true, createSubject: '  ' })), /createSubject 必须是非空字符串/)
  assert.throws(() => normalizeConfig(base({ enabled: true, createSubject: 42 })), /createSubject 必须是非空字符串/)
  assert.throws(
    () => normalizeConfig(base({ enabled: true, createSubject: ['好的', 42] })),
    /createSubject\[1\] 必须是非空字符串/,
    '数组里出错要指出是哪一条',
  )
})

test('reply：类型写错在加载时就报错，不拖到轮询时才失败', () => {
  assert.throws(() => normalizeConfig(base('nope')), /config\.reply 必须是一个对象/)
  assert.throws(() => normalizeConfig(base({ enabled: 'yes' })), /config\.reply\.enabled 必须是布尔值/)
  assert.throws(() => normalizeConfig(base({ enabled: true, intervalSeconds: 0 })), /intervalSeconds 必须是正整数/)
  assert.throws(() => normalizeConfig(base({ enabled: true, keyword: '  ' })), /keyword 必须是非空字符串/)
})

test('reply：mode 默认是追加，且只接受 append / new', () => {
  assert.equal(normalizeConfig(base({ enabled: true })).reply.mode, 'append')
  assert.equal(normalizeConfig(base({ enabled: true, mode: 'new' })).reply.mode, 'new')
  assert.equal(normalizeConfig(base({ enabled: true, mode: 'append' })).reply.mode, 'append')
  assert.throws(() => normalizeConfig(base({ enabled: true, mode: 'append-to-session' })), /mode 只能是/)
})

test('reply：与发信开关相互独立', () => {
  const onlyReply = normalizeConfig({ ...base({ enabled: true }), enabled: false })
  assert.equal(onlyReply.enabled, false, '不发通知')
  assert.equal(onlyReply.reply.enabled, true, '但仍然收信触发')
})

test('skipSources：默认只跳定时任务，可加来源、可写空数组关掉', () => {
  assert.deepEqual(normalizeConfig(base(undefined)).skipSources, ['schedule'], '默认只跳 dsh-schedule 的定时提醒')
  assert.deepEqual(normalizeConfig({ ...base(undefined), skipSources: [] }).skipSources, [], '空数组 = 一个都不跳')
  assert.deepEqual(
    normalizeConfig({ ...base(undefined), skipSources: ['schedule', 'goal'] }).skipSources,
    ['schedule', 'goal'],
    '顺序与内容原样保留，status 会把它们报回去',
  )
  assert.deepEqual(
    normalizeConfig({ ...base(undefined), skipSources: [' cordis-host-runner '] }).skipSources,
    ['cordis-host-runner'],
    '每项去掉首尾空白',
  )
  assert.throws(() => normalizeConfig({ ...base(undefined), skipSources: 'schedule' }), /skipSources 必须是字符串数组/)
  assert.throws(() => normalizeConfig({ ...base(undefined), skipSources: ['schedule', '  '] }), /skipSources\[1\] 必须是非空字符串/)
  assert.throws(() => normalizeConfig({ ...base(undefined), skipSources: [42] }), /skipSources\[0\] 必须是非空字符串/)
})

test('skipSources：默认值不被调用方改坏（冻结的出厂默认每次都要拷一份）', () => {
  const first = normalizeConfig({ ...base(undefined), skipSources: undefined })
  first.skipSources.push('goal')
  assert.deepEqual(normalizeConfig(base(undefined)).skipSources, ['schedule'], '改一次配置不该污染下一次的默认值')
})
