/**
 * 不经过 dsh 的自检脚本：走一遍 配置解析 -> 邮件组装 -> SMTP 投递。
 *
 *   node selftest.mjs <发件邮箱> [收件邮箱...]
 *   node selftest.mjs you@qq.com
 *   node selftest.mjs you@qq.com someone@163.com another@gmail.com
 *
 * 也可以只给环境变量：
 *   MAIL_NOTIFY_USER=you@qq.com node selftest.mjs
 *
 * 收件人省略时发给自己。授权码默认从本目录的 secret.txt 读
 * （AUTH_CODE_FILE 环境变量可以改路径）。
 */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from './index.mjs'
import { buildMessage } from './mime.mjs'
import { sendMail } from './smtp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const [fromArgument, ...toArguments] = process.argv.slice(2)
const from = fromArgument ?? process.env.MAIL_NOTIFY_USER
if (typeof from !== 'string' || from === '') {
  console.error('用法: node selftest.mjs <发件邮箱> [收件邮箱...]')
  console.error('  或: MAIL_NOTIFY_USER=you@qq.com node selftest.mjs')
  process.exit(1)
}

const config = normalizeConfig({
  smtp: { user: from, from },
  to: toArguments.length > 0 ? toArguments : [from],
  subject: 'DSH mail-notify self-test',
  authCodeFile: process.env.AUTH_CODE_FILE,
})

console.log(`endpoint: ${config.host}:${config.port} secure=${config.secure}`)
console.log(`from:     ${config.from}`)
console.log(`to:       ${config.to.join(', ')}`)

const authCode = readFileSync(config.authCodeFile, 'utf8').replace(/\s+/g, '')
console.log(`auth code: ${authCode.length} 位，来自 ${config.authCodeFile}`)

const body = [
  '这是一封 dsh-mail-notify 的自检邮件。',
  '',
  '收到它说明以下环节都正常：',
  `1. 按发件域名推断出 SMTP 端点（${config.host}:${config.port}）`,
  '2. TLS 握手与证书校验',
  '3. AUTH 认证（授权码）',
  '4. 中文主题的 RFC 2047 编码与 base64 正文',
  '',
  '以点号开头的行测试：',
  '. 这一行以句点开头，不应被当成 DATA 结束标记',
  '',
  `—— dsh-mail-notify 自检（${HERE}）`,
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
