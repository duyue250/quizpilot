# AI 反代上游部署指南（DeepSeek / 豆包网页版 → OpenAI 兼容 API）

本目录配合 `server/config.json` 使用：反代项目负责把**网页版免费对话**变成 OpenAI 协议接口，我们服务端再消费它。
三个经过筛选的项目：

| 项目 | 平台 | 登录要求 | 部署方式 | 图片(视觉) |
|---|---|---|---|---|
| [Fly143/deepseek-free-api](https://github.com/Fly143/deepseek-free-api) | DeepSeek 网页版 | 管理面板 http://localhost:8000/admin 里登一次账号密码（token 自动刷新） | Node 直跑，**无需 Docker** | ❌ 纯文字 |
| [vinlic/deepseek-free-api](https://github.com/xiaoY233/DeepSeek-Free-API/blob/master/README.md)（LLM-Red-Team 经典版） | DeepSeek 网页版 | 抓一次 `userToken` 填环境变量 | Docker 一条命令 | ❌ 纯文字 |
| [wangchuxiaoji-oss/doubao2api](https://github.com/wangchuxiaoji-oss/doubao2api#5) | 豆包网页版 | **手机豆包 App 扫二维码登录** ✅（也可抓 Cookie） | Docker + Playwright | ✅ **能看图** |

**推荐组合**：DeepSeek 反代（免费、文字题快）+ 豆包反代（图片题靠它，扫码即用）。
> 更推荐：新版服务端有「设置向导」（打开 http://127.0.0.1:8787/ ），网页里填完直接点测试+保存，不用手动改 config.json。

---

## 一、DeepSeek 反代

### 方式 A：Fly143 版（Node 直跑，推荐 Windows 用户）

1. 双击 `deploy-deepseek.bat`（自动 clone + 装依赖 + 启动）。
2. 浏览器打开 **http://localhost:8000/admin**，默认账号密码 `admin` / `admin`。
3. 在面板里**用你的 DeepSeek 账号密码登录一次**（之后 token 过期会自动重登，不用管）。
4. 把服务写进我们的配置：

```
node proxy\gen-config.js --preset deepseek-fly143
```

### 方式 B：vinlic 经典版（Docker 一条命令）

1. 装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
2. 拿 token（唯一要手动的一步）：
   - 浏览器登录 https://chat.deepseek.com/ ，随便发一条消息；
   - 按 `F12` → **Application（应用）** 标签 → 左侧 **Local Storage** → `https://chat.deepseek.com`；
   - 找到键 `userToken`，复制它的 `value`（一长串）。
3. 启动（把 `<userToken>` 换成上一步复制的值）：

```
docker run -it -d --init --name deepseek-free-api -p 8000:8000 -e TZ=Asia/Shanghai -e DEEP_SEEK_CHAT_AUTHORIZATION="<userToken>" vinlic/deepseek-free-api:latest
```

4. 写入配置（多账号把多个 token 用英文逗号拼接传给 --token）：

```
node proxy\gen-config.js --preset deepseek-vinlic --token "<userToken>"
```

> token 失效表现：调试台报 401/403。解决：重新抓一次 userToken 重跑第 3 步；或换方式 A（自动刷新）。

---

## 二、豆包反代（doubao2api，扫码登录 + 支持图片题）

1. 装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
2. 双击 `deploy-doubao.bat`（自动 clone + 生成 .env + 启动容器）。
3. **登录 = 扫码**：容器起来后按脚本提示打开管理页（一般 `http://localhost:8000`），
   页面出二维码 → 手机「豆包」App 扫码确认 → 登录态注入浏览器上下文长期复用；
   失效了重新扫一次即可，不用抓 Cookie。
   （备用方案：手动抓 Cookie 填 .env —— F12 → Network → 复制 `www.doubao.com`
   请求头里整串 cookie，方法同旧版项目。）
4. `.env` 里只需自己定一个 `API_MASTER_KEY`（sk- 开头）。
5. 写入配置：

```
node proxy\gen-config.js --preset doubao --key "sk-your-secret-key-here" --port 8000
```

> 状态验证：`docker compose logs -f`；返回 401/登录失效 → 管理页重新扫码。

---

## 三、验证整条链路

1. 启动本服务端：`start-server.bat`
2. 开调试台 http://127.0.0.1:8787/ → 随便粘一道单选题 → 「发送到 AI 获取答案」→ 返回里有 `answer` 即通。
3. 图片题测试：调试台传一张题目截图再发，能返回答案说明上游带视觉能力（豆包）。

## 常用维护命令

| 动作 | 命令 |
|---|---|
| 看服务状态 | `node proxy\gen-config.js --preset deepseek-fly143 --dry-run`（预览配置） |
| 重启服务端 | 关掉窗口重开 `start-server.bat` |
| DeepSeek 多账号 | `--token "token1,token2,token3"`（vinlic 版自动轮询） |
| 只换上游地址不换 preset | `--custom --url "https://xxx/v1" --key "sk-xxx" --model "gpt-4o-mini" --vision true` |
