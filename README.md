# QuizPilot 智答领航

![QuizPilot](server/web/assets/logo.svg)

> 网课 AI 答题领航工具 —— 整卷扫描 · 图片题视觉识别 · 答案卡片 · 选项高亮 · 服务状态监测

[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-3.2.0-fbbf24.svg)](userscript/quizpilot.user.js)
[![Server](https://img.shields.io/badge/server-Node.js%20零依赖-34d399.svg)](server/ai-answer-server.js)
[![平台](https://img.shields.io/badge/平台-学习通/智慧树/职教云/MOOC-1f2b45.svg)](#支持平台)

**原创独立实现**（MIT）。与 [OCS 网课助手](https://github.com/ocsjs/ocsjs) 通过其官方公开的「自定义题库协议」互操作，未使用其源码；详见 [NOTICE.md](NOTICE.md) 与 [发布合规说明](RELEASE.md)。

---

## ✨ 功能

| | 功能 |
|---|---|
| 🧭 | **整卷批量模式**：一次扫描整页所有题目，逐题问 AI、逐题填答 |
| 🖼 | **图片题识别**：题目截图自动抓取压缩，发给视觉模型（豆包/GPT-4o/GLM-4V 等） |
| 🪪 | **答案卡片**：右下角弹出题目+答案+理由，可复制 |
| ✨ | **选项高亮**：命中的选项 amber 描边，一目了然 |
| 📡 | **服务状态灯**：服务端在线/离线/上游熔断实时显示 |
| 🔁 | **重试与缓存**：请求指数退避重试；服务端 LRU 缓存重复题秒回 |
| 🔑 | **访问密钥**：服务端可设 accessKey，共享给同学时防滥用 |
| 👀 | **仅查看模式**：只弹答案卡片不自动点选，手动确认再答 |
| ⌨️ | **快捷键**：Alt+Q 开关自动答题 / Alt+B 整卷一轮 / Alt+P 切换仅查看 |
| 🩺 | **诊断导出**：一键生成环境+日志诊断包，贴 issue 好排查 |
| 🤝 | **OCS 协同**：检测到 OCS 面板自动待机，双引擎不打架 |
| 🧩 | **双接入**：独立油猴插件，或作为 OCS 自定义题库（二选一或叠加） |
| ⚙️ | **设置向导**：服务端控制台网页里测连通、热更新上游配置 |

## 📦 安装

### 前置：本地服务端（必装）

```bash
# 1. clone 本仓库（或下载 zip 解压）
# 2. Windows 双击 start-server.bat；或命令行：
node server/ai-answer-server.js
# 3. 打开 http://127.0.0.1:8787/ —— QuizPilot 控制台（设置向导）
```

控制台里接入你的 AI（三选一）：

| 方式 | 说明 | 图片题 |
|---|---|---|
| 有现成 Key | 官方 API / 中转站，填 baseUrl + Key | 模型带视觉即可 |
| DeepSeek 网页版反代 | 免费；`proxy/deploy-deepseek.bat` 一键部署 | ❌ 纯文字 |
| 豆包网页版反代 | 免费；**手机 App 扫码登录**；`proxy/deploy-doubao.bat` | ✅ 支持 |

详见 [proxy/README.md](proxy/README.md)（各反代项目的登录方式与部署步骤）。

### 插件本体（二选一或都装）

**A. QuizPilot 独立插件**（推荐，功能最全）

[![ScriptCat 安装](https://img.shields.io/badge/ScriptCat-安装-8f6ce8.svg)](https://scriptcat.org/) [![GreasyFork](https://img.shields.io/badge/GreasyFork-安装-671a1a.svg)](https://greasyfork.org/)

- 从本仓库装：打开 [userscript/quizpilot.user.js](userscript/quizpilot.user.js) 原始文件，脚本猫/油猴会自动弹出安装；
- 上架后可直接在 ScriptCat / GreasyFork 页面点安装。

**B. OCS 自定义题库模式**（已用 OCS 的用户）

OCS 面板 → 题库设置 → 自定义题库 → 粘贴 [ocs-tiku-config.json](ocs-tiku-config.json) 内容 → 启用。OCS 负责抓题填答，本服务端负责出答案。

## 🚀 使用（独立插件）

1. 网课答题页右下角出现**罗盘悬浮球** → 点开面板；
2. 确认服务端地址（默认 `http://127.0.0.1:8787/answer`），顶部状态灯变绿即在线；
3. 先点「抓当前题」试一发，确认抓题和 AI 返回正常；
4. 勾「自动答题」开始全自动；「整卷批量模式」会一次答完本页所有题；
5. 「自动提交」「自动下一题」按需勾选。

## 🌐 支持平台

学习通/超星 · 智慧树 · 职教云(icve) · 学银在线 · U校园 · 考虫等，
以及任何题目容器能被选择器描述的站点（面板里可填自定义题目容器选择器）。
`@match *://*/*` 全站兜底 + 面板「禁用本站」按域名记忆排除。

## 🧰 目录结构

```
├─ userscript/quizpilot.user.js   # 插件本体（油猴/脚本猫）
├─ server/                        # 本地答题服务端（Node ≥16，零依赖）
│  ├─ ai-answer-server.js         #   答题 + OCS 协议 + 设置向导接口
│  ├─ config.example.json         #   配置模板
│  └─ web/                        #   QuizPilot 控制台（设置向导页）
├─ proxy/                         # DeepSeek/豆包反代部署脚本 + 配置生成器
├─ ocs-tiku-config.json           # OCS 自定义题库配置
├─ start-server.bat               # Windows 一键启动
└─ test/mock-upstream.js          # 假上游，开发自测用
```

## 🔒 隐私与数据

- 题目内容只发往**你自己配置的** AI 上游，本仓库代码不含任何遥测/上报；
- 插件配置存本地（GM 存储），服务端缓存存内存（重启即清）；
- 请遵守所在学校/平台规则，合理使用。

## ⚠️ 免责声明

本脚本为本地学习辅助工具，自动行为均发生在使用者本人账号与页面内；
使用者应自行遵守所在学校/平台规则，因使用产生的一切后果由使用者自行承担。
本项目与任何网课平台及 OCS 官方无关。

## 📄 许可证

[MIT](LICENSE) · 第三方组件说明见 [NOTICE.md](NOTICE.md)

[![Powered by 极简服务端](https://img.shields.io/badge/服务端-零依赖%20Node-34d399.svg)](server/ai-answer-server.js)
