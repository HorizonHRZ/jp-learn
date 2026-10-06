<p align="center">
  <img src="app/assets/icon.svg" width="96" alt="jp-learn">
</p>

<h1 align="center">日语学习 · jp-learn</h1>

<p align="center">
  本地优先、零依赖的日语学习工具 —— 查词、注音、活用还原、数字读法全在本机完成。<br>
  不用安装，不用构建，<b>你的学习数据只存在你自己的浏览器里</b>。
</p>

---

## 这是什么

一个跑在本机的日语学习应用。双击 `启动.cmd`，它在本地起一个 Node 服务并打开浏览器；
关掉黑窗口，它就停止，不常驻、不后台、不联网（除非你自己开 AI 功能）。

**当前版本 `0.4.0`**（构建日期 2026-10-08），数据库结构版本 `4`。

### 五个功能模块

| 模块 | 做什么 |
|---|---|
| **背单词** | SRS 间隔重复排程、每日复习上限（默认 40，超出顺延）、错题本、生词本 |
| **歌词学习** | 粘贴日文/中文对照歌词 → 自动分词、汉字标振假名（可开关） |
| **读书 / 精读** | 逐词点查、振假名、罗马音、批量加词、笔记；支持左日文 / 右中文两栏对照读 |
| **语法教材** | JLPT N1–N5 语法点，含索引与关联关系 |
| **工具箱** | 数字/日期/量词读法、动词形容词变形与还原、OCR 选区取字、Anki 导出 |

外加**学习统计**、**快照备份**、**数据与设置**三个页面。

---

## 三条不能违反的设计约束

这三条是这个项目所有设计取舍的根源，写在 `ARCHITECTURE.md` 里，任何改动都不得违反：

1. **源码永远是明文** —— 没有 `node_modules`，没有构建步骤，没有打包产物。
   改源码 → 刷新浏览器 → 立刻生效。
2. **程序与用户数据彻底分离** —— 程序在 `app/`、`server.js`、`tools/`；
   **你的数据在浏览器的 IndexedDB 里，不在这个文件夹里**。升级代码永不触碰数据。
3. **用户数据永不丢失** —— 一键导出/导入 JSON、自动快照（保留最近 10 份）；
   清空数据必须二次确认，且清空前**强制**先备份一次。

---

## 快速开始

### 方式一：双击（推荐）

```
双击  启动.cmd
```

它会自动完成：找到 Node → 启动本地服务（默认端口 `8787`）→ 打开浏览器到
`http://127.0.0.1:8787/`。

**关掉黑窗口 = 立刻停止服务。** 关掉网页标签页约 90 秒后服务也会自己停（省内存）。

### 方式二：命令行

```powershell
node server.js            # 默认 8787
node server.js 8899       # 指定端口
```

想让它**不要**自动退出（例如一边用一边改代码）：

```powershell
$env:JP_LEARN_NO_IDLE_EXIT='1'; .\启动.cmd
```

### 环境要求

只需要 **Node.js**。项目优先使用自带的便携版 `runtime\node.exe`；
如果没有，会回退到系统 PATH 里的 Node。

`runtime\` 是运行期产物，**不在 Git 仓库里**。缺了可以一键获取（含官方 SHA256 校验）：

```powershell
node tools\get-node-runtime.mjs
```

---

## 隐私：说清楚它到底联不联网

> **唯一会联网的功能是「AI 翻译 / 讲解」，而且默认关闭**，需要你自己填一个 AI 服务的
> 地址和密钥才会启用。不开它，整个程序完全在本机运行。

- 你的学习数据（进度、排程、历史、生词本、错题本、笔记）**只存在浏览器 IndexedDB 里**，
  不上传、不同步、不经过任何服务器。
- 只有当你**主动**使用 AI 功能时，你选中的那段文字才会发给你**自己配置**的 AI 服务。
- 密钥存在 `config.local.json`（明文，按你的选择），该文件已被 `.gitignore` 排除，
  **不会进入版本库**。
- 前端**不允许**直接请求外部地址 —— 这一条不是口头承诺，
  `tools\test-render.mjs` 里有一条断言在盯着它。

---

## 内置数据

| 内容 | 数量 |
|---|---|
| 词库条目（N5–N1 分级 + 常用补充） | **22,589 条** |
| 语法点（N1–N5） | **470 条** |
| 检索索引（`data/index/`） | 词条 / 读音 / 汉字 / 快速查表 |

### 数据来源与许可

| 数据 | 来源 | 许可 |
|---|---|---|
| 词条与中文释义 | [jmdict-cn](https://github.com/zzhuxiaojun-glitch/jmdict-cn)（基于 JMdict） | CC BY-SA 4.0 |
| JLPT 分级词表 | [yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab) | CC BY-SA 4.0 |
| 例句（可选） | [Tatoeba](https://tatoeba.org/) | CC BY 2.0 FR |
| 单字读音（可选） | kanjidic2 | CC BY-SA 4.0 |

> **关于释义的诚实说明**：jmdict-cn 的中文释义是上游用模型生成的，不是人工词典。
> 少数官方 JLPT 词没有中文释义，界面会写明「暂无释义」，**不会编造意思**。
> 学习时请以权威词典为准。

`data/` 是**已构建好的内置数据**，一般不需要重建。确需重建时双击 `tools\重建数据.cmd`
（依次执行 `fetch-data.mjs` → `build-romaji.mjs` → `build-vocab.mjs`，需要联网）。

---

## 目录结构

```
jp-learn/
├─ 启动.cmd                  # 双击启动：找 Node → 起服务 → 开浏览器
├─ 停止服务.cmd              # 停止本地服务
├─ 静默启动.vbs              # 无窗口启动
├─ server.js                 # 零依赖本地服务 + 分词/注音/查词/精读/OCR/AI 代理
├─ 使用说明.md               # 面向用户的完整说明书
├─ ARCHITECTURE.md           # 架构与硬约束（含历史决策记录）
├─ config.local.json         # 【本机私密】AI 密钥等配置 —— 已被 .gitignore 排除
├─ app/                      # 前端源码（明文，改完刷新即生效）
│  ├─ index.html
│  ├─ manifest.webmanifest
│  ├─ css/theme.css
│  ├─ js/                    # 分词/注音/变形/SRS/IndexedDB 封装/路由/UI
│  │  └─ views/              # home vocab lyric reading grammar toolbox stats …
│  └─ assets/icon.svg
├─ data/                     # 内置静态数据（词库、语法、假名表、索引）
├─ tools/                    # 数据构建与自检脚本（纯 Node，零依赖）
├─ runtime/                  # 便携版 Node —— 运行期产物，不入库
└─ 发布/                     # 打包产物 —— 不入库
```

---

## 自检

项目自带一套体量不小的自检脚本（`tools/` 下共 120 个 `.mjs`，其中
`test-*.mjs` 23 个、`qa-*.mjs` 8 个 —— 后者用**真浏览器**量排版，
因为假 DOM 测不出「左右是否真的并排」）。

服务启动后，在项目目录执行：

```powershell
node tools\test-tokenizer.mjs    # 分词、注音、罗马音回归
node tools\test-srs.mjs          # SRS 排程算法
node tools\test-db.mjs           # 用户数据层（导出/导入/快照/清空/旧版本升级）
node tools\test-render.mjs       # 界面冒烟：渲染全部 9 个路由（含 AI 与隐私断言）
node tools\test-grammar.mjs      # 语法数据完整性
node tools\test-ai.mjs           # AI 配置逻辑 + 密钥绝不泄漏
```

完整的 46 项自检清单见 [`使用说明.md`](使用说明.md) 第六节。

---

## 常见问题

**Q：关掉网页后，收藏夹里的地址打不开了？**
不是出错，是服务已经退出（约 90 秒宽限期后）。重新双击 `启动.cmd` 即可，
约 3.5 秒起来。**你的学习数据一点都不会丢** —— 它存在浏览器里，不在服务里。

**Q：提示端口被占用？**
换个端口：`启动.cmd 8899`。

**Q：提示找不到 Node？**
跑一次 `node tools\get-node-runtime.mjs` 让项目自带 Node，之后完全离线可用；
或自行安装 [Node.js LTS](https://nodejs.org/)。

**Q：浏览器提示可以「安装」这个应用？**
那只是浏览器读了 `manifest.webmanifest` 建了个快捷方式，
**不会改变运行方式**，也不会把任何东西装进系统。项目**刻意不做 Service Worker 离线缓存**，
因为离线能力和「接入 AI」的需求是矛盾的，硬做的结果是"看起来能离线、实际用不了"。

**Q：数据存哪了？怎么备份？**
在「数据与设置」页一键导出 JSON，也能从 JSON 导入恢复。
程序还会自动打快照并保留最近 10 份。

---

## 文档

| 文件 | 内容 |
|---|---|
| [`使用说明.md`](使用说明.md) | 面向用户：每个功能怎么用、FAQ、自检清单 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 面向开发者：硬约束、目录结构、历史决策与踩坑记录 |
| [`DOC/`](DOC/) | 内容编写规范、课堂笔记复核清单等 |

---

## 上传改动到 GitHub

项目自带一个向导脚本，双击即可：

```
双击  上传到GitHub.cmd
```

它会依次执行 `git add` → 让你填一句改动说明 → `git commit` → `git push`，
并在提交前检查 `config.local.json`（密钥）有没有误入待提交区。

手动操作则是老三样：

```powershell
git add -A
git commit -m "改了什么"
git push
```
