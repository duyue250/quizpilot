@echo off
chcp 65001 >nul
title 豆包网页版反代部署 (doubao2api 扫码登录版)
cd /d %~dp0

where git >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 git，请先安装：https://git-scm.com/download/win
  pause & exit /b
)
where docker >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Docker，请先安装 Docker Desktop：https://www.docker.com/products/docker-desktop/
  echo     装好后启动 Docker Desktop 再运行本脚本。
  pause & exit /b
)

if not exist doubao2api (
  echo [1/4] 克隆项目（wangchuxiaoji-oss/doubao2api，支持扫码登录）...
  git clone https://github.com/wangchuxiaoji-oss/doubao2api.git
  if errorlevel 1 ( echo [x] 克隆失败，检查网络 & pause & exit /b )
) else (
  echo [1/4] 项目已存在，跳过克隆
)

cd doubao2api

if not exist .env (
  echo [2/4] 生成 .env 配置...
  if exist .env.example copy .env.example .env >nul
  echo [!] 请编辑 doubao2api\.env 设置 API_MASTER_KEY（自定义一个 sk- 开头的密钥）
  echo     其余登录相关不用手填 —— 本项目支持手机豆包 App 扫码登录。
  if exist .env start notepad .env
  echo.
  echo     设置完保存关闭记事本，按任意键继续...
  pause >nul
) else (
  echo [2/4] .env 已存在，跳过
)

echo [3/4] 启动容器（首次会拉镜像/装浏览器内核，较慢）...
docker compose up -d
if errorlevel 1 ( echo [x] 启动失败，检查 Docker Desktop 是否在运行 & pause & exit /b )

echo [4/4] 等待服务就绪，然后拉起登录二维码...
timeout /t 5 >nul
echo.
echo ==========================================================
echo   下一步（扫码登录，唯一要动手的一步）：
echo   1. 打开项目 README 提供的管理页（一般是 http://localhost:8000 ）
echo      或按项目文档执行登录命令生成二维码
echo   2. 用手机「豆包」App 扫码确认登录你自己的豆包账号
echo   3. 登录态会注入浏览器上下文长期复用，失效时重新扫码即可
echo   4. 回到 D:\ocs 运行：
echo      node proxy\gen-config.js --preset doubao --key "sk-你在.env定的密钥" --port 8000
echo ==========================================================
docker compose logs -f
pause
