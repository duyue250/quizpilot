# QuizPilot 服务端 API 文档

所有接口均返回 JSON，带 CORS 全开头；默认端口 `8787`（config.json 可改）。

## 接口一览

| 接口 | 方法 | 用途 |
|---|---|---|
| `/answer` | POST | 通用答题：`{title, options[], type, images[dataURL]}` → `{ok, answer[], reason, via, ms, cache}` |
| `/tiku/search` | POST | 自定义题库配置入口：`{title, type, options}` → `{code:200, answer[], judge}`（`/ocs/search` 为兼容别名） |
| `/search/text` | POST | 兼容旧自定义题库协议 → `{code:200/201, answer[]}` |
| `/search/img` | POST | 图片题：`{images[dataURL]}` → `{code, answer[]}` |
| `/config` | GET/POST | 设置向导：读取/热更新上游与 accessKey（POST 可选 `saveToDisk` 写入 config.json） |
| `/test-upstream` | POST | 上游连通性测试：`{index}` 或 `{baseUrl, apiKey, model}` → `{ok, ms, reply}` |
| `/health` | GET | 状态/统计/每上游统计/熔断情况 |
| `/assets/*` | GET | 控制台静态资源（logo 等，带路径穿越防护） |

## 访问密钥（可选鉴权）

`config.json` 或控制台里设置 `accessKey` 后，所有答题接口（/answer、/ocs/search、/search/text、/search/img）需携带密钥，三选一：

```
请求头  X-Access-Key: 你的密钥
URL    ?key=你的密钥
请求体  {"accessKey": "你的密钥", ...}
```

未带或错误 → `/answer` 返回 HTTP 401；题库兼容接口返回 `{code:201}`（调用方视为无答案）。
`/health`、控制台页面不鉴权（仅本机查看状态用）。

## 答案溯源字段

`/answer` 成功响应带 `via`（实际使用的上游名）和 `ms`（该上游耗时），
`/health` 的 `upstreamStats` 汇总每个上游的 ok/fail/avgMs，方便观察哪个反代快、哪个在摸鱼。

`type` 取值：`single` 单选 / `multi` 多选 / `judge` 判断 / `completion` 填空 / `unknown`。
返回 `answer` 永远是数组；判断题双写 `["正确","对","是","true"]` 提高各平台匹配率。

## 通用「自定义题库」配置

各类网课助手（支持自定义题库的）→ 题库设置 → 自定义题库，粘贴 [tiku-config.json](../tiku-config.json)：

```json
[{
  "name": "QuizPilot 智答领航",
  "homepage": "http://127.0.0.1:8787/",
  "url": "http://127.0.0.1:8787/ocs/search",
  "method": "post",
  "contentType": "json",
  "data": { "title": "${title}", "type": "${type}", "options": "${options}" },
  "handler": "return (res) => res.code === 200 ? res.answer : undefined"
}]
```

配置格式为网课助手社区通用的「自定义题库」公开约定（占位符 + handler 解析函数）。

## 答题正确率怎么提

- `config.json` 的 `systemPrompt` 可加课程上下文；温度固定 0 保证稳定输出；
- 图片题必须用视觉模型（`vision: true`）；截图压缩到 900px 宽（插件可调）；
- 相同题走 LRU 缓存（默认 2000 条）；
- 选项匹配失败多因序号前缀，插件已做 `A.` 剥离 + 字母索引兜底。

## 常见问题

| 现象 | 处理 |
|---|---|
| 助手搜题一直「未搜索到答案」 | 开控制台手动发一道题看报错；多数是上游地址/key 不对 |
| 上游报 401/403 | key 错或反代没放行 `/v1/chat/completions`；反代登录态过期重新登录/扫码 |
| 图片题答非所问 | 上游模型没视觉能力，换 `vision: true` 的模型 |
| 插件悬浮球不出现 | 油猴是否启用；面板「本站是否被禁用」；页面 iframe 场景已支持 |
| 想换端口 | config.json `port` + 控制台/插件里的地址同步改 |
| 上游熔断 | 连续失败 3 次隔离 60 秒；`/health` 里 `circuit: true` 可见 |
