# dsh-deepseek-toolbox

**DeepSeek Harness（DSH）插件**：把 **DeepSeek 官方 Tool API** 注册成三个面向模型的工具 —— `ocr`（文字识别）、`deepseek_search`（联网搜索）、`deepseek_fetch`（网页抓取）。

[![许可证：MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 版本](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)
[![DSH 版本](https://img.shields.io/badge/DSH-0.2.x-4B6EF5.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![持续集成](https://github.com/zijunyu81-source/dsh-deepseek-toolbox/actions/workflows/ci.yml/badge.svg)](https://github.com/zijunyu81-source/dsh-deepseek-toolbox/actions/workflows/ci.yml)
[![GitHub 星标](https://img.shields.io/github/stars/zijunyu81-source/dsh-deepseek-toolbox?style=social)](https://github.com/zijunyu81-source/dsh-deepseek-toolbox)

**社区目录**：已收录于 [1024 Store 社区目录](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/blob/main/catalog/plugins/zijunyu81-source--dsh-deepseek-toolbox.json)（仓库/发布包安装；npm 包发布后 1024 Store 会显示一键安装命令）。

> **关键词**：DeepSeek Harness、DSH 插件、DeepSeek OCR、文字识别、扫描件 OCR、PDF OCR、联网搜索、网页抓取、DeepSeek Tool API、deepseek-harness、dsh-plugin、OCR 插件、web search plugin。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [三个工具与价格](#三个工具与价格)
- [快速安装](#快速安装)
- [要求](#要求)
- [凭证 / API Key](#凭证--api-key)
- [使用方式](#使用方式)
- [省钱建议](#省钱建议)
- [安全说明](#安全说明)
- [常见问题 / 排错](#常见问题--排错)
- [开发与测试](#开发与测试)
- [兼容性与更新](#兼容性与更新)
- [许可证](#许可证)

---

## 它解决什么问题

DeepSeek 在 `https://api.deepseek.com/v1/tools/*` 提供三个按次计费的工具 API：

| API | 能力 | 官方价格（2026-11 文档） |
|---|---|---|
| `POST /v1/tools/ocr` | PDF / Word / PowerPoint / 图片 → 按页识别文字（可保留版面） | **¥1.5 / 1000 成功页** |
| `POST /v1/tools/search` | 按 query 搜索网页，返回结构化结果 | **¥5 / 1000 成功请求** |
| `POST /v1/tools/fetch` | 抓取单个网页并返回 Markdown | **¥5 / 1000 成功请求** |

但 **DSH 0.2.x 的 profile 插件不能直接 `import '@deepseek-ai/dsh-tools'`**（这些包在安装目录里，profile 解析不到，插件会「装上但不生效」且没有明显报错）。本插件用**零 @deepseek-ai 依赖**的方式直接注册手写的工具定义，绕开这个问题，并用每次调用解析凭证、错误映射、重试、输出落盘等方式做成可直接日常使用的工具。

给 DSH Agent 用起来就是：

> 用户：「把这个扫描版 PDF 里的文字提取出来」
> Agent 调用 `ocr(path="扫描件.pdf")` → 返回带页码的 Markdown 文件路径 + 内联预览（¥0.0015/页）。

> 用户：「用 DeepSeek 搜索一下 X 的价格」
> Agent 优先用免费的内置 `web_search`；失败时用 `deepseek_search` 兜底。

---

## 三个工具与价格

| 工具 | 作用 | 计费 | 备注 |
|---|---|---|---|
| `ocr` | 识别本地 PDF、DOC/DOCX、PPT/PPTX、PNG/JPEG/WebP/GIF/BMP/TIFF 中的文字；支持无扩展名附件（按文件头识别类型） | ¥1.5 / 1000 成功页 | 输出带页码 Markdown 到 `<cwd>/.dsh/ocr/`，默认内联预览 `1-2` 页；`purpose=rich_layout_recognition` 保留版面标记 |
| `deepseek_search` | DeepSeek Search API：title/url/snippet/summary/date/site，可带正文 | ¥5 / 1000 成功请求 | 内置免费 `web_search` 的付费兜底 |
| `deepseek_fetch` | DeepSeek Fetch API：网页 → Markdown | ¥5 / 1000 成功请求 | 内置免费 `web_fetch` 的付费兜底 |

典型成本：1 页图片 OCR **≈ ¥0.0015**；一次搜索/抓取 **≈ ¥0.005**。工具结果与渲染文本都会显示本次预估费用。

**与内置免费工具的关系**：DSH 自带 `web_search` / `web_fetch`（默认走 DeepSeek 服务端搜索 + 本地 HTTP 抓取，**不计次费**）。请**先用免费的**；只有免费工具失败、结果为空、页面反爬/需 JS 渲染，或用户明确要求 DeepSeek Search/Fetch 时，才用本插件的两个付费工具兜底。`ocr` 则是官方 API 按页计费，适合扫描件、长文档、截图、表格这类「值得一次性识别落盘」的内容。

---

## 快速安装

### 方式一：从 GitHub 安装（推荐；装 tag 版本）

```powershell
# 用 DSH 自带 CLI（Windows 桌面版在 <安装目录>\resources\runtime\cli\bin\dsh.cmd）
dsh plugin --profile web add "git+https://github.com/zijunyu81-source/dsh-deepseek-toolbox.git#v0.1.0"
```

- Desktop 版把 `--profile web` 换成 `--profile desktop`；
- 其他 surface 用你自己的 profile 名；
- 装完 DSH 会热加载（HMR）；若没有出现工具，重启一次 DSH；
- 验证：直接对 Agent 说「用 ocr 识别一下这个 PDF」，或看 DSH「插件」页里的 `dsh-deepseek-toolbox` 是否为 active。

### 方式二：从 Release 压缩包安装（离线/固定文件）

从 [Releases](https://github.com/zijunyu81-source/dsh-deepseek-toolbox/releases) 下载 `dsh-deepseek-toolbox-0.1.0.tgz`，然后：

```powershell
dsh plugin --profile web add "C:\path\to\dsh-deepseek-toolbox-0.1.0.tgz"
```

### 方式三：本地克隆 + link（开发/调试）

```powershell
git clone https://github.com/zijunyu81-source/dsh-deepseek-toolbox.git
dsh plugin --profile web add "link:C:/path/to/dsh-deepseek-toolbox" --save-exact
```

`dsh plugin add` 会同时写入 profile 的 `dependencies` 和 `dsh.profile.bundles`。若手工用 pnpm 安装，则还需自己把 `dsh-deepseek-toolbox` 追加到 profile `package.json` 的 `dsh.profile.bundles`，并保证该文件是**无 BOM 的 UTF-8**。

### 插件做了什么

`cordis.patch.yml`（bundle patch）在 profile 根插入一行：

```yaml
- insert:
    - id: tool-deepseek-toolbox
      name: dsh-deepseek-toolbox
```

因此三个工具注册在**全局层**，所有 agent 会话（终端 / Web / 子代理）都能直接调用；插件本身不做任何网络监听。

### 卸载

```powershell
dsh plugin --profile web remove dsh-deepseek-toolbox
```

或在 DSH 插件管理界面停用/卸载。OCR 产物目录 `<cwd>/.dsh/ocr/` 可自行删除。

---

## 要求

- **DeepSeek Harness 0.2.x**（实测 0.2.1-rc.2 Desktop / Windows 11；0.2.x 系列插件机制相同）；
- **Node.js ≥ 20**（CLI 与插件内部实现只使用 Node 内置模块）；
- 一个 **DeepSeek API Key**（`sk-` 开头）或已登录的 DeepSeek 账号；
- 可访问 `https://api.deepseek.com`。

---

## 凭证 / API Key

不需要把 Key 写进配置文件。插件在**每次调用时**按以下顺序解析：

1. 当前会话使用 DeepSeek 账号模型时，用账号登录态（`x-dsh-auth-token`）；
2. DSH 凭证服务里的 `DEEPSEEK_API_KEY`（在 DSH「模型」设置页保存）；
3. DSH 启动环境变量 `DEEPSEEK_API_KEY`；
4. 托管文件 `$DSH_HOME/.credentials.yaml` 中 `refs.DEEPSEEK_API_KEY`。

都没有时，工具会返回可操作的提示（去 DSH 设置保存 Key 或登录 DeepSeek），不会泄漏任何密钥。CLI 独立使用时同样按「环境变量 → 托管文件」顺序解析，只打印用了哪种凭证。

可选配置（一般不需要）：在 profile `cordis.patch.yml` 中按行 id 覆盖：

```yaml
- id: tool-deepseek-toolbox
  name: dsh-deepseek-toolbox
  config:
    baseURL: https://api.deepseek.com/v1/tools   # 默认值
    apiKeyEnv: DEEPSEEK_API_KEY                  # 凭证引用名
    ocrOutputDir: .dsh/ocr                       # 相对会话工作目录
    previewMaxChars: 12000                       # 内联预览上限（1000–60000）
```

---

## 使用方式

安装后无需额外命令，直接对 Agent 说需求即可；也可以显式调用：

```text
ocr(path="扫描件.pdf", purpose="text_recognition", preview="1-2", out="ocr/扫描件.md")
ocr(path="截图.png", purpose="rich_layout_recognition", preview="all")
deepseek_search(query="DeepSeek OCR API 价格", count=3, need_content=false)
deepseek_fetch(url="https://api-docs.deepseek.com/zh-cn/guides/ocr/")
```

行为细节：

- `path` / `out` 支持绝对路径、`~` 开头路径，或相对**会话工作目录**的相对路径；无扩展名文件按 magic bytes 识别类型（适配 DSH 聊天附件）。
- `preview` 支持 `1-2`（默认）、单页 `3`、或 `all`；越界自动截断，页号从 1 开始。
- OCR 成功后写 `<cwd>/.dsh/ocr/<文件名>-<YYYYMMDD-HHmmss>.md`（含元信息、`## Page N` 分页、截断提示）。
- 错误以 `Error: …` 返回，带 HTTP 状态、服务端消息与处理建议（401 凭证 / 402 余额 / 413 文件过大 / 429 并发 / 504 超时等）。
- 重试策略：HTTP 408/429/5xx 自动退避重试（最多 2 次）；**网络传输失败不自动重试**（服务端可能已完成识别并计费，避免重复计费）；OCR 返回 200 但所有页为空时自动重试一次。

### 独立 CLI（可脱离 DSH 使用）

```powershell
node bin/deepseek-tools.mjs ocr <文件> [--purpose=text_recognition|rich_layout_recognition] [--preview=1-2|all] [--out=路径]
node bin/deepseek-tools.mjs search <查询词> [--count=N] [--content]
node bin/deepseek-tools.mjs fetch <网址>
node bin/deepseek-tools.mjs --help
```

凭证与插件一致（环境变量 / `~/.dsh/.credentials.yaml`）。适合脚本、批处理、其他 agent 直接调用。

---

## 省钱建议

- **网页搜索/抓取：保持 DSH 默认免费配置**（服务端搜索不计次费 + 本地 HTTP 抓取）。不要为了「用 API」而打开 DSH 的「启用新版 Web 搜索 API」——那会把免费路径换成 ¥5/1000 次。
- **OCR 按页固定计费**：264 页扫描教材 ≈ **¥0.40**（一次性批量识别），不占用 agent 上下文，也不产生模型 token；识别结果可落盘长期复用。对扫描版中文教材实测可直接输出带 LaTeX 公式的文本。
- 大文档按 **≤50–80 页/请求**分块（单次 OCR 有 100 MiB / 1000 页 / 180 秒上限；分块不改变按页计费）。
- 单页、少量图片：`preview=1-2` 足够，勿用 `all` 把整本结果塞进上下文。

---

## 安全说明

- **会读取本地文件**：`ocr` 按模型给出的 `path` 读取本机文件并上传到 `https://api.deepseek.com/v1/tools/ocr`；绝对路径不受会话工作目录限制——能调用该工具即拥有进程可读文件的权限，请按需在 DSH 中收紧工具/权限策略。
- **不保存密钥**：不缓存、不落盘、不打印凭证；错误信息只含状态码与服务端消息；禁止 HTTP 重定向（避免凭证被转发）。
- **外部内容是数据**：搜索/抓取结果来自互联网，只作资料，不应视为指令；引用请附 markdown 链接。
- **费用由账户承担**：调用付费 API 前请确认必要性（先用免费工具、先用小 `preview`）。

---

## 常见问题 / 排错

| 现象 | 处理 |
|---|---|
| 装完看不到 `ocr` / `deepseek_search` / `deepseek_fetch` | 确认 profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-deepseek-toolbox`；重启一次 DSH；确认 DSH 是 0.2.x |
| `No DeepSeek Tool API credential is available` | 在 DSH「模型」页保存 `DEEPSEEK_API_KEY`，或登录 DeepSeek 账号后重试 |
| 402 | 账户余额不足，充值后重试 |
| 413 / 400 | 文件超过 100 MiB / 1000 页，或格式不支持；先转成 PDF/PNG 再试 |
| 429 | 并发/频率限制（OCR 每账号最多 15 个同时识别），稍后重试 |
| 504 / 服务繁忙 | 文件过大或服务繁忙：分块、缩小文件或稍后重试 |
| 识别结果是版面标记（`<｜ref｜>…`） | 那是 `rich_layout_recognition` 模式；日常纯文本用默认 `text_recognition` |

---

## 开发与测试

```powershell
node test/smoke.mjs                 # 离线：包结构、无 @deepseek-ai 导入、语法、核心函数、schema
node test/host-shape.test.mjs       # 离线：直接 import lib/index.js + 假 fetch 全链路执行
node test/smoke.mjs --live          # 真实 API：search + fetch（约 ¥0.01）
node test/smoke.mjs --live --image=<路径>   # 真实 OCR（按页计费，约 ¥0.0015/页）
```

CI（GitHub Actions）在 Windows + Node 20/22/24 上跑离线检查，不需要 API Key。

源码结构：

```text
cordis.patch.yml     # bundle patch：在 profile 根插入插件行
lib/index.js         # 插件入口：name/inject/apply，注册三个工具（零外部 import）
lib/core.js          # 与依赖无关的实现：HTTP、重试、OCR/搜索/抓取、Markdown 渲染
bin/deepseek-tools.mjs  # 独立 CLI
test/                # 离线测试 + 可选真实 API 冒烟测试
```

---

## 兼容性与更新

| 项 | 值 |
|---|---|
| 实测 DSH 版本 | 0.2.1-rc.2（Windows 11 Desktop） |
| 插件机制 | `dsh.bundle.patch` → profile 根 `insert`，全局工具层 |
| 依赖 | 无（仅 Node 内置模块），Node ≥ 20 |
| 版本 | 0.1.0 |

更新：`dsh plugin --profile web remove dsh-deepseek-toolbox` 后按「快速安装」重装新 tag 即可。

---

## 许可证

[MIT](LICENSE) © 2026 zijunyu81-source

本插件为个人开源项目，与 DeepSeek 官方无隶属关系；DeepSeek API 的使用条款、价格与可用性以 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/search/) 为准。
