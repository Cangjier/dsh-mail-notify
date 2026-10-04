/**
 * IMAP 客户端的离线协议用例：本机起一个假服务器，不联网、不碰真实邮箱。
 *
 * 覆盖：greeting 能力解析、LOGIN 引号转义、SELECT 的 UIDNEXT/UIDVALIDITY、
 * UID SEARCH、带字面量（`{n}`）的 FETCH（含被 TCP 切成两段的情形）、LOGOUT，
 * 以及两条安全约定——不支持 STARTTLS 时默认拒绝连接、拉取一律用 BODY.PEEK。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'

import { ImapClient, ImapError, quote } from '../imap.mjs'

/** 假服务器上那封「邮件」的信头与正文。 */
const HEADER = Buffer.from('From: moodlee@qq.com\r\nSubject: Re: DSH 任务完成\r\n\r\n', 'utf8')
const TEXT = Buffer.from('执行一次复检\r\n', 'utf8')

/**
 * 起一个最小 IMAP 服务器。
 * @param {object} [options] - 行为开关。
 * @param {boolean} [options.advertiseStartTls] - CAPABILITY 里是否声明 STARTTLS。
 * @param {boolean} [options.splitLiteral] - 是否把字面量拆成两个 TCP 片段（考缓冲）。
 * @returns {Promise<{ port: number, transcript: string[], close: () => Promise<void>, literalSent: Promise<void> }>} 服务器句柄。
 */
async function startFakeServer({ advertiseStartTls = false, splitLiteral = false } = {}) {
  const transcript = []
  let resolveLiteral
  const literalSent = new Promise((resolve) => {
    resolveLiteral = resolve
  })

  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('* OK [CAPABILITY IMAP4rev1 IDLE] fake ready\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        transcript.push(line)
        const space = line.indexOf(' ')
        const tag = line.slice(0, space)
        const command = line.slice(space + 1)
        const upper = command.toUpperCase()
        if (upper.startsWith('CAPABILITY')) {
          socket.write(`* CAPABILITY IMAP4rev1${advertiseStartTls ? ' STARTTLS' : ''} IDLE\r\n`)
          socket.write(`${tag} OK CAPABILITY done\r\n`)
        } else if (upper.startsWith('LOGIN')) {
          socket.write(`${tag} OK LOGIN done\r\n`)
        } else if (upper.startsWith('SELECT')) {
          socket.write('* 2 EXISTS\r\n')
          socket.write('* OK [UIDVALIDITY 42] ok\r\n')
          socket.write('* OK [UIDNEXT 101] ok\r\n')
          socket.write(`${tag} OK SELECT done\r\n`)
        } else if (upper.startsWith('UID SEARCH')) {
          socket.write('* SEARCH 100 101\r\n')
          socket.write(`${tag} OK UID SEARCH done\r\n`)
        } else if (upper.includes('BODY.PEEK[HEADER]')) {
          const tail = ` RFC822.SIZE ${HEADER.length + TEXT.length})\r\n${tag} OK UID FETCH done\r\n`
          socket.write(`* 1 FETCH (UID 100 BODY[HEADER] {${HEADER.length}}\r\n`)
          if (splitLiteral) {
            // 故意把字面量切成两段（先半个 TCP 片段，再连尾部一起发完），
            // 逼客户端在字节层缓冲，而不是按行读。
            socket.write(HEADER.subarray(0, 5))
            setTimeout(() => {
              socket.write(HEADER.subarray(5))
              socket.write(tail)
            }, 5)
          } else {
            socket.write(HEADER)
            socket.write(tail)
          }
        } else if (upper.includes('BODY.PEEK[TEXT]')) {
          socket.write(`* 1 FETCH (UID 100 BODY[TEXT] {${TEXT.length}}\r\n`)
          socket.write(TEXT)
          socket.write(')\r\n')
          socket.write(`${tag} OK UID FETCH done\r\n`)
          resolveLiteral()
        } else if (upper.startsWith('LOGOUT')) {
          socket.write('* BYE bye\r\n')
          socket.write(`${tag} OK LOGOUT done\r\n`)
          socket.end()
        } else if (upper.startsWith('STARTTLS')) {
          socket.write(`${tag} NO 假服务器不做 TLS\r\n`)
        } else {
          socket.write(`${tag} BAD 未知命令\r\n`)
        }
      }
    })
    socket.on('error', () => {})
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    transcript,
    literalSent,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

test('quote：按 RFC 3501 转义反斜杠与引号', () => {
  assert.equal(quote('plain'), '"plain"')
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"')
})

test('客户端：登录、SELECT、SEARCH、带字面量的 FETCH、LOGOUT', async () => {
  const server = await startFakeServer()
  try {
    const client = await ImapClient.connect({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      allowInsecure: true,
      user: 'moodlee@qq.com',
      password: 'auth-code',
      timeoutMs: 5000,
    })
    assert.equal(client.capabilities.has('IMAP4REV1'), true, 'greeting 里的能力要解析出来')

    const box = await client.select('INBOX')
    assert.deepEqual(box, { messages: 2, uidNext: 101, uidValidity: 42 })

    const uids = await client.searchUids('UID 100:*')
    assert.deepEqual(uids, [100, 101])

    const meta = await client.fetchMeta(100)
    assert.equal(meta.header.toString('utf8'), HEADER.toString('utf8'))
    assert.equal(meta.size, HEADER.length + TEXT.length)

    const text = await client.fetchText(100)
    assert.equal(text.toString('utf8'), TEXT.toString('utf8'))

    await client.logout()
  } finally {
    await server.close()
  }
})

test('客户端：字面量被 TCP 切成两段也要能拼回来', async () => {
  const server = await startFakeServer({ splitLiteral: true })
  try {
    const client = await ImapClient.connect({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      allowInsecure: true,
      user: 'u@qq.com',
      password: 'p',
      timeoutMs: 5000,
    })
    const meta = await client.fetchMeta(100)
    assert.equal(meta.header.toString('utf8'), HEADER.toString('utf8'))
    client.close()
  } finally {
    await server.close()
  }
})

test('安全：不支持 STARTTLS 且未显式放行时，拒绝在明文里发授权码', async () => {
  const server = await startFakeServer({ advertiseStartTls: false })
  try {
    await assert.rejects(
      () =>
        ImapClient.connect({
          host: '127.0.0.1',
          port: server.port,
          secure: false,
          user: 'u@qq.com',
          password: 'p',
          timeoutMs: 5000,
        }),
      (error) => {
        assert.ok(error instanceof ImapError)
        assert.match(error.message, /STARTTLS/)
        return true
      },
    )
    assert.equal(
      server.transcript.some((line) => line.toUpperCase().includes('LOGIN')),
      false,
      '拒绝之后绝不能发出 LOGIN',
    )
  } finally {
    await server.close()
  }
})

test('安全：拉取一律用 BODY.PEEK，绝不发出会置 \\Seen 的 BODY[...]', async () => {
  const server = await startFakeServer()
  try {
    const client = await ImapClient.connect({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      allowInsecure: true,
      user: 'u@qq.com',
      password: 'p',
      timeoutMs: 5000,
    })
    await client.select('INBOX')
    await client.fetchMeta(100)
    await client.fetchText(100)
    client.close()

    const fetches = server.transcript.filter((line) => line.toUpperCase().includes('FETCH'))
    assert.equal(fetches.length, 2)
    for (const line of fetches) {
      assert.match(line, /BODY\.PEEK\[/)
      assert.equal(/BODY\[/.test(line), false, `不该出现非 PEEK 的拉取：${line}`)
    }
    assert.equal(
      server.transcript.some((line) => /STORE|EXPUNGE|COPY|MOVE/i.test(line)),
      false,
      '不该对邮箱做任何写操作',
    )
  } finally {
    await server.close()
  }
})

test('客户端：命令被 NO 拒绝时抛出带状态码的错误', async () => {
  const server = await startFakeServer()
  try {
    const client = await ImapClient.connect({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      allowInsecure: true,
      user: 'u@qq.com',
      password: 'p',
      timeoutMs: 5000,
    })
    await assert.rejects(
      () => client.command('STARTTLS'),
      (error) => {
        assert.ok(error instanceof ImapError)
        assert.equal(error.status, 'NO')
        return true
      },
    )
    client.close()
  } finally {
    await server.close()
  }
})
