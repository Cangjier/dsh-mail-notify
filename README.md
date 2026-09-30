# dsh-mail-notify

DeepSeek Harness 插件：agent **每结束一轮回答**（会话日志里的 `turn/end`）就发一封通知邮件，
正文是该轮的回答文本。

- **零依赖**：SMTP 客户端（`smtp.mjs`）和邮件组装（`mime.mjs`）只用 Node 内置模块，不需要 `pnpm add` 任何东西。
- **零构建**：纯 ESM `.mjs`，直接就是运行时代码。
- **默认关闭**：装好、重启之后也是纯惰性的——不注册监听器、不连网络、不发信。要把 `enabled` 改成 `true` 才会工作。
- **收件人任意域名**：发信服务器只由**发件**账号决定；收件人写 `qq.com`、`163.com`、`gmail.com` 都一样能收。

## 装之前先看：它为什么不会拖垮 dsh

有两条硬保证，都有测试兜着（`node --test`）：

1. **没启用就不碰任何东西。** `enabled: false` 时 `apply` 在注册任何监听器之前就返回，
   所以既不会响应 `session/event`，也没有任何网络或文件动作。
2. **配置写错也不抛回加载器。** 缺 `to`、地址非法、发件域名认不出、config 整个是 `undefined`
   这四种情况都只写一条 `error` 日志然后保持惰性，`apply` 不会抛异常。

测试里对应的 5 个用例就是这四条边界加 `enabled: false`。想自己核实：

```powershell
node --test
```

### 为什么这次用 bundle，而不是散装文件

第一版把 `.mjs` 直接放在 `profiles/desktop/plugins/` 下，再往 profile 的 `cordis.patch.yml`
里 `insert` 一行，结果运行中的 dsh 卡死，只能重启恢复。
profile 内的相对路径插件要靠 HMR 的运行时 reconcile 去 `import` 一个新模块；
而 bundle 方式是**启动时**解析的（`dsh.profile.bundles`），是这台机器上 `xl` 插件已经验证过的路径。
所以现在代码放在 profile 目录**之外**，走 bundle。

## 安装（分三步，每步都可回退）

### 第 1 步：只加依赖，不加 bundle —— 风险为零

在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dependencies` 里加一行：

```jsonc
"dependencies": {
  "xl": "link:C:/Users/Admin/Documents/GitHub/xl",
  "dsh-mail-notify": "link:C:/Users/Admin/Documents/GitHub/dsh-mail-notify"   // 新增
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
确认 dsh 照常启动。

### 第 3 步：启用

把本包 `cordis.patch.yml` 里的 `enabled: false` 改成 `true`，重启即可。

也可以在 profile 自己的 `cordis.patch.yml` 里覆盖，但注意 patch 是**整体替换** config，
不是深合并，字段要写全：

```yaml
- id: mail-notify
  name: 'dsh-mail-notify'
  config:
    enabled: true
    smtp: { user: moodlee@qq.com, from: moodlee@qq.com }
    to: [moodlee@qq.com]
    # …其余字段按下面的表补全
```

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

配置写在本包的 `cordis.patch.yml` 里。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | **`false`** | 本包出厂就是关的。`false` 时不注册监听器、不发信 |
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
node --test          # 10 个用例：惰性保证 + 正文/主题/子代理行为，不联网不发信
node selftest.mjs    # 真的发一封固定主题的邮件，验证网络、TLS、授权码、中文编码
```

## 排查

- **什么都没发生**：先看 `enabled` 是不是还是出厂的 `false`；再看 `dryRun` 是不是 `true`。
  发送失败的原因以 `mail-notify:` 前缀写进 dsh 日志。
- **「配置无效，插件保持不发送状态」**：后面跟着具体是哪个字段，改完重启即可。
- **「没有读到 SMTP 授权码」**：文件为空或路径不对，注意用授权码而不是登录密码。
- **`535 Authentication failed`**：授权码过期或被重置，重新生成。
- **「不支持 STARTTLS」**：`secure: false` 且服务器没有 STARTTLS 时会直接中止，而不是明文发授权码；改用 465。
