/**
 * 组装一封 RFC 5322 纯文本邮件。
 *
 * 主题里的非 ASCII 文字按 RFC 2047 逐字符切分编码，正文整体用 base64 并折成
 * 76 列：这样中文、超长行、以点号开头的行都不会被 SMTP 传输或收信端破坏。
 *
 * @module dsh-mail-notify/mime
 */

import { randomUUID } from 'node:crypto'

const CRLF = '\r\n'

/** 单个 encoded-word 里允许的原文最大字节数（base64 后 40 字符，留足余量）。 */
const WORD_BYTE_BUDGET = 30

/** base64 正文的折行宽度。 */
const BASE64_LINE_LENGTH = 76

/**
 * 拒绝会向邮件里注入额外信头的换行符。
 * @param {string} value - 将要写入信头的文本。
 * @param {string} field - 出错信息里显示的字段名。
 * @returns {string} 原值，便于调用处直接使用。
 * @throws {TypeError} 值里含有 CR 或 LF 时。
 */
export function assertHeaderSafe(value, field) {
  if (/[\r\n]/.test(value)) throw new TypeError(`dsh-mail-notify: ${field} 不能包含换行符`)
  return value
}

/**
 * 把主题编码成合法信头值：纯 ASCII 且不长的原样返回，否则切成若干 encoded-word。
 * @param {string} subject - 原始主题。
 * @returns {string} 可直接写入 `Subject:` 的值（多段之间是 CRLF + 空格）。
 * @throws {TypeError} 主题含有换行符时。
 */
export function encodeSubject(subject) {
  assertHeaderSafe(subject, 'subject')
  if (/^[\x20-\x7e]*$/.test(subject) && subject.length <= 60) return subject

  const words = []
  let current = ''
  let currentBytes = 0
  for (const character of subject) {
    const size = Buffer.byteLength(character, 'utf8')
    if (currentBytes + size > WORD_BYTE_BUDGET && current !== '') {
      words.push(current)
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += size
  }
  if (current !== '') words.push(current)

  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(`${CRLF} `)
}

/**
 * 把正文编码成折行的 base64 内容。
 * @param {string} body - 原始正文（UTF-8）。
 * @returns {string} 76 列折行的 base64 文本，行尾为 CRLF。
 */
export function encodeBodyBase64(body) {
  const encoded = Buffer.from(body, 'utf8').toString('base64')
  const lines = []
  for (let offset = 0; offset < encoded.length; offset += BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(offset, offset + BASE64_LINE_LENGTH))
  }
  return lines.join(CRLF)
}

/**
 * 组装完整邮件：信头、空行、base64 正文，全部使用 CRLF 行尾。
 * @param {object} options - 信封与内容。
 * @param {string} options.from - 发件地址，同时决定 Message-ID 的域名。
 * @param {string} options.to - 收件地址。
 * @param {string} options.subject - 主题。
 * @param {string} options.body - 正文。
 * @returns {string} 交给 SMTP `DATA` 的完整文本。
 */
export function buildMessage({ from, to, subject, body }) {
  assertHeaderSafe(from, 'from')
  assertHeaderSafe(to, 'to')
  const domain = from.slice(from.indexOf('@') + 1)
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  return `${headers.join(CRLF)}${CRLF}${CRLF}${encodeBodyBase64(body)}${CRLF}`
}
