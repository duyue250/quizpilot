#!/usr/bin/env node
/**
 * AI 反代自动答题服务端（零依赖，Node >= 16）
 *
 * 职责：
 *  1. 接收油猴插件/浏览器脚本发来的题目（文本 + 可选图片 base64）
 *  2. 转发给上游 AI（网页版反代 / OpenAI 兼容中转均可，配置成 OpenAI /chat/completions 协议即可）
 *  3. 解析 AI 返回答案，做缓存、并发控制、多上游故障切换
 *  4. 兼容 OCS 网课助手「自定义题库」协议：/search/text  与  /search/img
 *
 * 启动：
 *  1) 复制 config.example.json 为 config.json，填好你的反代地址和 key
 *  2) node server/ai-answer-server.js
 *  3) 浏览器打开 http://127.0.0.1:8787/ 有调试页面
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// 配置加载
// ---------------------------------------------------------------------------
const CFG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (fs.existsSync(CFG_PATH)) {
    return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  }
  // 没有 config.json 时用 example 跑，方便先看页面
  const fallback = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
  console.warn('[warn] 未找到 config.json，已使用 config.example.json 兜底（上游会是占位地址，请复制并填写）');
  return fallback;
}

const cfg = loadConfig();
const PORT = Number(cfg.port || 8787);
const TIMEOUT = Number(cfg.requestTimeoutMs || 90000);
const MAX_CONCURRENT = Number(cfg.maxConcurrent || 4);
const CACHE_SIZE = Number(cfg.cacheSize || 2000);
function liveUpstreams() { return (cfg.upstreams || []).filter(u => u && u.baseUrl); }

// ---------------------------------------------------------------------------
// LRU 缓存（题目 -> 答案）
// ---------------------------------------------------------------------------
class LRU extends Map {
  constructor(max) {
    super();
    this.max = max;
  }
  get(k) {
    if (!super.has(k)) return undefined;
    const v = super.get(k);
    super.delete(k);
    super.set(k, v); // 触碰移到最新
    return v;
  }
  set(k, v) {
    if (super.has(k)) super.delete(k);
    super.set(k, v);
    if (this.size > this.max) {
      const oldest = super.keys().next().value;
      super.delete(oldest);
    }
    return this;
  }
}
const answerCache = new LRU(CACHE_SIZE);
const failureCount = new Map(); // upstream name -> {fails, until}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
const stats = { total: 0, cacheHit: 0, success: 0, fail: 0, startTime: Date.now() };

// apiKey 打码：仅给设置向导展示用
function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  if (s.length <= 8) return '__MASKED__';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

// ---------------------------------------------------------------------------
// 访问密钥（可选）：config.accessKey 设置后，答题接口需携带
//   header X-Access-Key ｜ URL ?key= ｜ body.accessKey   三选一
// 供把服务端共享给同学/多设备时防滥用。/health 与控制台不鉴权。
// ---------------------------------------------------------------------------
function checkAuth(req, u, body) {
  const need = String(cfg.accessKey || '').trim();
  if (!need) return true;
  const given = (req.headers['x-access-key'] || u.searchParams.get('key') || (body && body.accessKey) || '').trim();
  return given === need;
}
function unauthorized(res) {
  return json(res, 401, { ok: false, code: 401, msg: '访问密钥错误：在服务端地址后加 ?key=密钥，或请求头 X-Access-Key' });
}

// ---------------------------------------------------------------------------
// 每上游统计：name -> { ok, fail, msTotal }
// ---------------------------------------------------------------------------
const upstreamStats = new Map();
function bumpUpstream(name, ok, ms) {
  const s = upstreamStats.get(name) || { ok: 0, fail: 0, msTotal: 0 };
  if (ok) s.ok++; else s.fail++;
  s.msTotal += ms || 0;
  upstreamStats.set(name, s);
}
function upstreamStatsView() {
  return [...upstreamStats.entries()].map(([name, s]) => ({
    name, ok: s.ok, fail: s.fail,
    avgMs: s.ok + s.fail ? Math.round(s.msTotal / (s.ok + s.fail)) : null
  }));
}

// ---------------------------------------------------------------------------
// 上游选择：简单故障隔离，连续失败 3 次熔断 60 秒
// ---------------------------------------------------------------------------
function upstreamAvailable(u) {
  const f = failureCount.get(u.name);
  if (!f) return true;
  if (Date.now() > f.until) {
    failureCount.delete(u.name);
    return true;
  }
  return false;
}

function markFailure(u) {
  const f = failureCount.get(u.name) || { fails: 0, until: 0 };
  f.fails += 1;
  if (f.fails >= 3) {
    f.until = Date.now() + 60_000;
    f.fails = 0;
    console.warn(`[circuit] 上游 [${u.name}] 连续失败，熔断 60s`);
  }
  failureCount.set(u.name, f);
}

function markSuccess(u) {
  failureCount.delete(u.name);
}

function pickUpstreams() {
  const ok = liveUpstreams().filter(upstreamAvailable);
  const list = ok.length ? ok : liveUpstreams(); // 全熔断时死马当活马医
  // 把 vision 能力的排前面（有图片时才会真的用到）
  return list.slice().sort((a, b) => Number(b.vision === true) - Number(a.vision === true));
}

// ---------------------------------------------------------------------------
// HTTP(S) 请求工具
// ---------------------------------------------------------------------------
function httpRequest(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL 无效: ' + urlStr)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: options.method || 'POST',
      headers: options.headers || {},
      timeout: options.timeout || TIMEOUT,
      rejectUnauthorized: false // 允许自签证书的反代
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(new Error('上游请求超时 ' + options.timeout + 'ms')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 构建 OpenAI 协议消息
// ---------------------------------------------------------------------------
function buildMessages(title, options, imagesBase64, type) {
  const TYPE_NAME = { single: '单选题', multi: '多选题', judge: '判断题', completion: '填空题' };
  const parts = [];
  let q = `题型：${TYPE_NAME[(type || '').toLowerCase()] || '未声明（请根据选项数量推断）'}\n题目：${title || '（见图片）'}`;
  if (options && options.length) {
    q += '\n选项：\n' + options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n');
  }
  q += '\n请按系统指令输出 JSON。';

  const userContent = [];
  userContent.push({ type: 'text', text: q });
  for (const b64 of imagesBase64 || []) {
    const dataUrl = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
    userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  return [
    { role: 'system', content: cfg.systemPrompt || '你是答题助手，直接给出正确答案。' },
    { role: 'user', content: imagesBase64 && imagesBase64.length ? userContent : q }
  ];
}

// ---------------------------------------------------------------------------
// 答案解析：让 AI 输出 JSON，失败则从原文里抢
// ---------------------------------------------------------------------------
function parseAnswer(raw, type) {
  if (!raw) return null;
  // 1) 先试标准 JSON
  try {
    const j = JSON.parse(raw);
    if (j && j.answer) return j;
  } catch (_) { /* 继续抢 */ }
  // 2) 从 markdown 代码块里抢
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) {
    try {
      const j = JSON.parse(m[1].trim());
      if (j && j.answer) return j;
    } catch (_) { /* 继续抢 */ }
  }
  // 3) 抢第一个 {...}
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      const j = JSON.parse(brace[0]);
      if (j && j.answer) return j;
    } catch (_) { /* 继续抢 */ }
  }
  // 4) 最后一搏：原文第一行当答案
  const line = raw.trim().split('\n')[0].trim();
  if (line) return { answer: line, reason: '原文截取' };
  return null;
}

/**
 * 按题型规整答案，返回 OCS 兼容格式。
 * 单选/多选统一返回选项数组（与 OCS 自定义题库协议一致），
 * 判断返回 ["正确"/"错误"] 或 ["对"/"错"] 双写提高匹配率。
 */
function normalizeAnswer(parsed, type, options) {
  if (!parsed || !parsed.answer) return null;
  let a = String(parsed.answer).trim();
  const t = (type || 'unknown').toLowerCase();

  const isJudge = /judge|判断|true|false/i.test(t) || (!options.length && /^(对|错|正确|错误|是|否|√|×)/.test(a));
  const isMulti = /multi|多选/i.test(t) || /^[A-Za-z]{2,}$/.test(a);

  if (/single|单选/.test(t) && options.length) {
    const letter = a.match(/[A-Za-z]/);
    if (letter) {
      const idx = letter[0].toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < options.length) return { answer: [options[idx]], reason: parsed.reason || '' };
    }
    return { answer: [a], reason: parsed.reason || '' };
  }

  if (/multi|多选/.test(t) || (isMulti && options.length)) {
    const letters = a.toUpperCase().match(/[A-Z]/g);
    if (letters && options.length) {
      const arr = [...new Set(letters.map(l => l.charCodeAt(0) - 65).filter(i => i >= 0 && i < options.length))]
        .sort((x, y) => x - y)
        .map(i => options[i]);
      if (arr.length) return { answer: arr, reason: parsed.reason || '' };
    }
    return { answer: a.split(/\s*[、,，;；\s]\s*/).filter(Boolean), reason: parsed.reason || '' };
  }

  if (isJudge) {
    if (/对|正确|true|是|√|T$/i.test(a)) return { answer: ['正确', '对', '是', 'true'], reason: parsed.reason || '' };
    if (/错|错误|false|否|×|F$/i.test(a)) return { answer: ['错误', '错', '否', 'false'], reason: parsed.reason || '' };
    // 字母兜底：A/正确，B/错误
    if (/^A$/i.test(a)) return { answer: ['正确', '对', '是', 'true'], reason: parsed.reason || '' };
    if (/^B$/i.test(a)) return { answer: ['错误', '错', '否', 'false'], reason: parsed.reason || '' };
  }

  if (/completion|填空|blank|gap/i.test(t)) {
    return { answer: a.replace(/^["'「『]|["'」』]$/g, ''), reason: parsed.reason || '' };
  }

  // 未声明题型：猜一下
  if (options.length === 2 && /^(对|错|正确|错误|是|否|√|×)/.test(a)) {
    if (/对|正确|是|√|true/i.test(a)) return { answer: ['正确', '对', '是', 'true'], reason: parsed.reason || '' };
    return { answer: ['错误', '错', '否', 'false'], reason: parsed.reason || '' };
  }
  if (options.length && /^[A-Z]{1,6}$/i.test(a)) {
    const letters = a.toUpperCase().match(/[A-Z]/g) || [];
    const arr = [...new Set(letters.map(l => l.charCodeAt(0) - 65).filter(i => i >= 0 && i < options.length))]
      .sort((x, y) => x - y).map(i => options[i]);
    if (arr.length) return { answer: arr, reason: parsed.reason || '' };
  }
  return { answer: a, reason: parsed.reason || '' };
}

// ---------------------------------------------------------------------------
// 并发闸门
// ---------------------------------------------------------------------------
let running = 0;
const queue = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}
function drain() {
  while (running < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    running++;
    fn().then(resolve, reject).finally(() => { running--; drain(); });
  }
}

// ---------------------------------------------------------------------------
// 核心：问 AI 要答案（带多上游重试）
// ---------------------------------------------------------------------------
async function askAI(title, options, imagesBase64, type, depth) {
  depth = depth || 0;
  const upstreams = pickUpstreams();
  if (!upstreams.length) throw new Error('config.json 里没有配置任何 upstream');

  let lastErr = null;
  for (const u of upstreams) {
    const t0 = Date.now();
    try {
      const payload = JSON.stringify({
        model: u.model || 'gpt-4o-mini',
        messages: buildMessages(title, options, imagesBase64, type),
        temperature: 0,
        stream: false,
        max_tokens: 500
      });
      const base = u.baseUrl.replace(/\/+$/, '');
      const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      console.log(`[ai] 上游[${u.name}] ${url} 模型=${u.model} 图片=${(imagesBase64 || []).length}张`);

      const res = await httpRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${u.apiKey || ''}`,
          'User-Agent': 'ocs-ai-answer-server/1.0'
        }
      }, payload);

      if (res.status >= 400) {
        const bodyText = res.body.toString('utf8').slice(0, 300);
        throw new Error(`上游 HTTP ${res.status}: ${bodyText}`);
      }
      const data = JSON.parse(res.body.toString('utf8'));
      const raw = data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content;
      const parsed = parseAnswer(typeof raw === 'string' ? raw : JSON.stringify(raw));
      if (!parsed) throw new Error('AI 返回里解析不到答案: ' + String(raw).slice(0, 200));
      markSuccess(u);
      bumpUpstream(u.name, true, Date.now() - t0);
      parsed._via = u.name;
      parsed._ms = Date.now() - t0;
      return parsed;
    } catch (e) {
      lastErr = e;
      console.warn(`[ai] 上游[${u.name}] 失败: ${e.message}`);
      markFailure(u);
      bumpUpstream(u.name, false, Date.now() - t0);
      await sleep(300);
    }
  }
  throw lastErr || new Error('全部上游失败');
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*'
  });
  res.end(body);
};

function readBody(req, limitMB) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > (limitMB || 20) * 1024 * 1024) { req.destroy(); reject(new Error('body 太大')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  // ---- 首页：调试页面 ----
  if (p === '/' && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'web', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h3>OCS AI 答题服务运行中</h3><p>POST /answer ｜ POST /search/text ｜ POST /search/img</p>');
    }
  }

  // ---- 静态资源（控制台用）----
  if (p.startsWith('/assets/') && req.method === 'GET') {
    const safe = path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(__dirname, 'web', safe);
    if (!file.startsWith(path.join(__dirname, 'web'))) return json(res, 403, { ok: false });
    try {
      const data = fs.readFileSync(file);
      const ext = path.extname(file).toLowerCase();
      const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.css': 'text/css', '.js': 'application/javascript' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(data);
    } catch (_) { return json(res, 404, { ok: false, msg: 'asset not found' }); }
  }

  // ---- 健康检查 ----
  if (p === '/health') {
    return json(res, 200, {
      ok: true, version: '3.2.0', uptime: (Date.now() - stats.startTime) / 1000,
      stats, upstreamStats: upstreamStatsView(),
      accessKeyRequired: !!String(cfg.accessKey || '').trim(),
      upstreams: liveUpstreams().map(x => ({ name: x.name, vision: !!x.vision, circuit: !upstreamAvailable(x) }))
    });
  }

  // ---- 主接口：题目 -> 答案 ----
  if (p === '/answer' && req.method === 'POST') {
    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || '{}');
      if (!checkAuth(req, u, body)) return unauthorized(res);
      const title = String(body.title || body.question || '').trim();
      const options = Array.isArray(body.options) ? body.options.map(String) : [];
      const images = Array.isArray(body.images) ? body.images : [];
      const type = String(body.type || 'unknown');

      if (!title && !images.length) return json(res, 400, { ok: false, msg: 'title 和 images 至少给一个' });

      const key = `${type}|${title}|${options.join('||')}|${images.length}`;
      if (answerCache.has(key)) {
        stats.cacheHit++;
        stats.total++;
        return json(res, 200, { ok: true, cache: true, ...answerCache.get(key) });
      }

      stats.total++;
      const parsed = await withSlot(() => askAI(title, options, images, type));
      const norm = normalizeAnswer(parsed, type, options);
      norm.via = parsed._via; norm.ms = parsed._ms;
      answerCache.set(key, norm);
      stats.success++;
      console.log(`[ok] Q=${title.slice(0, 40)}... A=${Array.isArray(norm.answer) ? norm.answer.join('|') : norm.answer} via=${parsed._via} ${parsed._ms}ms`);
      return json(res, 200, { ok: true, cache: false, ...norm });
    } catch (e) {
      stats.fail++;
      console.error('[err] /answer:', e.message);
      return json(res, 502, { ok: false, msg: e.message });
    }
  }

  // ---- OCS 自定义题库协议兼容 ----
  // 文档: https://docs.ocs.nowo.ai/  自定义题库 request 请求格式
  if (p === '/search/text' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!checkAuth(req, u, body)) return json(res, 200, { code: 201, msg: '访问密钥错误' });
      // OCS 传来的字段: title(题目) options(数组, 选项) type(题型)
      const title = String(body.title || '').trim();
      const options = Array.isArray(body.options) ? body.options.map(String) : [];
      const type = String(body.type || 'unknown');
      if (!title) return json(res, 200, { code: 201, msg: '题目为空' }); // OCS 约定 201=无结果

      const key = `ocs|${type}|${title}|${options.join('||')}`;
      if (answerCache.has(key)) {
        stats.cacheHit++; stats.total++;
        return json(res, 200, { code: 200, ...answerCache.get(key) });
      }
      stats.total++;
      const parsed = await withSlot(() => askAI(title, options, [], type));
      const norm = normalizeAnswer(parsed, type, options);
      answerCache.set(key, norm);
      stats.success++;
      return json(res, 200, { code: 200, ...norm });
    } catch (e) {
      stats.fail++;
      return json(res, 200, { code: 201, msg: e.message }); // OCS 拿到 201 视为无答案
    }
  }

  // ---- OCS AnswererWrapper 专用入口（推荐配合 ocs-tiku-config.json 使用）----
  // 请求体: { title, type, options }  options 可能是 "A的文本,B的文本" 或数组
  // 响应体: { code: 200, answer: [...] }  handler 取 res.answer
  if (p === '/ocs/search' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!checkAuth(req, u, body)) return json(res, 200, { code: 201, msg: '访问密钥错误' });
      const title = String(body.title || body.question || '').trim();
      let options = [];
      if (Array.isArray(body.options)) options = body.options.map(String);
      else if (typeof body.options === 'string' && body.options.trim()) {
        options = body.options.split(/\s*[,，、|#]\s*/).filter(Boolean);
      }
      const type = String(body.type || 'unknown');
      if (!title) return json(res, 200, { code: 201, msg: '题目为空' });

      const key = `ocs|${type}|${title}|${options.join('||')}`;
      if (answerCache.has(key)) {
        stats.cacheHit++; stats.total++;
        return json(res, 200, { code: 200, ...answerCache.get(key) });
      }
      stats.total++;
      const parsed = await withSlot(() => askAI(title, options, [], type));
      const norm = normalizeAnswer(parsed, type, options);
      answerCache.set(key, norm);
      stats.success++;
      console.log(`[ocs] Q=${title.slice(0, 40)}... A=${Array.isArray(norm.answer) ? norm.answer.join('|') : norm.answer}`);
      return json(res, 200, { code: 200, judge: /judge|判断|对错/i.test(type), ...norm });
    } catch (e) {
      stats.fail++;
      return json(res, 200, { code: 201, msg: e.message }); // OCS 拿到非 200 视为无答案
    }
  }

  if (p === '/search/img' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!checkAuth(req, u, body)) return json(res, 200, { code: 201, msg: '访问密钥错误' });
      // OCS 图片题: body.img 或 body.images —— base64 数组
      const imgs = Array.isArray(body.images) ? body.images : (body.img ? [body.img] : []);
      const title = String(body.title || '').trim();
      if (!imgs.length) return json(res, 200, { code: 201, msg: '无图片' });
      stats.total++;
      const parsed = await withSlot(() => askAI(title || '', [], imgs, body.type || 'unknown'));
      const norm = normalizeAnswer(parsed, body.type || 'unknown', Array.isArray(body.options) ? body.options.map(String) : []);
      stats.success++;
      return json(res, 200, { code: 200, ...norm });
    } catch (e) {
      stats.fail++;
      return json(res, 200, { code: 201, msg: e.message });
    }
  }

  // ---- 设置向导：读取/保存配置（可热生效，可落盘） ----
  if (p === '/config' && req.method === 'GET') {
    const safe = { port: PORT, maxConcurrent: MAX_CONCURRENT, systemPrompt: cfg.systemPrompt || '', accessKeySet: !!String(cfg.accessKey || '').trim(), upstreams: liveUpstreams().map(u => ({ name: u.name, baseUrl: u.baseUrl, apiKeyMasked: maskKey(u.apiKey), hasKey: !!u.apiKey, model: u.model, vision: !!u.vision })) };
    return json(res, 200, { ok: true, config: safe, configSavedToDisk: fs.existsSync(CFG_PATH) });
  }

  if (p === '/config' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const incoming = Array.isArray(body.upstreams) ? body.upstreams : null;
      if (!incoming || !incoming.length) return json(res, 400, { ok: false, msg: 'upstreams 不能为空' });
      const cleaned = incoming.map((u, i) => ({
        name: String(u.name || `上游${i + 1}`).slice(0, 60),
        baseUrl: String(u.baseUrl || '').trim().replace(/\/+$/, ''),
        apiKey: String(u.apiKey || '').trim(),
        model: String(u.model || 'gpt-4o-mini').trim(),
        vision: !!u.vision
      })).filter(u => u.baseUrl);
      if (!cleaned.length) return json(res, 400, { ok: false, msg: '至少要有一个有效的 baseUrl' });

      // apiKey 传 masked 值（未修改）则保留旧 key
      const old = liveUpstreams();
      cleaned.forEach((u, i) => {
        if (u.apiKey === '__MASKED__') {
          const match = old.find(o => o.name === u.name && maskKey(o.apiKey) === '__MASKED__');
          u.apiKey = (match || old[i] || {}).apiKey || '';
        }
      });

      cfg.upstreams = cleaned;
      if (typeof body.systemPrompt === 'string' && body.systemPrompt.trim()) cfg.systemPrompt = body.systemPrompt.trim();
      if (body.accessKey !== undefined) cfg.accessKey = String(body.accessKey || '').trim();
      if (Number(body.port) && Number(body.port) !== PORT) {
        return json(res, 400, { ok: false, msg: 'port 修改需编辑 config.json 后重启服务端' });
      }

      let saved = false;
      if (body.saveToDisk) {
        const disk = fs.existsSync(CFG_PATH)
          ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
          : JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
        disk.upstreams = cleaned;
        if (cfg.systemPrompt) disk.systemPrompt = cfg.systemPrompt;
        disk.accessKey = cfg.accessKey || '';
        fs.copyFileSync(CFG_PATH, CFG_PATH + '.backup');
        fs.writeFileSync(CFG_PATH, JSON.stringify(disk, null, 2), 'utf8');
        saved = true;
      }
      console.log(`[config] 上游已更新: ${cleaned.map(u => u.name).join(', ')}${saved ? '（已写入 config.json）' : '（仅本次运行生效）'}${cfg.accessKey ? ' · 访问密钥已启用' : ''}`);
      return json(res, 200, { ok: true, saved, upstreams: cleaned.map(u => ({ name: u.name, baseUrl: u.baseUrl, model: u.model, vision: u.vision })) });
    } catch (e) {
      return json(res, 400, { ok: false, msg: e.message });
    }
  }

  // ---- 上游连通性测试：真实发一道题给指定上游 ----
  if (p === '/test-upstream' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      let target = null;
      if (typeof body.index === 'number') target = liveUpstreams()[body.index];
      else if (body.baseUrl) {
        target = {
          name: '临时测试', baseUrl: String(body.baseUrl).trim().replace(/\/+$/, ''),
          apiKey: String(body.apiKey || '').trim(), model: String(body.model || 'gpt-4o-mini').trim(), vision: true
        };
      }
      if (!target) return json(res, 400, { ok: false, msg: '给 index 或 baseUrl' });
      if (target.apiKey === '__MASKED__') {
        const match = liveUpstreams().find(o => maskKey(o.apiKey) === '__MASKED__');
        target.apiKey = (match || {}).apiKey || '';
      }

      const t0 = Date.now();
      const payload = JSON.stringify({
        model: target.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '输出 JSON：{"answer":"..."}' },
          { role: 'user', content: '1+1=? 只输出 JSON。' }
        ],
        temperature: 0, stream: false, max_tokens: 50
      });
      const base = target.baseUrl.replace(/\/+$/, '');
      const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const res2 = await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${target.apiKey || ''}`, 'User-Agent': 'ocs-ai-answer-server/1.0' }
      }, payload);
      const ms = Date.now() - t0;
      if (res2.status >= 400) {
        return json(res, 200, { ok: false, status: res2.status, ms, msg: `HTTP ${res2.status}: ${res2.body.toString('utf8').slice(0, 200)}` });
      }
      const data = JSON.parse(res2.body.toString('utf8'));
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return json(res, 200, { ok: true, status: 200, ms, model: target.model, reply: String(content || '').slice(0, 100), msg: '连通正常' });
    } catch (e) {
      return json(res, 200, { ok: false, msg: e.message });
    }
  }

  // ---- 简单鉴权探测 ----
  if (p === '/token') return json(res, 200, { code: 200, msg: '无鉴权（本地使用）' });

  json(res, 404, { ok: false, msg: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  OCS AI 反代自动答题服务端 已启动');
  console.log(`  本地调试页:  http://127.0.0.1:${PORT}/`);
  console.log(`  答题接口:    http://127.0.0.1:${PORT}/answer`);
  console.log(`  OCS题库接口: http://127.0.0.1:${PORT}/search/text  |  /search/img`);
  console.log(`  上游数量:    ${liveUpstreams().length}  并发上限: ${MAX_CONCURRENT}`);
  console.log('  下一步: 复制 config.example.json -> config.json 填反代地址');
  console.log('==============================================');
});
