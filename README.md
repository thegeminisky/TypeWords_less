# Type Words（私有精简版）

基于开源项目 [TypeWords](https://github.com/zyronon/TypeWords) 改造的**私有部署版本**，
只保留单词练习，并把学习进度改为服务端存储，实现多浏览器共享。

## 与上游的差异

| 方面 | 上游 | 本版本 |
|---|---|---|
| 入口 | 官网欢迎页 | 门禁页，输入访问密钥后放行 |
| 功能范围 | 单词 + 文章 + 资料 + 帮助 + 反馈 | **仅单词练习** |
| 侧边栏 | 五项导航 | 仅「单词」，设置在左下角 |
| 数据存储 | 浏览器 IndexedDB（可选 Supabase 同步） | **服务端 JSON 存储，全局共享** |
| 发音 | 有道在线音频优先 | **浏览器 TTS 优先**，桌面 / 移动端通用 |
| 统计上报 | umami 上报到作者域名 | 已移除 |

## 目录结构

```
app/                    前端源码（Nuxt 4）
  pages/                路由：/ （门禁）、/words、/dict-list、/dict、/practice-words/:id、/setting
  core/utils/remote.ts  服务端 API 客户端（门禁 + 同步）
  core/utils/speech.ts  浏览器语音合成封装（含移动端兼容）
  core/composables/useDataSyncPersistence.ts  本地缓存 ⇄ 服务端同步
deploy/
  server.mjs            应用服务器：门禁、同步 API、静态托管
  run.sh                启动脚本
```

## 本地开发

```bash
pnpm install
pnpm dev          # http://localhost:5567
```

开发模式下没有 API 服务，门禁与会话接口会失败，需要同时启动服务端：

```bash
node deploy/server.mjs   # 默认 0.0.0.0:8300
```

## 构建与部署

```bash
pnpm generate                                  # 产物在 .output/public
ROOT=./.output/public node deploy/server.mjs   # 本地以生产形态运行
```

服务器上目录布局：

```
~/typewords/
├── web/         .output/public 的全部内容
├── data/        state.json（学习进度）+ sessions.json（登录态）
├── server.mjs
└── run.sh
```

## 门禁

- 默认密钥：`11111111`，可通过环境变量 `GATE_KEY` 覆盖。
- 校验在服务端完成，通过后下发 HttpOnly Cookie（30 天有效）。
- 未通过校验时，同步接口一律返回 401，前端路由也会被守卫拦回门禁页。

## 数据同步

服务端保存四类数据中的三类：`dict`（词典与学习进度）、`setting`（设置）、`practice_word`（进行中的练习）。
写入采用「先写本地缓存，再推服务端」，`updated_at` 由服务端统一打点，
多浏览器并发时以最后写入为准。切换标签页回来会主动拉取一次服务端数据。

## 发音

默认使用浏览器内置语音合成（Web Speech API）：

- 桌面端推荐 Edge：可用 Microsoft 在线自然音色；
- 移动端使用系统语音（iOS / Android 均可）；
- 未检测到英文音色时，设置页提供「重新读取语音」按钮；
- 若某些环境 TTS 不可用，可在设置里把「发音来源」切换为「有道词典在线音频」。

## 许可证

沿用上游 GPL-3.0，详见 [LICENSE](./LICENSE)。
