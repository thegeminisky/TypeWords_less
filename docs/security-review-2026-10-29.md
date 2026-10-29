# TypeWords 安全审查报告

> 审查日期：2026-10-29 · 范围：`deploy/server.mjs`（门禁/同步/静态服务）、前端入口与数据流、部署与运行环境（阿里云 47.109.133.115）
> 方法：源码审计 + 本地黑盒测试（路径穿越/越权/重放）+ 线上状态取证（端口/权限/日志/响应头）+ 依赖审计（pnpm audit）

## 一、架构安全概览

```
公网 ──HTTP(8300)──> node server.mjs（agent007，非 root）
                      ├─ 门禁：TOTP（RFC 6238，30s）→ 30 天会话 Cookie（HttpOnly/SameSite=Lax）
                      ├─ 同步 API：/api/sync/*（需登录）
                      └─ 静态文件：.output/public + SPA 回退
数据：data/{gate.json, sessions.json, state.json}（服务器本地 JSON）
```

## 二、风险清单

### 🔴 严重

#### R1. 全站公网明文 HTTP，无任何 TLS

- **证据**：`https://47.109.133.115:8300` 连接失败（https=000）；8300 绑定 `0.0.0.0` 且公网可达；响应无 HSTS。
- **影响**：会话 Cookie（30 天有效）、TOTP 动态码、全部学习数据明文传输。同 Wi-Fi / 中间路径的攻击者可直接窃取 Cookie 完全接管（无需破解 TOTP），并可篡改返回的 JS 代码。
- **建议**（按优先级）：
  1. 绑定域名 + Caddy/nginx 反代 + Let's Encrypt 自动续期（推荐 Caddy，两行配置）；
  2. 或个人使用场景改走 WireGuard/Tailscale 私网，8300 从安全组撤掉公网暴露；
  3. 过渡措施：阿里云安全组将 8300 的来源限制为常用出口 IP。

### 🟠 高

#### R2. 存储型 XSS：`v-html` 渲染未转义的词典内容

- **证据**：全站仅一处 `v-html`（`SentenceHightLightWord.vue:28`），数据源 `buildHighlightedHtml()`（`wordLookup.ts:78`）对 `text` 做正则包 span 后**原样返回，无 HTML 转义**；`text` 来自词典内容（自建词典、同步 API 写入的 `state.json`）。
- **影响**：词典内容中植入 `<img src=x onerror=...>` 之类载荷，在练习页渲染即执行；配合登录态可调用 `/api/sync/reset` 一键清空服务端数据。触发前提是内容被写入（自己误贴/他人曾登录过）。
- **建议**：`buildHighlightedHtml` 先对 `text` 做 HTML 实体转义（`& < > " '`），再执行高亮替换。约 3 行改动，强烈建议尽快修。
- 注：`getWordRegexes` 已用 `escapeRegExp`，正则注入与 ReDoS 风险不存在 ✓。

#### R3. 二维码展示窗口的竞争绑定

- **证据**：`GET /api/auth/gate` 在 `reveal=true` 期间对**任何访客**返回 TOTP 密钥与 otpauth URI；该状态持续到「首次成功登录」，无时效上限。
- **影响**：部署/重置后如果绑定不及时，任何扫到该页的人可先绑定验证器获得永久访问权。
- **建议**：`reveal` 加时效（如生成后 10 分钟自动隐藏，`loadGate` 时判断 `createdAt`）；部署/重置后尽快完成绑定。

#### R4. 依赖链 135 个已知漏洞（3 critical / 59 high）

- **证据**：`pnpm audit --prod`（官方源）。critical：`simple-git`、`shell-quote`、`@simple-git/argv-parser`；high 与本应用直接相关的：`axios <1.15.1`（直接依赖）、`node-forge <=1.4.0`（RSA 加密在用）、`vue-i18n/@intlify/* <11.4.14`（GHSA-8rc2-428q-7ww3）、`vite 7.3.6`、`sharp`。多数为 nuxt/vite 生态传递依赖，实际可利用面有限，但 axios / node-forge / vue-i18n 在运行路径上。
- **建议**：定向升级 `axios`、`vue-i18n`（≥11.4.14）、`node-forge`，随后 `pnpm up` 整体小版本升级；将 `pnpm audit --prod` 纳入发版前检查。

### 🟡 中

#### R5. `/api/sync/reset` 一键清空服务端数据，无二次防护

- **证据**：`handleApi` 中该接口仅需登录态即可清空 `state.json` 全部数据。
- **建议**：要求显式确认参数（如 `{confirm:'RESET'}`）+ 每日自动快照（`state.json.bak-YYYYMMDD`）。

#### R6. 缺失安全响应头

- **证据**：响应头仅有 `X-Content-Type-Options: nosniff`；无 CSP / X-Frame-Options / Referrer-Policy。
- **建议**：静态响应统一加 `Content-Security-Policy: frame-ancestors 'none'`（或 X-Frame-Options: DENY）、`Referrer-Policy: strict-origin-when-cross-origin`；上 HTTPS 后补 HSTS。

#### R7. 32MB 请求体上限 × 256MB 堆内存 → 低成本打崩服务

- **证据**：`MAX_BODY = 32MB`，`run.sh` 设 `--max-old-space-size=256`；8 个并发大请求即可 OOM；`/api/sync/*` 无速率限制。
- **建议**：词库 JSON 实际 <100KB，`MAX_BODY` 降到 5MB；upsert 加简单节流。

#### R8. TOTP 密钥永久留存于服务器日志

- **证据**：`logs/server.log` 含 otpauth URI 与手动密钥（本次审查实测 2 处），日志无轮转。
- **影响**：需要服务器读权限才可利用（此时已等于完全沦陷），属纵深防御问题。
- **建议**：日志轮转（logrotate）；绑定完成后可删除对应日志行。

#### R9. 服务无开机自启 / 进程守护

- **证据**：tmux 手动拉起，机器重启后服务不会自动恢复（可用性，且异常退出无告警）。
- **建议**：systemd user unit（`systemctl --user enable typewords`）或 crontab `@reboot`。

### 🟢 低

- **R10** `data/*.json` 权限 664 → 建议 600（当前 home 目录 700，风险有限）。
- **R11** 会话 30 天无轮换、无「全设备下线」；Cookie 无 `Secure` 标志（上 HTTPS 后应加）。
- **R12** `run.sh` 残留已废弃的 `GATE_KEY=11111111`（误导性默认值，服务端已不读取；git 历史中存在该默认值，已失效无需重写历史）。
- **R13** 服务器上 7000/8201/22 端口同样公网监听（非本项目，7000 用途待确认）。
- **R14** 百度翻译 md5 签名为协议要求（凭据来自用户自己的设置项），RSA-OAEP-SHA1（node-forge）用于口令加密字段，均可接受。

## 三、做得好的 ✅

- TOTP 实现符合标准（审查中用独立实现复算比对一致），有 ±1 步时钟容差、同窗口防重放、失败限速（10 分钟 8 次锁 1 分钟）。
- Cookie：HttpOnly + SameSite=Lax（跨站 POST 不携带 → CSRF 基本免疫）；token 为 32 字节 CSPRNG。
- 静态服务路径穿越**实测全部拦截**（`../`、编码绕过、`%00`、反斜杠、跨目录均 404/回退 SPA）；NUL 已过滤。
- API 未知路径先过鉴权（401，不泄漏接口存在性）；`MAX_BODY` 有上限；静态响应带 nosniff。
- node 进程非 root 运行；home 目录 700；敏感数据目录不入 git（`.gitignore` 覆盖 `deploy/data/`、`shots/`、`.env`）。
- 前端注入面小：全站仅 1 处 `v-html`；门禁页 `noindex`。

## 三·五、修复记录（2026-10-29，除 R1 外全部完成）

| 项 | 修复内容 | 验证 |
|---|---|---|
| R2 XSS | `buildHighlightedHtml` 对 text 先做 HTML 实体转义再高亮 | 注入 `<img onerror>` 输出已被转义，高亮 span 正常 |
| R3 QR 时效 | reveal 加 10 分钟时效（`revealUntil`），超时自动隐藏；**CLI reset-otp 同步带上该字段**（曾漏导致二维码即隐，已修） | 伪造过期时间→隐藏；reset 后连续 GET 稳定可见 |
| R4 依赖 | axios 1.15.0→1.21.0、node-forge 1.3.1→1.4.2、vue-i18n→11.4.16；pnpm-workspace overrides 强制 @intlify 全链路 ≥11.4.16；audit 135→91（剩余多为 nuxt/vite 构建链传递依赖，部署产物为零依赖静态站，不构成运行时暴露；3 个 critical 均来自 @nuxt/devtools 构建期） | pnpm audit 复核 |
| R5 reset | `/api/sync/reset` 端点整体移除（前端 resetRemote 本就无调用方） | 登录态下 404 |
| R6 响应头 | X-Frame-Options: DENY、Referrer-Policy、CSP frame-ancestors 'none'、COOP: same-origin | 线上 curl 实测 4 个头齐全 |
| R7 DoS | MAX_BODY 32MB→5MB（超限优雅返回 400 而非断连）；/api/sync/* 120 次/分/IP、gate 查询 20 次/分/IP 限速 | 6MB 请求 → 400；正常 upsert 200 |
| R8 日志 | run.sh 启动时轮转：>10MB 归档，保留 5 份 | bash -n 通过 |
| R9 自启 | crontab `@reboot` 拉起 run.sh（服务器 crontab 已写入） | crontab -l 确认 |
| R10 权限 | gate.json/sessions.json 落盘后 chmod 600；服务器存量文件已改 | 线上 -rw------- |
| R12 run.sh | 移除废弃 GATE_KEY；**set 去掉 pipefail（dash 语义报错导致过一次启动失败）**；`.gitattributes` 强制 *.sh eol=lf（根治 CRLF） | bash -n + 线上启动成功 |

R1（HTTPS）：2026-10-29 起服务端默认改为**只监听 127.0.0.1**（run.sh HOST 与 server.mjs 默认值），
公网直连已不可达（connection refused），传输层风险随之消除；访问走 SSH 隧道
（`ssh -N -L 8300:127.0.0.1:8300 aliyun` 后浏览器开 http://127.0.0.1:8300），
后续如需公网使用再上域名 + Caddy 反代 + HTTPS。其余风险均已闭环。

## 四、修复优先级

| 优先级 | 事项 | 工作量 |
|---|---|---|
| P0 | R1 HTTPS（域名 + Caddy）或私网化；R2 XSS 转义 | 半小时 |
| P1 | R3 reveal 时效；R4 定向升级 axios/vue-i18n/node-forge；R5 reset 防护 | 1~2 小时 |
| P2 | R6 安全头；R7 body 限制；R8 日志轮转；R9 systemd；R10 权限；R12 清理 run.sh | 1 小时 |
