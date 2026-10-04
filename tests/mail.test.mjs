/**
 * 邮件解析的离线用例：不联网、不发信、不读真实邮箱。
 *
 * 覆盖信头展开与 RFC 2047 解码、multipart 切分、传输编码、字符集、附件跳过、
 * 引用历史剥离，以及完整邮件解析。所有样本都是就地构造的字节，形态对齐真实
 * QQ 邮件（`text/plain; charset=UTF-8` + base64 正文、QQ 会重写 Message-ID）。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeWords,
  decodeQuotedPrintable,
  extractText,
  firstAddress,
  headerValue,
  htmlToText,
  parseContentType,
  parseHeaderBlock,
  parseMessage,
  splitMultipart,
  stripQuotedText,
} from '../mail.mjs'

/** 把若干行拼成 CRLF 结尾的邮件字节。 */
const lines = (...rows) => Buffer.from(rows.join('\r\n'), 'utf8')

test('RFC 2047：B 与 Q 编码字都能解回原文', () => {
  assert.equal(decodeWords('=?UTF-8?B?5Zue5aSN?='), '回复')
  assert.equal(decodeWords('=?UTF-8?Q?DSH_=E4=BB=BB=E5=8A=A1?='), 'DSH 任务')
})

test('RFC 2047：只解被编码的字，纯文本原样保留', () => {
  assert.equal(decodeWords('Re: DSH 任务完成'), 'Re: DSH 任务完成')
  assert.equal(decodeWords('Re: =?UTF-8?B?5Zue5aSN?='), 'Re: 回复')
})

test('RFC 2047：相邻编码字之间用于折行的空白要丢掉', () => {
  const subject = '=?UTF-8?B?RFNIIOS7u+WKoeWujOaIkA==?=\r\n =?UTF-8?B?77yI5rWL6K+V77yJ?='
  assert.equal(decodeWords(subject), 'DSH 任务完成（测试）')
})

test('RFC 2047：gb2312 / GBK 别名都按 gb18030 解', () => {
  // 0xd6d0 0xcec4 0xd6f7 0xcce2 就是「中文主题」的 GBK 字节。
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd6, 0xf7, 0xcc, 0xe2]).toString('base64')
  assert.equal(decodeWords(`=?gb2312?B?${gbk}?=`), '中文主题')
  assert.equal(decodeWords(`=?GBK?B?${gbk}?=`), '中文主题')
})

test('信头：没有 RFC 2047 编码的裸 UTF-8 主题也要能读出来', () => {
  // 信头字节是按 latin1 读的，裸 8bit 段要按 UTF-8 再解释一次。
  const raw = lines('Subject: Re: DSH 任务完成｜改好了', 'From: me@qq.com', '', '')
  const { headers } = parseHeaderBlock(raw)
  assert.equal(headerValue(headers, 'subject'), 'Re: DSH 任务完成｜改好了')
})

test('信头：编码字与裸 UTF-8 混在一行时两段都要对', () => {
  const raw = lines('Subject: Re: =?UTF-8?B?5Lu75Yqh?= 任务完成', '', '')
  const { headers } = parseHeaderBlock(raw)
  assert.equal(headerValue(headers, 'subject'), 'Re: 任务 任务完成')
})

test('quoted-printable：还原字节并丢掉软换行', () => {
  const decoded = decodeQuotedPrintable(Buffer.from('DSH=20=E4=BB=BB=E5=8A=A1=\r\n=E5=AE=8C=E6=88=90', 'latin1'))
  assert.equal(decoded.toString('utf8'), 'DSH 任务完成')
})

test('Content-Type：主类型与参数都要能解析，含第一个参数', () => {
  const parsed = parseContentType('multipart/mixed; boundary="--=_x"; charset=UTF-8')
  assert.equal(parsed.type, 'multipart/mixed')
  assert.equal(parsed.params.boundary, '--=_x')
  assert.equal(parsed.params.charset, 'UTF-8')
  assert.deepEqual(parseContentType('text/plain').params, {})
})

test('信头：折行要展开，大小写不敏感', () => {
  const { headers } = parseHeaderBlock(lines('Subject: =?utf-8?B?5Zue5aSN?=', '\tDSH', 'X-Long: a', ' b'))
  assert.equal(headerValue(headers, 'subject'), '回复 DSH')
  assert.equal(headerValue(headers, 'x-long'), 'a b')
})

test('信头：没有空行时（只取了 BODY[HEADER]）整段当信头', () => {
  const { headers, bodyOffset } = parseHeaderBlock(lines('From: a@b.com', 'Subject: x'))
  assert.equal(firstAddress(headers.get('from')), 'a@b.com')
  assert.equal(bodyOffset, Buffer.byteLength('From: a@b.com\r\nSubject: x'))
})

test('地址：带显示名、带引号、带 mailto 前缀都能取出裸地址', () => {
  assert.equal(firstAddress('=?utf-8?B?5byg5LiJ?= <Zhang@Example.COM>'), 'zhang@example.com')
  assert.equal(firstAddress('"Li, Si" <li@example.com>, other@example.com'), 'li@example.com')
  assert.equal(firstAddress('mailto:someone@qq.com'), 'someone@qq.com')
  assert.equal(firstAddress('not an address'), null)
})

test('正文：quoted-printable 的 text/plain（真实 QQ 邮件的另一种形态）', () => {
  const headers = new Map([
    ['content-type', 'text/plain; charset=utf-8'],
    ['content-transfer-encoding', 'quoted-printable'],
  ])
  assert.equal(extractText(headers, Buffer.from('DSH=20=E4=BB=BB=E5=8A=A1', 'latin1')), 'DSH 任务')
})

test('正文：base64 的 text/plain（本插件自己发的通知就是这种）', () => {
  const headers = new Map([
    ['content-type', 'text/plain; charset=UTF-8'],
    ['content-transfer-encoding', 'base64'],
  ])
  const body = Buffer.from('## 标题\n\n正文内容', 'utf8').toString('base64')
  assert.equal(extractText(headers, Buffer.from(body, 'latin1')), '## 标题\n\n正文内容')
})

test('正文：CRLF 归一化成 LF', () => {
  const headers = new Map([['content-type', 'text/plain; charset=utf-8']])
  assert.equal(extractText(headers, Buffer.from('a\r\nb', 'utf8')), 'a\nb')
})

test('multipart/alternative：优先 text/plain，而不是 HTML', () => {
  const body = lines(
    '--BND',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '纯文本版本 DSH',
    '--BND',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>HTML 版本 <b>DSH</b></p>',
    '--BND--',
    '',
  )
  const headers = new Map([['content-type', 'multipart/alternative; boundary="BND"']])
  assert.equal(extractText(headers, body).trim(), '纯文本版本 DSH')
})

test('multipart：只有 HTML 时转成文本', () => {
  const body = lines('--B', 'Content-Type: text/html; charset=utf-8', '', '<div>你好<br>DSH&nbsp;任务</div>', '--B--', '')
  const headers = new Map([['content-type', 'multipart/mixed; boundary=B']])
  assert.equal(extractText(headers, body).trim(), '你好\nDSH 任务')
})

test('multipart：附件段被跳过', () => {
  const body = lines(
    '--B',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '正文在这里',
    '--B',
    'Content-Type: application/pdf; name="a.pdf"',
    'Content-Disposition: attachment; filename="a.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--B--',
    '',
  )
  const headers = new Map([['content-type', 'multipart/mixed; boundary=B']])
  assert.equal(extractText(headers, body).trim(), '正文在这里')
})

test('splitMultipart：忽略前言与结束标记', () => {
  const body = lines('这是前言', '--B', 'x', '--B', 'y', '--B--', '这是结尾')
  const parts = splitMultipart(body, 'B')
  assert.equal(parts.length, 2)
  assert.equal(parts[0].toString('utf8'), 'x')
  assert.equal(parts[1].toString('utf8'), 'y')
})

test('HTML：块级标签转换行、常见实体解码、脚本样式剥掉', () => {
  const html = '<style>p{color:red}</style><p>A&amp;B</p><p>&#65;&nbsp;&hellip;</p><script>x()</script>'
  assert.equal(htmlToText(html).trim(), 'A&B\nA …')
})

test('剥离引用历史：> 引文、写道块、Outlook 分隔线', () => {
  assert.equal(
    stripQuotedText(['执行一下 DSH 检查', '', '在 2026年10月1日 10:07，moodlee@qq.com 写道：', '> 上一封通知', '> 更多引用'].join('\n')),
    '执行一下 DSH 检查',
  )
  assert.equal(stripQuotedText(['好的', '> 引用一行', '> 引用两行'].join('\n')), '好的')
  assert.equal(
    stripQuotedText(['请复检', '-----原始邮件-----', '主题: DSH 任务完成'].join('\n')),
    '请复检',
  )
  assert.equal(stripQuotedText('正文里提到 5 > 3 这种比较不该被当成引文'), '正文里提到 5 > 3 这种比较不该被当成引文')
})

test('完整邮件：信头折行 + 主题解码 + 正文一次到位', () => {
  const raw = lines(
    'From: =?utf-8?B?5byg5LiJ?= <zhang@example.com>',
    'Subject: =?utf-8?B?5Zue5aSN?=',
    '\tDSH',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '正文第一行',
    '正文第二行',
  )
  const parsed = parseMessage(raw)
  assert.equal(headerValue(parsed.headers, 'subject'), '回复 DSH')
  assert.equal(firstAddress(parsed.headers.get('from')), 'zhang@example.com')
  assert.equal(parsed.text.trim(), '正文第一行\n正文第二行')
})
