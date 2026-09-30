/**
 * 一个最小可用的 SMTP 客户端：隐式 TLS（465）或 EHLO 后 STARTTLS（587/25）、
 * AUTH PLAIN / AUTH LOGIN、一次连接投递一封邮件。
 *
 * 本包不依赖 harness 包，也不依赖任何第三方包，所以这里只用 Node 内置的
 * `node:net` 与 `node:tls`。
 *
 * @module dsh-mail-notify/smtp
 */

import { connect as connectTcp } from 'node:net'
import { connect as connectTls } from 'node:tls'

/** 服务器拒绝了某条 SMTP 命令。 */
export class SmtpError extends Error {
  /**
   * @param {string} message - 面向使用者的说明。
   * @param {number | undefined} code - 服务器返回的三位状态码。
   * @param {string[]} replies - 服务器返回的原始回复行。
   */
  constructor(message, code, replies) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
    this.replies = replies
  }
}

/**
 * 按行读取服务器回复，并把一条多行回复（`250-` 续行）拼成一组。
 * @param {import('node:net').Socket} socket - 已连接的套接字，读取器接管它的 data/error/close。
 * @returns {{ readResponse: () => Promise<string[]>, detach: () => void }} 读取器与摘除函数。
 */
function createReplyReader(socket) {
  let buffer = ''
  let closed = false
  let failure = null
  const queued = []
  const waiters = []

  const fail = (error) => {
    if (failure === null) failure = error
    for (const waiter of waiters.splice(0, waiters.length)) waiter.reject(failure)
  }

  const onData = (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index === -1) break
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      const waiter = waiters.shift()
      if (waiter === undefined) queued.push(line)
      else waiter.resolve(line)
    }
  }
  const onError = (error) => fail(error)
  const onClose = () => {
    closed = true
    fail(new Error('SMTP 服务器关闭了连接'))
  }

  socket.setEncoding('utf8')
  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)

  const readLine = () => {
    if (queued.length > 0) return Promise.resolve(queued.shift())
    if (failure !== null) return Promise.reject(failure)
    if (closed) return Promise.reject(new Error('SMTP 服务器关闭了连接'))
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject })
    })
  }

  const readResponse = async () => {
    const replies = []
    for (;;) {
      const line = await readLine()
      if (!/^\d{3}[ -]/.test(line)) {
        throw new SmtpError(`SMTP 回复无法识别: ${JSON.stringify(line)}`, undefined, [line])
      }
      replies.push(line)
      if (line[3] === ' ') break
    }
    return replies
  }

  return {
    readResponse,
    detach: () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    },
  }
}

/**
 * 发出一条命令并校验状态码。
 * @param {import('node:net').Socket} socket - 当前套接字。
 * @param {{ readResponse: () => Promise<string[]> }} reader - 当前套接字的读取器。
 * @param {string} line - 要发送的命令行，不含 CRLF。
 * @param {number[]} expected - 可接受的状态码。
 * @param {string} label - 出错信息里显示的命令名；凭据命令用它脱敏。
 * @returns {Promise<string[]>} 服务器回复行。
 * @throws {SmtpError} 状态码不在 expected 里时。
 */
async function command(socket, reader, line, expected, label) {
  socket.write(`${line}\r\n`)
  const replies = await reader.readResponse()
  const code = Number.parseInt(replies[0].slice(0, 3), 10)
  if (!expected.includes(code)) {
    throw new SmtpError(`SMTP 命令「${label}」被拒绝（${code}）：${replies.join(' | ')}`, code, replies)
  }
  return replies
}

/**
 * 把 EHLO 回复行解析成「能力关键字 -> 参数」的映射。
 * @param {string[]} replies - EHLO 的回复行。
 * @returns {Map<string, string>} 关键字小写后的能力表。
 */
function parseCapabilities(replies) {
  const capabilities = new Map()
  for (const reply of replies) {
    const text = reply.slice(4).trim()
    if (text === '') continue
    const space = text.indexOf(' ')
    const keyword = (space === -1 ? text : text.slice(0, space)).toLowerCase()
    capabilities.set(keyword, space === -1 ? '' : text.slice(space + 1).trim())
  }
  return capabilities
}

/**
 * 按 RFC 5321 转义正文里位于行首的点号，避免被当成结束标记。
 * @param {string} text - 完整邮件文本（信头加正文）。
 * @returns {string} 转义后的文本。
 */
function dotStuff(text) {
  return text.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..')
}

/**
 * 建立连接并等到可读写为止。
 * @param {{ host: string, port: number, secure: boolean, timeoutMs: number }} options - 连接参数。
 * @returns {Promise<import('node:net').Socket>} 已连接的套接字。
 */
async function openConnection({ host, port, secure, timeoutMs }) {
  const socket = secure ? connectTls({ host, port, servername: host }) : connectTcp({ host, port })
  socket.setTimeout(timeoutMs, () => {
    socket.destroy(new Error(`连接 ${host}:${port} 后 ${timeoutMs} 毫秒内没有响应`))
  })
  await new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve)
    socket.once('error', reject)
  })
  return socket
}

/**
 * 在已有明文连接上完成 TLS 握手。
 * @param {import('node:net').Socket} socket - STARTTLS 之后的明文套接字。
 * @param {string} host - 用于 SNI 与证书校验的主机名。
 * @param {number} timeoutMs - 握手后的读写超时毫秒数。
 * @returns {Promise<import('node:tls').TLSSocket>} 加密套接字。
 */
async function upgradeToTls(socket, host, timeoutMs) {
  socket.setTimeout(0)
  const secured = connectTls({ socket, servername: host })
  await new Promise((resolve, reject) => {
    secured.once('secureConnect', resolve)
    secured.once('error', reject)
  })
  secured.setTimeout(timeoutMs, () => {
    secured.destroy(new Error(`TLS 握手后 ${timeoutMs} 毫秒内没有响应`))
  })
  return secured
}

/**
 * 投递一封已经组装好的邮件。
 *
 * `secure: false` 时强制要求服务器支持 STARTTLS：否则授权码会以明文过网，
 * 这种情况直接报错，而不是降级发送。
 *
 * @param {object} options - 连接、认证与信封参数。
 * @param {string} options.host - SMTP 服务器主机名。
 * @param {number} options.port - SMTP 服务器端口。
 * @param {boolean} options.secure - true 为隐式 TLS（465），false 为 EHLO 后 STARTTLS。
 * @param {string | null} options.user - SMTP 登录账号；null 表示不做认证。
 * @param {string | null} options.password - SMTP 授权码；user 为 null 时忽略。
 * @param {string} options.from - 信封发件人，同时用于 EHLO 域名。
 * @param {string[]} options.recipients - 信封收件人。
 * @param {string} options.message - 完整信头加正文，行尾必须是 CRLF。
 * @param {number} [options.timeoutMs] - 单步读写超时毫秒数，默认 30000。
 * @returns {Promise<void>} 服务器接受邮件后结束。
 * @throws {SmtpError} 任一命令被拒绝，或服务器不支持 STARTTLS 时。
 */
export async function sendMail({
  host,
  port,
  secure,
  user,
  password,
  from,
  recipients,
  message,
  timeoutMs = 30_000,
}) {
  let socket = await openConnection({ host, port, secure, timeoutMs })
  let reader = createReplyReader(socket)
  try {
    const greeting = await reader.readResponse()
    const greetingCode = Number.parseInt(greeting[0].slice(0, 3), 10)
    if (greetingCode !== 220) {
      throw new SmtpError(`服务器没有正常打招呼（${greetingCode}）：${greeting.join(' | ')}`, greetingCode, greeting)
    }

    const clientName = from.slice(from.indexOf('@') + 1)
    let capabilities = parseCapabilities(await command(socket, reader, `EHLO ${clientName}`, [250], 'EHLO'))

    if (!secure) {
      if (!capabilities.has('starttls')) {
        throw new SmtpError(
          `${host}:${port} 不支持 STARTTLS，为避免明文传输授权码已中止发送；请改用 465 端口（config.smtp.secure: true）`,
          undefined,
          [],
        )
      }
      await command(socket, reader, 'STARTTLS', [220], 'STARTTLS')
      reader.detach()
      socket = await upgradeToTls(socket, host, timeoutMs)
      reader = createReplyReader(socket)
      capabilities = parseCapabilities(await command(socket, reader, `EHLO ${clientName}`, [250], 'EHLO'))
    }

    if (user !== null && user !== undefined) {
      const mechanisms = (capabilities.get('auth') ?? '')
        .toUpperCase()
        .split(/\s+/)
        .filter((mechanism) => mechanism !== '')
      if (mechanisms.includes('PLAIN')) {
        const token = Buffer.from(`\u0000${user}\u0000${password ?? ''}`, 'utf8').toString('base64')
        await command(socket, reader, `AUTH PLAIN ${token}`, [235], 'AUTH PLAIN')
      } else if (mechanisms.length === 0 || mechanisms.includes('LOGIN')) {
        await command(socket, reader, 'AUTH LOGIN', [334], 'AUTH LOGIN')
        await command(socket, reader, Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH LOGIN <用户名>')
        await command(socket, reader, Buffer.from(password ?? '', 'utf8').toString('base64'), [235], 'AUTH LOGIN <授权码>')
      } else {
        throw new SmtpError(`服务器只提供不支持的认证方式：${mechanisms.join(' ')}`, undefined, [])
      }
    }

    await command(socket, reader, `MAIL FROM:<${from}>`, [250], 'MAIL FROM')
    for (const recipient of recipients) {
      await command(socket, reader, `RCPT TO:<${recipient}>`, [250, 251], `RCPT TO:<${recipient}>`)
    }
    await command(socket, reader, 'DATA', [354], 'DATA')
    socket.write(`${dotStuff(message)}\r\n.\r\n`)

    const accepted = await reader.readResponse()
    const acceptedCode = Number.parseInt(accepted[0].slice(0, 3), 10)
    if (acceptedCode !== 250) {
      throw new SmtpError(`服务器拒绝接收邮件（${acceptedCode}）：${accepted.join(' | ')}`, acceptedCode, accepted)
    }

    try {
      await command(socket, reader, 'QUIT', [221], 'QUIT')
    } catch (error) {
      // 邮件已被服务器接收；部分服务器在 DATA 之后直接断开，QUIT 失败不影响投递结果。
      void error
    }
  } finally {
    socket.destroy()
  }
}
