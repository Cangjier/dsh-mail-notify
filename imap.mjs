/**
 * 最小 IMAP 客户端：隐式 TLS（993）或 EHLO 后 STARTTLS（143），LOGIN，SELECT，
 * UID SEARCH，只读 UID FETCH（`BODY.PEEK[...]`，绝不设置 \Seen）。
 *
 * 和本包其余部分一样是零依赖的：只用 `node:net` 与 `node:tls`。这里只实现
 * 「收信触发」需要的窄子集，不做 mailbox 管理、不做 IDLE、不做 MOVE/COPY：
 * 拉取只读，邮箱状态由使用方自己记账（见 `reply.mjs` 的 UID 水位）。
 *
 * @module dsh-mail-notify/imap
 */

import { connect as connectTcp } from 'node:net'
import { connect as connectTls } from 'node:tls'

const CRLF = '\r\n'

/** 服务器拒绝了某条 IMAP 命令。 */
export class ImapError extends Error {
  /**
   * @param {string} message - 面向使用者的说明。
   * @param {string | undefined} status - 服务器返回的 OK/NO/BAD。
   * @param {string[]} replies - 服务器返回的原始回复行。
   */
  constructor(message, status, replies) {
    super(message)
    this.name = 'ImapError'
    this.status = status
    this.replies = replies
  }
}

/**
 * 把字符串写成 IMAP quoted string（转义 `\` 与 `"`）。
 * @param {string} value - 原始文本。
 * @returns {string} 带引号的字面量形式。
 */
export function quote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 逐字节读取 IMAP 回复，并把 `{n}` 字面量（literal）当成原文切出来。
 *
 * IMAP 的响应不是纯文本行：形如 `* 1 FETCH (BODY[] {12345}` 的行后面紧跟
 * 12345 个**原始字节**，之后才继续 CRLF 结尾的剩余部分。按行读会把二进制
 * 内容切坏，所以这里在字节层做状态机。
 */
class ReplyReader {
  /**
   * @param {import('node:net').Socket} socket - 已连接的套接字，读取器接管 data/error/close。
   */
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.failure = null
    this.closed = false
    this.resolvers = []

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.pump()
    })
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => {
      this.closed = true
      this.fail(new Error('IMAP 服务器关闭了连接'))
    })
  }

  /**
   * 记录一个致命错误，唤醒所有等待者。
   * @param {Error} error - 失败原因。
   * @returns {void}
   */
  fail(error) {
    if (this.failure === null) this.failure = error
    for (const resolve of this.resolvers.splice(0, this.resolvers.length)) resolve()
  }

  /** 有新数据或发生错误时唤醒等待者。 @returns {void} */
  pump() {
    for (const resolve of this.resolvers.splice(0, this.resolvers.length)) resolve()
  }

  /**
   * 等到至少 `count` 个字节可读。
   * @param {number} count - 需要的字节数。
   * @returns {Promise<void>} 数据足够或连接失败后结束。
   * @throws {Error} 连接关闭或出错时。
   */
  async ensure(count) {
    while (this.buffer.length < count) {
      if (this.failure !== null) throw this.failure
      if (this.closed) throw new Error('IMAP 服务器关闭了连接')
      await new Promise((resolve) => this.resolvers.push(resolve))
    }
  }

  /**
   * 读一行（含 CRLF），返回不含 CRLF 的文本。
   * @returns {Promise<string>} 一行文本。
   */
  async readLine() {
    for (;;) {
      const index = this.buffer.indexOf(CRLF)
      if (index !== -1) {
        const line = this.buffer.subarray(0, index).toString('utf8')
        this.buffer = this.buffer.subarray(index + CRLF.length)
        return line
      }
      await this.ensure(this.buffer.length + 1)
    }
  }

  /**
   * 读 `count` 个原始字节。
   * @param {number} count - 字节数。
   * @returns {Promise<Buffer>} 原始字节的副本。
   */
  async readBytes(count) {
    await this.ensure(count)
    const data = Buffer.from(this.buffer.subarray(0, count))
    this.buffer = this.buffer.subarray(count)
    return data
  }
}

/**
 * 一个 IMAP 会话：登录、选中邮箱、只读拉取，然后登出。
 *
 * 每次轮询新建一个连接，不做长连接——收信是分钟级的事，握手成本可以忽略，
 * 而长连接会带来重连与保活的状态机（以及 IDLE 的一堆边界）。
 */
export class ImapClient {
  /**
   * @param {object} options - 连接与凭据。
   * @param {string} options.host - IMAP 服务器主机名。
   * @param {number} options.port - 端口，隐式 TLS 通常 993，STARTTLS 通常 143。
   * @param {boolean} options.secure - true 为隐式 TLS，false 为 EHLO 后 STARTTLS。
   * @param {boolean} [options.allowInsecure] - true 时允许明文连接（只有测试与内网自建服务器用）。
   * @param {string} options.user - 登录账号。
   * @param {string} options.password - 授权码。
   * @param {number} [options.timeoutMs] - 单步读写超时，默认 30000。
   */
  constructor(options) {
    this.options = options
    this.socket = null
    this.reader = null
    this.tagCounter = 0
    /** 最近一条命令返回的字面量（`{n}` 后面的原始字节），按出现顺序排列。 */
    this.literals = []
    /** 服务器在 greeting 或 CAPABILITY 里宣告的能力。 */
    this.capabilities = new Set()
  }

  /**
   * 连接并登录。
   * @returns {Promise<ImapClient>} 已登录的客户端。
   * @throws {ImapError} 服务器拒绝认证时。
   * @throws {Error} 网络失败时。
   */
  static async connect(options) {
    const client = new ImapClient(options)
    try {
      await client.open()
      return client
    } catch (error) {
      // 建连到一半失败（例如服务器不支持 STARTTLS）也要把套接字收掉，
      // 否则它会一直挂到读超时。
      client.close()
      throw error
    }
  }

  /**
   * 建连、读 greeting、按需 STARTTLS、登录。
   * @returns {Promise<void>} 登录成功后结束。
   */
  async open() {
    const { host, port, secure, allowInsecure = false, user, password, timeoutMs = 30_000 } = this.options
    this.socket = secure
      ? connectTls({ host, port, servername: host })
      : connectTcp({ host, port })
    this.socket.setTimeout(timeoutMs, () => {
      this.socket?.destroy(new Error(`连接 ${host}:${port} 后 ${timeoutMs} 毫秒内没有响应`))
    })
    await new Promise((resolve, reject) => {
      this.socket.once(secure ? 'secureConnect' : 'connect', resolve)
      this.socket.once('error', reject)
    })

    this.reader = new ReplyReader(this.socket)
    const greeting = await this.reader.readLine()
    if (!greeting.startsWith('* OK') && !greeting.startsWith('* PREAUTH')) {
      throw new ImapError(`IMAP 服务器没有正常打招呼：${greeting}`, undefined, [greeting])
    }
    for (const match of greeting.matchAll(/\[CAPABILITY ([^\]]+)\]/g)) {
      for (const name of match[1].split(' ')) this.capabilities.add(name.toUpperCase())
    }

    if (!secure) {
      const capabilities = await this.command('CAPABILITY')
      for (const name of capabilities) this.capabilities.add(name)
      if (!this.capabilities.has('STARTTLS')) {
        if (!allowInsecure) {
          throw new ImapError(
            `${host}:${port} 不支持 STARTTLS，为避免明文传输授权码已中止连接；请改用 993（config.reply.secure: true），或显式设置配置里的 allowInsecure: true`,
            undefined,
            [],
          )
        }
      } else {
        await this.command('STARTTLS')
        this.reader = await this.upgrade()
        const afterTls = await this.command('CAPABILITY')
        this.capabilities.clear()
        for (const name of afterTls) this.capabilities.add(name)
      }
    }

    await this.command(`LOGIN ${quote(user)} ${quote(password)}`, { sensitive: true })
  }

  /**
   * 在已建立的明文连接上完成 TLS 握手。
   * @returns {Promise<ReplyReader>} 加密连接上的新读取器。
   */
  async upgrade() {
    const { host, timeoutMs = 30_000 } = this.options
    this.socket.setTimeout(0)
    const secured = connectTls({ socket: this.socket, servername: host })
    await new Promise((resolve, reject) => {
      secured.once('secureConnect', resolve)
      secured.once('error', reject)
    })
    secured.setTimeout(timeoutMs, () => {
      secured.destroy(new Error(`TLS 握手后 ${timeoutMs} 毫秒内没有响应`))
    })
    this.socket = secured
    return new ReplyReader(secured)
  }

  /**
   * 发一条命令并读到它的 tagged 回复。
   * @param {string} text - 命令本体，不含 tag。
   * @param {{ sensitive?: boolean }} [options] - sensitive 为 true 时出错信息里不回显命令。
   * @returns {Promise<string[]>} 该命令的所有回复文本行（含 untagged 行）。
   * @throws {ImapError} 命令被 NO/BAD 拒绝时。
   */
  async command(text, options = {}) {
    const tag = `m${(this.tagCounter += 1)}`
    this.socket.write(`${tag} ${text}${CRLF}`)
    const replies = []
    for (;;) {
      const { line, literals } = await this.readItem()
      replies.push(line)
      for (const literal of literals) this.literals.push(literal)
      if (line.startsWith(`${tag} `)) {
        const status = /^\S+ (OK|NO|BAD)\b/.exec(line)?.[1]
        if (status === undefined) throw new ImapError(`IMAP 回复无法识别：${line}`, undefined, [line])
        if (status !== 'OK') {
          const shown = options.sensitive === true ? `${text.split(' ')[0]} <凭据已隐藏>` : text
          throw new ImapError(`IMAP 命令「${shown}」被拒绝（${status}）：${line}`, status, replies)
        }
        return replies
      }
    }
  }

  /**
   * 读一个响应单元：一行，外加它可能携带的字面量。
   * @returns {Promise<{ line: string, literals: Buffer[] }>} 响应单元。
   */
  async readItem() {
    const literals = []
    let line = await this.reader.readLine()
    for (;;) {
      const match = /\{(\d+)\}$/.exec(line)
      if (match === null) break
      const data = await this.reader.readBytes(Number(match[1]))
      literals.push(data)
      line = await this.reader.readLine()
    }
    return { line, literals }
  }

  /**
   * 选中一个邮箱，返回它的 UID 水位信息。
   * @param {string} mailbox - 邮箱名，默认 INBOX。
   * @returns {Promise<{ messages: number, uidNext: number, uidValidity: number | null }>} 邮箱状态。
   * @throws {ImapError} 邮箱不存在时。
   */
  async select(mailbox = 'INBOX') {
    this.literals = []
    const replies = await this.command(`SELECT ${quote(mailbox)}`)
    const joined = replies.join('\n')
    const messages = Number(/^\* (\d+) EXISTS$/m.exec(joined)?.[1] ?? 0)
    const uidNext = Number(/\[UIDNEXT (\d+)\]/.exec(joined)?.[1] ?? 0)
    const uidValidity = /\[UIDVALIDITY (\d+)\]/.exec(joined)?.[1]
    return { messages, uidNext, uidValidity: uidValidity === undefined ? null : Number(uidValidity) }
  }

  /**
   * UID SEARCH：按 UID 区间找出邮件。
   * @param {string} criteria - SEARCH 条件，例如 `UID 4000:*`。
   * @returns {Promise<number[]>} 升序的 UID 列表。
   * @throws {ImapError} 服务器拒绝搜索时。
   */
  async searchUids(criteria) {
    const replies = await this.command(`UID SEARCH ${criteria}`)
    const line = replies.find((reply) => reply.startsWith('* SEARCH'))
    if (line === undefined) return []
    return line
      .slice('* SEARCH'.length)
      .trim()
      .split(/\s+/)
      .filter((part) => part !== '')
      .map(Number)
      .filter((uid) => Number.isSafeInteger(uid) && uid > 0)
      .sort((left, right) => left - right)
  }

  /**
   * 只读拉取一个区段（`BODY.PEEK[...]`，不会设置 \Seen）。
   *
   * 注意：这里不能用 RFC 3516 的局部拉取（`TEXT<0.n>`）来限制下载量——
   * 实测 QQ IMAP 对局部拉取会直接回 `BODY[] NIL`，所以调用方要用
   * {@link ImapClient.fetchMeta} 拿到的 `RFC822.SIZE` 先挡掉超大邮件。
   * @param {number} uid - 邮件 UID。
   * @param {string} section - 区段名，例如 `HEADER`、`TEXT`。
   * @returns {Promise<Buffer>} 该区段的原始字节。
   * @throws {ImapError} 服务器拒绝拉取或没有返回内容时。
   */
  async fetchPeek(uid, section) {
    this.literals = []
    const replies = await this.command(`UID FETCH ${uid} (BODY.PEEK[${section}])`)
    const [first] = this.literals
    if (first === undefined) {
      throw new ImapError(`UID ${uid} 的 BODY.PEEK[${section}] 没有返回内容：${replies.join(' | ')}`, undefined, replies)
    }
    return first
  }

  /**
   * 一次拉取信头和邮件大小：足够判断「值不值得下载正文」。
   * @param {number} uid - 邮件 UID。
   * @returns {Promise<{ header: Buffer, size: number | null }>} 信头字节与 RFC822.SIZE。
   * @throws {ImapError} 服务器拒绝拉取或没有返回信头时。
   */
  async fetchMeta(uid) {
    this.literals = []
    const replies = await this.command(`UID FETCH ${uid} (BODY.PEEK[HEADER] RFC822.SIZE)`)
    const [header] = this.literals
    if (header === undefined) {
      throw new ImapError(`UID ${uid} 没有返回信头：${replies.join(' | ')}`, undefined, replies)
    }
    const size = /RFC822\.SIZE (\d+)/.exec(replies.join(' '))?.[1]
    return { header, size: size === undefined ? null : Number(size) }
  }

  /**
   * 只读拉取整段正文（`BODY.PEEK[TEXT]`）。
   * @param {number} uid - 邮件 UID。
   * @returns {Promise<Buffer>} 正文原始字节（含 multipart 各段的段头）。
   * @throws {ImapError} 服务器拒绝拉取或没有返回正文时。
   */
  async fetchText(uid) {
    return this.fetchPeek(uid, 'TEXT')
  }

  /**
   * 登出并关闭连接。
   * @returns {Promise<void>} 连接关闭后结束。
   */
  async logout() {
    try {
      await this.command('LOGOUT')
    } catch (error) {
      // 服务器可能在 BYE 之后直接断开；登出失败不影响已经取到的数据。
      void error
    } finally {
      this.close()
    }
  }

  /** 强制关闭连接。 @returns {void} */
  close() {
    this.socket?.destroy()
  }
}
