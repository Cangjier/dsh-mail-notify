/**
 * 「邮件该在哪个工作区里跑」的离线用例：不联网、不调真模型。
 *
 * 模型的调用走注入的假 llm（只实现 `stream`），因此这里验证的是提示词框法、
 * 严格解析、路径/名字的确定性匹配，以及超时与失败的处理——都不是协议本身。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPickPrompt,
  completeOnce,
  matchWorkspace,
  mentionsTitle,
  normalizeCandidates,
  normalizePathKey,
  parsePick,
  WORKSPACE_PICK_SYSTEM,
} from '../workspace.mjs'

/** 两个候选工作区。 */
const candidates = [
  { path: 'C:\\Users\\Admin\\Documents\\GitHub\\dsh-mail-notify', title: 'dsh-mail-notify' },
  { path: 'C:\\Users\\Admin\\Documents\\GitHub\\web-app', title: 'web-app' },
]

/**
 * 假 llm：把预设的 chunks 原样吐出来。
 * @param {object[]} chunks - 要吐出的 chunks。
 * @returns {{ stream: Function, calls: object[] }} 假服务与调用记录。
 */
function fakeLlm(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** 一段正常的文字流 + 收尾。 */
const textStream = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('路径归一化：斜杠、大小写与结尾分隔符都不影响比较', () => {
  assert.equal(normalizePathKey('C:\\Users\\Admin\\'), 'c:/users/admin')
  assert.equal(normalizePathKey('c:/users/admin'), 'c:/users/admin')
  assert.equal(normalizePathKey('  C:\\Users\\Admin  '), 'c:/users/admin')
})

test('候选归一化：要求有路径、按路径去重、吃掉 registry 实体与普通对象两种形状', () => {
  const list = normalizeCandidates([
    { path: 'C:\\a', title: ' A ', sessionIds: ['s1', 's2'] },
    { path: 'c:/a/', title: '重复的' },
    { cwd: 'C:\\b' },
    { title: '没有路径' },
    null,
  ])
  assert.deepEqual(list, [
    { path: 'C:\\a', title: 'A', sessions: 2 },
    { path: 'C:\\b', title: '', sessions: 0 },
  ])
  assert.deepEqual(normalizeCandidates('nope'), [])
})

test('确定性匹配：邮件里写了完整路径就直接认出来（两种斜杠都认）', () => {
  assert.deepEqual(matchWorkspace('帮我看看 C:\\Users\\Admin\\Documents\\GitHub\\web-app 的登录', candidates), {
    path: 'C:\\Users\\Admin\\Documents\\GitHub\\web-app',
    how: 'path',
  })
  assert.deepEqual(matchWorkspace('路径是 c:/users/admin/documents/github/web-app/ ，谢谢', candidates), {
    path: 'C:\\Users\\Admin\\Documents\\GitHub\\web-app',
    how: 'path',
  })
})

test('确定性匹配：只写项目名时按整块匹配，不认嵌在更长单词里的那截', () => {
  assert.deepEqual(matchWorkspace('把 dsh-mail-notify 的 README 改一遍', candidates), {
    path: 'C:\\Users\\Admin\\Documents\\GitHub\\dsh-mail-notify',
    how: 'title',
  })
  // 名字是另一个名字的一部分时，只有最长的那个算命中。
  assert.deepEqual(
    matchWorkspace('看看 dsh-mail-notify 吧', [
      { path: 'C:\\a', title: 'notify' },
      { path: 'C:\\b', title: 'dsh-mail-notify' },
    ]),
    { path: 'C:\\b', how: 'title' },
  )
  // 两个一样长的名字都命中 → 说不清，交给模型。
  assert.equal(
    matchWorkspace('web-app 和另一个 web-app', [
      { path: 'C:\\a', title: 'web-app' },
      { path: 'C:\\b', title: 'WEB-APP' },
    ]),
    null,
  )
})

test('确定性匹配：没有线索、或只剩根目录那种超短路径时不乱认', () => {
  assert.equal(matchWorkspace('随便写点什么，跟项目无关', candidates), null)
  assert.equal(matchWorkspace('看看 C:\\proj 吧', [{ path: 'C:\\', title: '' }]), null, 'C:\\ 归一化后只有两个字符，不能命中')
  assert.equal(matchWorkspace('', candidates), null)
})

test('提示词：邮件与候选列表都框成 JSON，且写明答案格式', () => {
  const prompt = buildPickPrompt({ subject: '创建对话', from: 'me@qq.com', text: '帮我看看 web-app' }, candidates)
  assert.match(prompt, /"subject":"创建对话"/)
  assert.match(prompt, /"body":"帮我看看 web-app"/)
  assert.match(prompt, /web-app/)
  assert.match(prompt, /UNKNOWN/)
  assert.match(WORKSPACE_PICK_SYSTEM, /UNKNOWN/)
})

test('解析：只认候选里的路径或唯一标题，UNKNOWN 与幻觉都落空', () => {
  assert.deepEqual(parsePick('C:\\Users\\Admin\\Documents\\GitHub\\web-app', candidates), {
    path: 'C:\\Users\\Admin\\Documents\\GitHub\\web-app',
    how: 'llm',
  })
  assert.deepEqual(parsePick('  "c:/users/admin/documents/github/web-app"  ', candidates), {
    path: 'C:\\Users\\Admin\\Documents\\GitHub\\web-app',
    how: 'llm',
  })
  assert.deepEqual(parsePick('我觉得应该是 dsh-mail-notify 吧', [
    { path: 'C:\\x', title: 'dsh-mail-notify' },
    { path: 'C:\\y', title: 'web-app' },
  ]), { path: 'C:\\x', how: 'llm' })
  assert.equal(parsePick('UNKNOWN', candidates), null)
  assert.equal(parsePick('unknown', candidates), null)
  assert.equal(parsePick('C:\\不存在的目录', candidates), null, '列表外的路径一律不认')
  assert.equal(parsePick('', candidates), null)
  assert.equal(parsePick(undefined, candidates), null)
})

test('模型调用：把 text-delta 拼起来，正常结束就返回文本', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: 'C:\\Users\\' },
    { type: 'text-delta', index: 0, text: 'Admin' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const text = await completeOnce({ llm, provider: 'p', model: 'm', system: 's', user: 'u' })
  assert.equal(text, 'C:\\Users\\Admin')
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'p')
  assert.equal(llm.calls[0].model, 'm')
  assert.equal(llm.calls[0].messages[0].role, 'user')
  assert.equal(llm.calls[0].messages[0].content[0].text, 'u')
  assert.equal(typeof llm.calls[0].signal.addEventListener, 'function', '要能超时取消')
})

test('模型调用：服务缺失、报错、被取消、没有结束标记都要抛出，由调用方兜底', async () => {
  await assert.rejects(() => completeOnce({ llm: null, provider: 'p', model: 'm', system: 's', user: 'u' }), /llm 服务/)
  await assert.rejects(
    () =>
      completeOnce({
        llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: '额度用完了' } } }]),
        provider: 'p',
        model: 'm',
        system: 's',
        user: 'u',
      }),
    /额度用完了/,
  )
  await assert.rejects(
    () =>
      completeOnce({
        llm: fakeLlm([{ type: 'text-delta', index: 0, text: '半截' }]),
        provider: 'p',
        model: 'm',
        system: 's',
        user: 'u',
      }),
    /没有结束标记/,
  )
})

test('模型调用：超时会中止这一次调用，并给出可读原因', async () => {
  const llm = {
    stream: (options) =>
      (async function* generate() {
        await new Promise((resolve) => setTimeout(resolve, 30))
        yield { type: 'finish', reason: { kind: options.signal.aborted ? 'aborted' : 'stop', failure: { message: 'aborted' } } }
      })(),
  }
  await assert.rejects(
    () => completeOnce({ llm, provider: 'p', model: 'm', system: 's', user: 'u', timeoutMs: 5 }),
    /5ms 内没有给出答案/,
  )
})

test('模型调用：外部取消信号会传导进去', async () => {
  const controller = new AbortController()
  const llm = {
    stream: (options) =>
      (async function* generate() {
        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 1))
        yield { type: 'finish', reason: { kind: options.signal.aborted ? 'aborted' : 'stop', failure: { message: '取消了' } } }
      })(),
  }
  await assert.rejects(
    () => completeOnce({ llm, provider: 'p', model: 'm', system: 's', user: 'u', signal: controller.signal }),
    /取消了/,
  )
})

test('辅助：mentionsTitle 的边界规则', () => {
  assert.equal(mentionsTitle('看看 my-app 吧', 'my-app'), true)
  assert.equal(mentionsTitle('看看 my-appx 吧', 'my-app'), false)
  assert.equal(mentionsTitle('看看 xmy-app 吧', 'my-app'), false)
  assert.equal(mentionsTitle('看看 我的项目 吧', '我的项目'), true, '中文没有词边界，按子串认')
  assert.equal(mentionsTitle('随便', ''), false)
})
