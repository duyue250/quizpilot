#!/usr/bin/env node
/**
 * 一键把反代上游写进 server/config.json（零依赖）
 *
 * 用法示例：
 *   node proxy/gen-config.js --preset deepseek-vinlic --token "你的userToken"
 *   node proxy/gen-config.js --preset deepseek-fly143
 *   node proxy/gen-config.js --preset doubao --key "sk-your-master-key" --port 8000
 *   node proxy/gen-config.js --custom --url "https://中转站/v1" --key "sk-xxx" --model "gpt-4o-mini" --vision true
 *
 * 可选参数（覆盖预设默认值）：--url --key --model --vision --port --name
 * 加 --dry-run 只打印不写入。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// 预设：各反代项目的默认接入参数
const PRESETS = {
  // vinlic/LLM-Red-Team 经典版 deepseek-free-api（Docker 部署）
  // token 即网页版 userToken，多账号用英文逗号拼接填到 --token
  'deepseek-vinlic': {
    name: 'DeepSeek网页版反代(vinlic)',
    url: 'http://127.0.0.1:8000/v1',
    key: null, // 必填 --token
    model: 'deepseek-chat',   // 模型名随便填，实际走网页版当前模型
    vision: false             // DeepSeek 网页版纯文字，图片题另配豆包
  },
  // Fly143/deepseek-free-api（Node 部署，管理面板管凭证，token 自动刷新）
  'deepseek-fly143': {
    name: 'DeepSeek网页版反代(Fly143)',
    url: 'http://127.0.0.1:8000/v1',
    key: 'sk-local',          // 凭证在 /admin 面板里配，这里随便填
    model: 'deepseek-chat',
    vision: false
  },
  // wangchuxiaoji-oss/doubao2api（Docker + Playwright，扫码登录，多模态可看图）
  'doubao': {
    name: '豆包网页版反代(doubao2api)',
    url: null,                // http://127.0.0.1:{port}/v1
    key: null,                // 必填 --key（.env 里的 API_MASTER_KEY）
    model: 'doubao',          // 具体模型名看项目 README / /v1/models
    vision: true              // 豆包多模态，图片题靠它
  }
};

function die(msg) {
  console.error('[x] ' + msg);
  console.error('用法: node proxy/gen-config.js --preset deepseek-vinlic|deepseek-fly143|doubao | --custom');
  console.error('      加 --dry-run 只预览。可用覆盖参数: --url --key --model --vision --port --name');
  process.exit(1);
}

let preset;
if (args.preset) {
  preset = PRESETS[String(args.preset).toLowerCase()];
  if (!preset) die('未知 preset: ' + args.preset + '（可选: ' + Object.keys(PRESETS).join(' | ') + '）');
} else if (args.custom) {
  preset = { name: '自定义AI上游', url: null, key: null, model: null, vision: false };
} else {
  die('必须指定 --preset 或 --custom');
}

const port = args.port || '8000';
const url = args.url || preset.url || `http://127.0.0.1:${port}/v1`;
const key = args.key || args.token || preset.key;
const model = args.model || preset.model || 'gpt-4o-mini';
const vision = args.vision !== undefined ? String(args.vision) === 'true' : preset.vision;
const name = args.name || preset.name;

if (!url) die('缺少 --url');
if (!key) {
  if (args.preset === 'deepseek-vinlic') die('缺少 --token（chat.deepseek.com 的 userToken，获取方法见 proxy/README.md）');
  if (args.preset === 'doubao') die('缺少 --key（doubao-2api .env 里的 API_MASTER_KEY）');
  die('缺少 --key');
}

const upstream = { name, baseUrl: url.replace(/\/+$/, ''), apiKey: key, model, vision };

const cfgPath = path.join(__dirname, '..', 'server', 'config.json');
let cfg = {};
if (fs.existsSync(cfgPath)) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { die('现有 config.json 不是合法 JSON: ' + e.message); }
} else {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'config.example.json'), 'utf8'));
}

const newCfg = { ...cfg, upstreams: [upstream] };
const out = JSON.stringify(newCfg, null, 2);

console.log('──────── 反代上游写入预览 ────────');
console.log(out);
console.log('──────────────────────────────────');

if (args['dry-run']) { console.log('[dry-run] 未写入。去掉 --dry-run 即写入 ' + cfgPath); process.exit(0); }

if (fs.existsSync(cfgPath)) {
  fs.copyFileSync(cfgPath, cfgPath + '.backup');
  console.log('[i] 旧配置已备份为 config.json.backup');
}
fs.writeFileSync(cfgPath, out, 'utf8');
console.log('[√] 已写入 ' + cfgPath);
console.log('[√] 下一步: 重启服务端（start-server.bat 或 node server/ai-answer-server.js），调试台验证。');
