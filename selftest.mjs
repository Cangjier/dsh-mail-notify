/**
 * 不经过 dsh 的自检脚本：走一遍 配置解析 -> 邮件组装 -> SMTP 投递。
 *
 *   node selftest.mjs
 *
 * 收件人取自 cordis.patch.yml 里同名的默认配置，发的是固定主题，方便你在
 * 装进 profile 之前先确认网络、TLS、授权码和中文编码都没问题。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from './index.mjs'
import { buildMessage } from './mime.mjs'
import { sendMail } from './smtp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const config = normalizeConfig({
  smtp: { user: 'moodlee@qq.com', from: 'moodlee@qq.com' },
  to: ['moodlee@qq.com'],
  subject: 'DSH mail-notify self-test',
})

console.log(`endpoint: ${config.host}:${config.port} secure=${config.secure}`)
console.log(`from: ${config.from}`)
console.log(`to:   ${config.to.join(', ')}`)

const secretPath = resolvePath(HERE, 'secret.txt')
const authCode = readFileSync(secretPath, 'utf8').replace(/\s+/g, '')
console.log(`auth code: ${authCode.length} chars from ${secretPath}`)

const body = [
  '这是一封 dsh-mail-notify 的自检邮件。',
  '',
  '收到它说明以下环节都正常：',
  '1. 按发件域名推断出 SMTP 端点（qq.com -> smtp.qq.com:465，隐式 TLS）',
  '2. TLS 握手与证书校验',
  '3. AUTH 认证（授权码）',
  '4. 中文主题的 RFC 2047 编码与 base64 正文',
  '',
  '以点号开头的行测试：',
  '. 这一行以句点开头，不应被当成 DATA 结束标记',
  '',
  '—— dsh-mail-notify',
].join('\n')

for (const recipient of config.to) {
  const message = buildMessage({ from: config.from, to: recipient, subject: config.subject, body })
  await sendMail({
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    password: authCode,
    from: config.from,
    recipients: [recipient],
    message,
    timeoutMs: 30_000,
  })
  console.log(`SENT OK -> ${recipient}`)
}
