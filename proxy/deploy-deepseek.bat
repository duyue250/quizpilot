@echo off
chcp 65001 >nul
title DeepSeek 网页版反代部署 (Fly143版)
cd /d %~dp0

where git >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 git，请先安装：https://git-scm.com/download/win
  pause & exit /b
)
where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Node.js，请先安装：https://nodejs.org
  pause & exit /b
)

if not exist deepseek-free-api (
  echo [1/3] 克隆项目...
  git clone https://github.com/Fly143/deepseek-free-api.git
  if errorlevel 1 ( echo [x] 克隆失败，检查网络 & pause & exit /b )
) else (
  echo [1/3] 项目已存在，跳过克隆
)

cd deepseek-free-api
if not exist node_modules (
  echo [2/3] 安装依赖（首次较慢）...
  call npm install
  if errorlevel 1 ( echo [x] 依赖安装失败 & pause & exit /b )
) else (
  echo [2/3] 依赖已安装，跳过
)

echo [3/3] 启动服务（保持本窗口开着）...
echo.
echo   启动后浏览器打开 http://localhost:8000/admin （默认 admin/admin）
echo   在面板里用 DeepSeek 账号密码登录一次，然后回到 D:\ocs 运行:
echo     node proxy\gen-config.js --preset deepseek-fly143
echo.
call deploy.sh 2>nul || npm start
pause
