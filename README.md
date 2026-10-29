# Type Words（私有部署版）

基于开源项目 [TypeWords](https://github.com/zyronon/TypeWords) 改造的**私有自托管背单词应用**：
只保留单词练习，学习数据存服务端 JSON，多浏览器/多设备共享进度；
带 TOTP 动态码门禁，默认只监听本地回环，适合放在自己的服务器上自用。

## 功能特性

- **单词练习**：跟写 / 默写 / 听写 / 拼写 / 复习 / 随机复习 / 单词测试多种模式，记忆曲线安排每日复习
- **词库管理**：内置 50+ 官方词库，支持自建词典、收藏 / 错词 / 已掌握系统词典
- **JSON 导入导出**：词典词条可导出 JSON / Excel，也支持批量导入 JSON（兼容词条数组与 `{ words: [...] }` 结构）
- **数据同步**：学习进度、词典、设置存服务端，多浏览器打开即为同一份数据
- **移动端适配**：软键盘输入捕获、常驻工具岛、自适应布局
- **安全门禁**：TOTP 动态码（验证器 App 扫码绑定）+ 30 天会话 Cookie + 登录限速

## 技术栈

- 前端：Nuxt 4 + Vue 3 + UnoCSS + Vue I18n + vxe-table
- 服务端：Node.js 原生 `http` 单文件服务器（零第三方依赖），JSON 文件存储
- 门禁：RFC 6238 TOTP（SHA1 / 6 位 / 30s），Base32 密钥，二维码由前端 `qrcode` 生成

## 本地开发

```bash
pnpm install
pnpm dev          # 开发服务，端口见 nuxt.config.ts
```

开发模式下门禁 / 同步接口不可用，可同时起一个本地服务端配合调试：

```bash
node deploy/server.mjs   # 默认 127.0.0.1:8300，可用环境变量覆盖
```

## 部署

### 1. 构建

```bash
pnpm install
pnpm generate        # 产物在 .output/public
```

### 2. 服务器目录布局

```
~/typewords/
├── web/         # .output/public 的全部内容（静态产物）
├── data/        # gate.json（TOTP 密钥）、sessions.json（登录态）、state.json（学习数据）
├── server.mjs   # 应用服务器：TOTP 门禁、同步 API、静态托管
└── run.sh       # 启动脚本（环境变量、日志轮转）
```

`run.sh` 会设置 `ROOT` / `DATA_DIR` / `HOST=127.0.0.1` / `PORT=8300`，并在日志超过 10MB 时自动轮转。
服务器上建议再配一条 crontab 实现开机自启：

```cron
@reboot sleep 10 && cd ~/typewords && ./run.sh >> logs/server.log 2>&1
```

### 3. 访问方式（SSH 隧道）

服务默认**只监听 127.0.0.1**，不暴露公网。本地访问：

```bash
ssh -N -L 8300:127.0.0.1:8300 <server>
# 浏览器打开 http://127.0.0.1:8300
```

如需公网使用，建议在服务器上加 Caddy/nginx 反代并配置 HTTPS，不要直接把 8300 暴露出去。

### 4. TOTP 门禁

首次部署或重置后，门禁页会展示一次二维码（10 分钟有效），用 Google Authenticator 等
验证器 App 扫码绑定，之后每次登录输入 30 秒动态码；登录成功后二维码永久隐藏。

忘记或更换手机时，在服务器上重置（会立即作废旧绑定）：

```bash
cd ~/typewords && node server.mjs reset-otp
# 终端会打印新的扫码 URI、手动密钥与当前动态码；门禁页会重新展示一次二维码
```

安全机制：服务端只持久化 Base32 密钥用于校验；同一 30 秒窗口的动态码防重放；
允许 ±1 步时钟偏差；登录失败 10 分钟内 8 次锁定 1 分钟；同步接口 120 次/分/IP 限速。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ROOT` | `./web`（相对 server.mjs） | 静态产物目录 |
| `DATA_DIR` | `./data` | JSON 数据目录 |
| `HOST` | `127.0.0.1` | 监听地址（保持回环，公网走反代） |
| `PORT` | `8300` | 监听端口 |
| `NODE_ENV` | `production` | 运行环境 |
| `NODE_OPTIONS` | `--max-old-space-size=512` | 大词典导入需要额外堆内存 |

## 项目结构

```
app/                        前端源码（Nuxt 4）
  pages/                    路由
    index.vue               门禁页（TOTP 首次绑定 / 登录）
    (words)/words.vue       主界面（词典、统计、学习日历）
    (words)/dict.vue        词典详情（词条增删改、导入导出入口）
    (words)/import.vue      JSON 批量导入
    (words)/practice-words/ 练习页（跟写/默写/测试）
    setting.vue             设置
  components/word/          词条、工具岛、练习组件
  core/
    hooks/event.ts          键盘事件与移动端软键盘捕获
    hooks/sound.ts          Web Audio 低延迟按键音
    stores/base.ts          学习数据 store（同步源）
    composables/useDataSyncPersistence.ts   本地缓存 ⇄ 服务端同步
    utils/remote.ts         服务端 API 客户端
deploy/
  server.mjs                应用服务器（门禁 / 同步 / 静态托管）
  run.sh                    启动脚本
docs/
  security-review-*.md      安全审查报告
i18n/                       多语言（pnpm i18n:write 由 excel 生成）
public/                     静态资源（词库列表、音效、图标）
```

## 数据与同步

服务端保存三类数据：`dict`（词典与学习进度）、`setting`（设置）、`practice_word`（进行中的练习）。
写入采用「先写本地缓存，再推服务端」，`updated_at` 由服务端统一打点，多端并发以最后写入为准；
切回标签页或重新打开时会主动比对并拉取服务端数据。数据文件在服务端以 `0600` 权限落盘。

## 安全

- 门禁 TOTP + HttpOnly / SameSite=Lax 会话 Cookie（30 天）
- 默认仅监听回环，同步接口全部要求登录态，写接口有速率限制
- 静态与 API 响应统一携带 `X-Frame-Options` / `Referrer-Policy` / `CSP frame-ancestors 'none'` / COOP
- 静态服务有路径穿越防护；请求体上限 32MB
- 详细评估见 [docs/security-review-2026-10-29.md](docs/security-review-2026-10-29.md)

## 许可证

沿用上游 [GPL-3.0](./LICENSE)。
