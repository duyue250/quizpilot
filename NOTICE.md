# NOTICE — 第三方组件与接口说明

本项目（QuizPilot 智答领航）为原创独立实现，采用 MIT 许可证分发。

1. **协议互操作**：服务端暴露的「自定义题库」JSON 配置格式（`${title}`/`${type}`/`${options}`
   占位符 + handler 解析）是各网课助手社区通用的公开约定，本项目按该约定提供服务端实现；
   未复制、未修改任何第三方助手脚本的源码。

2. **可选上游**（用户自行部署，不属于本项目代码）：
   - Fly143/deepseek-free-api — MIT
   - vinlic/deepseek-free-api (LLM-Red-Team) — MIT
   - wangchuxiaoji-oss/doubao2api — 随其仓库许可证
   这些项目由使用者按其自身许可证独立使用，本项目仅以标准 OpenAI
   /v1/chat/completions 协议与之通信。

3. **商标与命名**：QuizPilot / 智答领航 为本项目独立命名，与任何网课平台、
   脚本社区官方无关。
