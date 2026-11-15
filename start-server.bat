@echo off
chcp 65001 >nul
title QuizPilot 智答领航服务端
cd /d %~dp0

if not exist server\config.json (
  echo [!] 未找到 server\config.json，正在从模板创建...
  copy server\config.example.json server\config.json >nul
  echo [!] 请编辑 server\config.json 填入你的 AI 反代地址和 Key，然后重新运行本脚本。
  notepad server\config.json
  exit /b
)

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b
)

echo [√] 启动服务端 http://127.0.0.1:8787  （Ctrl+C 停止）
node server\ai-answer-server.js
pause
