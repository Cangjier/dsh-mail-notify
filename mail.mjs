/**
 * 邮件解析：信头展开与 RFC 2047 解码、multipart 切分、Content-Transfer-Encoding
 * 解码、字符集解码，最后取出「人写的那段纯文本」。
 *
 * 全部按字节处理（Buffer），因为邮件正文可能是任意字符集、任意传输编码；只有
 * 信头的关键字是 ASCII，才用 latin1 当容器读。零依赖，只用 Node 内置能力
 * （`TextDecoder` 在 Node 24 里带完整 ICU，gbk/gb18030 都能解）。
 *
 * @module dsh-mail-notify/mail
 */

const CRLF = '\r\n'
const LF = '\n'

/** 单条编码字：`=?charset?B|Q?payload?=`。 */
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g

/**
 * 按字符集把字节解码成文本。
 * @param {Buffer} bytes - 原始字节。
 * @param {string | undefined} charset - 邮件里声明的字符集名。
 * @returns {string} 解码后的文本；字符集不认识时退回 UTF-8，再不行退回 latin1。
 */
export function decodeCharset(bytes, charset) {
  const label = normalizeCharset(charset)
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    } catch {
      return bytes.toString('latin1')
    }
  }
}

/**
 * 归一化字符集名：邮件里常见的别名与错误写法。
 * @param {string | undefined} charset - 原始字符集名。
 * @returns {string} TextDecoder 能接受的标签。
 */
function normalizeCharset(charset) {
  const name = (charset ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (name === '') return 'utf-8'
  if (name === 'utf8') return 'utf-8'
  if (name === 'gb2312' || name === 'gbk' || name === 'gb18030' || name === 'cp936') return 'gb18030'
  if (name === 'ansi' || name === 'ascii' || name === 'us-ascii') return 'windows-1252'
  if (name === 'latin1' || name === 'latin-1') return 'windows-1252'
  if (name.startsWith('ks_c_5601') || name === 'euc-kr') return 'euc-kr'
  return name
}

/**
 * 把 `=?charset?B?...?=` / `=?charset?Q?...?=` 编码字解回原文。
 *
 * 相邻编码字之间用于折行的空白按 RFC 2047 丢弃，否则「DSH 任务完成」这种被
 * 编码器切成多段的标题会多出空格。
 *
 * 编码字之外的**字面段**按 UTF-8 再解释一次：信头字节是当 latin1 读进来的，
 * 而现实中确实有客户端/脚本直接塞裸 UTF-8 主题（不合 RFC 2047，但很常见）。
 * @param {string} value - 原始信头值（可能含多段编码字）。
 * @returns {string} 解码后的文本。
 */
export function decodeWords(value) {
  const collapsed = value.replace(/(\?=)\s+(=\?)/g, '$1$2')
  let out = ''
  let last = 0
  for (const match of collapsed.matchAll(ENCODED_WORD)) {
    out += decodeLiteralSegment(collapsed.slice(last, match.index))
    out += decodeEncodedWord(match)
    last = match.index + match[0].length
  }
  return out + decodeLiteralSegment(collapsed.slice(last))
}

/**
 * 还原一段没有 RFC 2047 编码字的字面文本。
 * @param {string} text - 以 latin1 读入的信头片段。
 * @returns {string} 若含 8bit 字节则按 UTF-8 重新解释，否则原样返回。
 */
function decodeLiteralSegment(text) {
  if (!/[\u0080-\u00ff]/.test(text)) return text
  return Buffer.from(text, 'latin1').toString('utf8')
}

/**
 * 解一个 RFC 2047 编码字。
 * @param {RegExpMatchArray} match - `ENCODED_WORD` 的匹配结果。
 * @returns {string} 解码结果；非法编码时原样返回。
 */
function decodeEncodedWord(match) {
  const [, charset, encoding, payload] = match
  try {
    const raw =
      encoding.toLowerCase() === 'b'
        ? Buffer.from(payload, 'base64')
        : decodeQuotedPrintable(Buffer.from(payload.replace(/_/g, ' '), 'latin1'))
    return decodeCharset(raw, charset)
  } catch {
    return match[0]
  }
}

/**
 * 解 quoted-printable：`=XX` 还原字节，行尾的 `=` 是软换行要丢掉。
 * @param {Buffer} bytes - 原始字节。
 * @returns {Buffer} 解码后的字节。
 */
export function decodeQuotedPrintable(bytes) {
  const text = bytes.toString('latin1')
  const out = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character !== '=') {
      out.push(text.charCodeAt(index))
      continue
    }
    const next = text[index + 1]
    const after = text[index + 2]
    if (next === '\r' && after === '\n') {
      index += 2
      continue
    }
    if (next === '\n') {
      index += 1
      continue
    }
    if (/^[0-9A-Fa-f]{2}$/.test(`${next ?? ''}${after ?? ''}`)) {
      out.push(Number.parseInt(`${next}${after}`, 16))
      index += 2
      continue
    }
    out.push(character.charCodeAt(0))
  }
  return Buffer.from(out)
}

/**
 * 解 base64 传输编码：忽略换行等非字母表字符。
 * @param {Buffer} bytes - 原始字节。
 * @returns {Buffer} 解码后的字节。
 */
export function decodeBase64(bytes) {
  return Buffer.from(bytes.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
}

/**
 * 按声明的传输编码解出实体字节。
 * @param {Buffer} bytes - 原始字节。
 * @param {string | undefined} encoding - Content-Transfer-Encoding 的值。
 * @returns {Buffer} 解码后的字节。
 */
export function decodeTransferEncoding(bytes, encoding) {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'base64':
      return decodeBase64(bytes)
    case 'quoted-printable':
      return decodeQuotedPrintable(bytes)
    default:
      return bytes
  }
}

/**
 * 拆出一段「信头 + 空行 + 正文」，并展开折行的信头。
 *
 * 既能处理完整邮件，也能处理 multipart 里各段的段头；没有空行时（例如只取了
 * `BODY[HEADER]`）整段都当信头，正文为空。
 * @param {Buffer} buffer - 完整邮件或某个 MIME 段的字节。
 * @returns {{ headers: Map<string, string>, bodyOffset: number }} 小写信头名到解码值的映射，以及正文起点。
 */
export function parseHeaderBlock(buffer) {
  const text = buffer.toString('latin1')
  let separator = text.indexOf(`${CRLF}${CRLF}`)
  let separatorLength = 4
  if (separator === -1) {
    separator = text.indexOf(`${LF}${LF}`)
    separatorLength = 2
  }
  const headerText = separator === -1 ? text : text.slice(0, separator)
  const bodyOffset = separator === -1 ? buffer.length : separator + separatorLength

  /** @type {Map<string, string>} */
  const headers = new Map()
  /** @type {string | null} */
  let current = null
  for (const rawLine of headerText.split(/\r?\n/)) {
    if (/^[ \t]/.test(rawLine) && current !== null) {
      headers.set(current, `${headers.get(current)} ${rawLine.trim()}`)
      continue
    }
    const colon = rawLine.indexOf(':')
    if (colon === -1) continue
    const name = rawLine.slice(0, colon).trim().toLowerCase()
    if (name === '') continue
    headers.set(name, rawLine.slice(colon + 1).trim())
    current = name
  }
  return { headers, bodyOffset }
}

/**
 * 取一个信头的解码值。
 * @param {Map<string, string>} headers - 信头映射。
 * @param {string} name - 小写信头名。
 * @returns {string} 解码后的值；不存在时为空串。
 */
export function headerValue(headers, name) {
  return decodeWords(headers.get(name) ?? '')
}

/**
 * 解析 Content-Type 一类的结构化信头参数。
 * @param {string | undefined} value - 信头原值，例如 `multipart/mixed; boundary="x"`。
 * @returns {{ type: string, params: Record<string, string> }} 小写的主类型与参数表。
 */
export function parseContentType(value) {
  const text = (value ?? '').trim()
  const semicolon = text.indexOf(';')
  const type = (semicolon === -1 ? text : text.slice(0, semicolon)).trim().toLowerCase()
  /** @type {Record<string, string>} */
  const params = {}
  const rest = semicolon === -1 ? '' : text.slice(semicolon)
  const pattern = /;\s*([^=;\s]+)\s*=\s*(?:"([^"]*)"|([^;\s]*))/g
  for (const match of rest.matchAll(pattern)) {
    params[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').trim()
  }
  return { type, params }
}

/**
 * 从信头值里取出第一个邮箱地址。
 * @param {string | undefined} value - 例如 `张三 <a@b.com>, c@d.com`。
 * @returns {string | null} 小写化的裸地址。
 */
export function firstAddress(value) {
  const text = decodeWords(value ?? '').replace(/\([^)]*\)/g, ' ')
  const angled = /<([^<>@\s]+@[^<>\s]+)>/.exec(text)
  const candidate = angled?.[1] ?? /([^\s<>,;:"]+@[^\s<>,;:"]+)/.exec(text)?.[1]
  if (candidate === undefined) return null
  return candidate.replace(/^mailto:/i, '').replace(/[.,;:]+$/, '').toLowerCase()
}

/**
 * 按 MIME 边界切出各段原始字节。
 * @param {Buffer} body - multipart 的正文部分。
 * @param {string} boundary - Content-Type 里的 boundary 参数。
 * @returns {Buffer[]} 各段字节（含段头）。
 */
export function splitMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1')
  /** @type {Buffer[]} */
  const parts = []
  let index = body.indexOf(delimiter)
  if (index === -1) return parts
  index += delimiter.length
  while (index < body.length) {
    const lineEnd = body.indexOf(Buffer.from(CRLF, 'latin1'), index)
    if (lineEnd === -1) break
    if (body.subarray(index, lineEnd).toString('latin1').trim() === '--') break
    const start = lineEnd + 2
    const next = body.indexOf(delimiter, start)
    if (next === -1) {
      parts.push(body.subarray(start))
      break
    }
    let end = next
    if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2
    parts.push(body.subarray(start, end))
    index = next + delimiter.length
  }
  return parts
}

/** HTML 实体表：邮件里最常见的那些。 */
const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
}

/**
 * 把 HTML 粗加工成文本：去掉脚本样式、块级标签转换行、剥标签、解实体。
 * @param {string} html - HTML 源码。
 * @returns {string} 纯文本。
 */
export function htmlToText(html) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, entity) => {
      if (entity.startsWith('#')) {
        const code = entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
        return Number.isSafeInteger(code) && code > 0 ? String.fromCodePoint(code) : match
      }
      return ENTITIES[entity.toLowerCase()] ?? match
    })
}

/**
 * 递归取出一个 MIME 实体的文本内容。
 *
 * 优先 `text/plain`，其次 `text/html`；附件（Content-Disposition: attachment）
 * 一律跳过。返回空串表示这一段没有可用文本。
 * @param {Map<string, string>} headers - 该实体的信头。
 * @param {Buffer} body - 该实体的正文字节。
 * @returns {string} 解码后的纯文本。
 */
export function extractText(headers, body) {
  const { type, params } = parseContentType(headers.get('content-type'))
  const disposition = (headers.get('content-disposition') ?? '').toLowerCase()
  if (disposition.startsWith('attachment')) return ''

  if (type.startsWith('multipart/')) {
    if (params.boundary === undefined || params.boundary === '') return ''
    const alternatives = []
    for (const part of splitMultipart(body, params.boundary)) {
      const { headers: partHeaders, bodyOffset } = parseHeaderBlock(part)
      const partType = parseContentType(partHeaders.get('content-type')).type
      const text = extractText(partHeaders, part.subarray(bodyOffset))
      if (text.trim() === '') continue
      alternatives.push({ type: partType, text })
    }
    // 有 text/plain 就用它；没有才退到 HTML（multipart/alternative 里两者都有）。
    const plain = alternatives.find((entry) => entry.type === 'text/plain' || entry.type === '')
    if (plain !== undefined) return plain.text
    return alternatives.map((entry) => entry.text).join('\n')
  }

  const decoded = decodeCharset(
    decodeTransferEncoding(body, headers.get('content-transfer-encoding')),
    params.charset,
  ).replace(/\r\n?/g, '\n')
  if (type === 'text/html') return htmlToText(decoded)
  if (type === '' || type.startsWith('text/')) return decoded
  return ''
}

/**
 * 解析一封完整邮件（信头 + 空行 + 正文）。
 * @param {Buffer} raw - 完整邮件字节。
 * @returns {{ headers: Map<string, string>, text: string }} 信头与取出的正文文本。
 */
export function parseMessage(raw) {
  const { headers, bodyOffset } = parseHeaderBlock(raw)
  return { headers, text: extractText(headers, raw.subarray(bodyOffset)) }
}

/**
 * 去掉回复里的引用历史，只留这次新写的内容。
 *
 * 处理常见的三种引用形态：`>` 引文、`在……写道：`/`On ... wrote:` 起始块、
 * Outlook 的 `-----原始邮件-----` 分隔线。切不掉也不影响可用性，只是提示词长一点。
 * @param {string} text - 原始正文字本。
 * @returns {string} 去掉引用后的正文。
 */
export function stripQuotedText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept = []
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue
    if (/^\s*(在.{0,80}(写道|寫道)|On .{0,120}wrote:)/.test(line)) break
    if (/^\s*-{2,}\s*(原始邮件|原始郵件|Original Message|转发邮件)\s*-{2,}/i.test(line)) break
    if (/^\s*_{5,}\s*$/.test(line)) break
    if (/^\s*(发件人|寄件者|From)\s*[:：]\s/.test(line) && kept.length > 0) break
    kept.push(line)
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
