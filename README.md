# dsh-mail-notify

DeepSeek Harness 插件：agent **每结束一轮回答**（会话日志里的 `turn/end`）就发一封通知邮件，
正文是该轮的回答文本。

- **零依赖**：SMTP 客户端（`smtp.mjs`）和邮件组装（`mime.mjs`）只用 Node 内置模块，不需要 `pnpm add` 任何东西。
- **零构建**：纯 ESM `.mjs`，直接就是运行时代码。
- **默认关闭**：装好、重启之后也是纯惰性的——不注册监听器、不连网络、不发信。
- **自带配置引导**：注册了一个模型可见的 `mail_notify` 工具，可以直接让 Agent 帮你配好并试发。
- **收件人任意域名**：发信服务器只由**发件**账号决定；收件人写 `qq.com`、`163.com`、`gmail.com` 都一样能收。

## 让 Agent 帮你配

插件注册了 `mail_notify` 工具，三个 action：

| action | 作用 |
|---|---|
| `status` | 报告当前到底会不会发信：SMTP 端点、发件账号、收件人、授权码从哪儿读、有没有读到 |
| `guide` | 给出配置文件的确切路径，以及一段可直接粘贴的 YAML |
| `test` | **立刻真发一封测试邮件**（可用 `to` 临时指定别的收件人），验证网络/TLS/授权码/中文编码 |

所以装好之后你只要说「帮我把邮件通知配好」，或者「为什么没收到邮件」，Agent 就能查到原因。
配置写错时这个工具**照样注册**——那时它正是把错因讲清楚的唯一入口。

## 装之前先看：它为什么不会拖垮 dsh

三条硬保证，都有测试兜着（`node --test`，15 个用例）：

1. **没启用就不碰任何东西。** `enabled: false` 时 `apply` 在注册 `session/event` 监听器之前就返回，
   不响应任何会话事件，也没有网络或文件动作。
2. **配置写错也不抛回加载器。** 缺 `to`、地址非法、发件域名认不出、config 整个是 `undefined`
   这四种情况都只写 `error` 日志然后保持惰性。
3. **引导工具注册失败不影响发信。** 它包在单独的 `try` 里——附加能力不能连累主功能。

### 为什么用 bundle，而不是散装文件

第一版把 `.mjs` 直接放在 `profiles/desktop/plugins/` 下，再往 profile 的 `cordis.patch.yml`
里 `insert` 一行，结果运行中的 dsh 卡死，只能重启恢复。
profile 内的相对路径插件要靠 HMR 的运行时 reconcile 去 `import` 一个新模块；
而 bundle 方式是**启动时**解析的（`dsh.profile.bundles`），是 `xl` 插件已经验证过的路径。
所以现在代码放在 profile 目录**之外**，走 bundle。

## 安装（分三步，每步都可回退）

### 第 1 步：只加依赖，不加 bundle —— 风险为零

在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dependencies` 里加一行：

```jsonc
"dependencies": {
  "dsh-mail-notify": "link:C:/Users/you/Documents/GitHub/dsh-mail-notify"   // 换成你自己的绝对路径
}
```

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install
```

这一步**不要**动 `dsh.profile.bundles`。没有任何 bundle 或 patch 引用这个包，
加载器就不会 import 它，启动树和现在完全一样。确认 dsh 照常启动，再进第 2 步。

### 第 2 步：加进 bundles

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "xl",
      "dsh-mail-notify"                                                         // 新增
    ]
  }
}
```

**完全退出再启动** dsh（bundle 解析变更本来就要重启，这是 dsh 的设计）。
此时插件已挂载，但 `cordis.patch.yml` 里 `enabled: false`，所以仍然不发信。
可以先用 `mail_notify` 的 `guide` / `test` 把配置弄好再来这一步之后的启用。

### 第 3 步：填个人配置并启用

本包的 `cordis.patch.yml` 里只有**占位地址**（`you@example.com`），真实邮箱写在
profile 自己的覆盖层 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里，
这样公开仓库不会留下你的地址：

```yaml
- id: mail-notify
  name: 'dsh-mail-notify'
  config:
    enabled: true
    smtp:
      user: 你的账号@qq.com
      from: 你的账号@qq.com
    to:
      - 收件人@qq.com
```

patch 是**整体替换** config，不是深合并，所以这段会覆盖本包的默认值——从 `enabled` 开始写全。
`host` / `port` / `secure` 会按发件域名自动推断，不必手写；其余字段都有代码默认值。

> `example.com` 故意不在内置端点表里：如果只把 `enabled` 改成 `true` 而不填真实地址，
> 会得到一条明确的配置错误日志，而不是静默失败。

### 回退

把 `dsh-mail-notify` 从 `dsh.profile.bundles` 里删掉再重启，就回到装之前的状态。
或者只把 `enabled` 改回 `false`。

## 授权码

不写进任何配置文件。按 内联 → 环境变量 → 文件 的顺序找：

1. `config.authCode`（不推荐）
2. `config.authCodeEnv` 指的环境变量，默认 `QQ_SMTP_AUTH_CODE`
3. `config.authCodeFile` 指的文件，默认就是本目录下的 `secret.txt`

`secret.txt` 每次发信都重新读，所以补进去之后**不用重启**。它已在 `.gitignore` 里，不要提交。
QQ 邮箱要用「设置 → 账户 → POP3/IMAP/SMTP 服务」里生成的**授权码**，不是登录密码。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | **`false`** | 出厂就是关的。`false` 时不注册监听器、不发信 |
| `smtp.user` | 必填 | SMTP 登录账号（发件邮箱） |
| `smtp.from` | 同 `user` | 信头里的发件地址 |
| `smtp.host` | 按发件域名推断 | 认不出的域名必须手填，否则只记错误日志、保持不发信 |
| `smtp.port` | 推断值 | 隐式 TLS 默认 465，STARTTLS 默认 587 |
| `smtp.secure` | 推断值 | `true` = 465 隐式 TLS，`false` = EHLO 后 STARTTLS |
| `to` | 必填 | 收件人数组；每人单独投递，互相看不到地址 |
| `subject` | `DSH 任务完成` | 非正常结束时自动补后缀，如「（已取消）」「（出错）」 |
| `authCode` | 无 | 内联授权码，不推荐 |
| `authCodeEnv` | `QQ_SMTP_AUTH_CODE` | 授权码环境变量名 |
| `authCodeFile` | 本目录 `secret.txt` | 授权码文件路径，相对路径以本目录为基准 |
| `skipSubagentSessions` | `true` | 跳过子代理会话，避免一次任务刷出一堆邮件 |
| `mergeSteps` | `false` | `false` 只发最后一条助手消息；`true` 拼接整轮所有步骤 |
| `maxBodyChars` | `20000` | 正文超长时截断并注明原长度 |
| `includeSessionInfo` | `false` | 正文末尾附会话 id、工作目录、结束原因、时间 |
| `dryRun` | `false` | `true` 时只记日志不连服务器，用于试配置 |
| `timeoutMs` | `30000` | 单步读写超时 |

内置端点：`qq.com` / `vip.qq.com` / `foxmail.com` → `smtp.qq.com:465`；
`163.com` / `126.com` / `yeah.net` → 各自 `:465`；`sina.com` / `139.com` / `aliyun.com` → 各自 `:465`；
`gmail.com` → `smtp.gmail.com:465`；`outlook.com` / `hotmail.com` / `live.com` → `smtp.office365.com:587` STARTTLS；
`icloud.com` / `me.com` → `smtp.mail.me.com:587` STARTTLS。其他域名请显式写全 `smtp.host`/`port`/`secure`。

## 自检与测试

```powershell
node --test          # 15 个用例：惰性保证 + 引导工具 + 正文/主题/子代理行为，不联网不发信
node selftest.mjs    # 真的发一封固定主题的邮件，验证网络、TLS、授权码、中文编码
```

## 排查

- **什么都没发生**：让 Agent 调 `mail_notify` 的 `status`。多半是 `enabled` 还是 `false`，或 `dryRun` 是 `true`。
- **「配置无效，插件保持不发送状态」**：日志后面跟着具体是哪个字段；用 `mail_notify` 的 `guide` 拿改法。
- **「没有读到 SMTP 授权码」**：文件为空或路径不对，注意用授权码而不是登录密码。
- **`535 Authentication failed`**：授权码过期或被重置，重新生成。
- **「不支持 STARTTLS」**：`secure: false` 且服务器没有 STARTTLS 时会直接中止，而不是明文发授权码；改用 465。
