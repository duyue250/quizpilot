// ==UserScript==
// @name         QuizPilot 智答领航
// @name:en      QuizPilot
// @namespace    https://github.com/duyue250/quizpilot
// @version      3.3.0
// @description  网课 AI 答题领航：接入你自己的 AI（官方 Key / 中转站 / 网页版反代均可），整卷扫描、图片题识别、答案卡片、选项高亮。装完填 Key 即用，也支持高级的本地服务端模式。
// @description:en AI quiz assistant for online-course platforms. Bring your own AI (official API key, relay, or self-hosted web reverse proxy): whole-paper scanning, image questions via vision models, answer cards, option highlighting. Works out of the box with just an API key.
// @author       duyue250
// @license      MIT
// @homepageURL  https://github.com/duyue250/quizpilot
// @supportURL   https://github.com/duyue250/quizpilot/issues
// @icon         https://raw.githubusercontent.com/duyue250/quizpilot/main/server/web/assets/logo.svg
// @updateURL    https://raw.githubusercontent.com/duyue250/quizpilot/main/userscript/quizpilot.user.js
// @downloadURL  https://raw.githubusercontent.com/duyue250/quizpilot/main/userscript/quizpilot.user.js
// @match        *://*.chaoxing.com/*
// @match        *://*.xueitong.com/*
// @match        *://*.zhihuishu.com/*
// @match        *://*.icve.com.cn/*
// @match        *://*.xueyinonline.com/*
// @match        *://*.unipus.cn/*
// @match        *://*.welearn.koolearn.com/*
// @match        *://*.koolearn.com/*
// @match        *://*.vlearning.com.cn/*
// @match        *://*.uetc.edu.cn/*
// @match        *://*.edu.cn/*
// @match        *://*.icourse163.org/*
// @match        *://*.yuketang.cn/*
// @match        *://*.xuetangx.com/*
// @match        *://*.courshare.cn/*
// @match        *://*.webtrn.cn/*
// @match        *://*/*
// @exclude      *://*.bank.*/*
// @exclude      *://*.gov.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      *
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

/**
 * QuizPilot 智答领航 v3.1.0（MIT，原创实现）
 * ---------------------------------------------------------------
 * 仓库: https://github.com/duyue250/quizpilot
 * 服务端(必装): 见仓库 README —— node server/ai-answer-server.js
 * ---------------------------------------------------------------
 * v3.3.0: 品牌独立 —— 文案全面去关联化，协同功能改为通用
 *         「同类助手协同」检测；发布通道适配脚本猫
 * v3.2.0: 访问密钥鉴权 / 仅查看模式 / 快捷键 Alt+Q·B·P /
 *         诊断导出 / 答案卡片溯源（上游+耗时）
 * v3.1.0: 发布级打磨 —— 双语元数据、自动更新通道、图标、
 *         面板内仓库链接、错误兜底文案优化
 * v3.0.0: 答案卡片 / 服务状态灯 / 选项高亮 / amber 罗盘品牌
 * v2.x:   整卷批量 / 重试 / 同类助手协同 / 站点开关 / 配置导入导出
 * ---------------------------------------------------------------
 */

(function () {
  'use strict';

  // ========================= 实例互斥（iframe 场景防多实例打架） =========================
  // 顶层窗口优先；iframe 只在顶层没有实例时才接管（处理纯 iframe 答题页）
  try {
    if (window !== window.top) {
      let topHasInstance = false;
      try { topHasInstance = !!(window.top && window.top.__QUIZPILOT_LOADED__); } catch (_) { topHasInstance = false; }
      if (topHasInstance) return;
    }
    window.__QUIZPILOT_LOADED__ = true;
  } catch (_) { /* 跨域访问顶层失败时按普通页面继续 */ }

  // ========================= GM API 安全层（双管理器兼容兜底） =========================
  const gmMenu = typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : (() => {});
  const gmClipboard = typeof GM_setClipboard === 'function'
    ? GM_setClipboard
    : (text => { try { navigator.clipboard.writeText(text); } catch (_) {} });

  // ========================= 存储 =========================
  const store = (() => {
    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    return {
      get: k => hasGM ? GM_getValue(k, undefined) : (() => { try { const v = localStorage.getItem('qp_' + k); return v === null ? undefined : JSON.parse(v); } catch (_) { return undefined; } })(),
      set: (k, v) => hasGM ? GM_setValue(k, v) : (() => { try { localStorage.setItem('qp_' + k, JSON.stringify(v)); } catch (_) {} })()
    };
  })();

  const DEFAULTS = {
    mode: 'direct',          // direct = 直连AI（装完即用）| server = 本地服务端（功能全）
    serverUrl: 'http://127.0.0.1:8787/answer',
    healthUrl: 'http://127.0.0.1:8787/health',
    accessKey: '',           // 服务端访问密钥（服务端 config.accessKey 启用时填）
    aiUrl: 'https://api.deepseek.com/v1',  // 直连：OpenAI 兼容 baseUrl（含 /v1）
    aiKey: '',               // 直连：API Key
    aiModel: 'deepseek-chat',// 直连：模型名
    aiVision: false,         // 直连：模型是否支持图片
    enabled: false,
    autoSubmit: false,
    autoNext: false,
    coexistOcs: true,
    intervalMs: 2000,
    maxImagesPerQuestion: 3,
    imageMaxWidth: 900,
    questionSelector: '',
    batchMode: true,
    retryTimes: 1,
    showCard: true,        // 答案卡片开关
    highlight: true,       // 选项高亮开关
    viewOnly: false,       // 仅查看模式：只弹卡片不点选
    hotkey: true,          // 快捷键开关
    debug: true
  };
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = store.get('cfg_' + k);
    if (v !== undefined) cfg[k] = v;
  }
  const saveCfg = () => { for (const k of Object.keys(DEFAULTS)) store.set('cfg_' + k, cfg[k]); };

  const siteRules = store.get('siteRules') || {};
  const host = location.host;
  const siteEnabled = () => (host in siteRules) ? siteRules[host] : true;

  // ========================= 日志 + 统计 =========================
  const stats = { asked: 0, ok: 0, fail: 0, filled: 0 };
  const logs = [];
  let logBox = null;
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    logs.push(line);
    if (logs.length > 300) logs.shift();
    if (cfg.debug) console.log('%c[QuizPilot]', 'color:#f59e0b;font-weight:bold', msg);
    if (logBox) logBox.textContent = logs.join('\n');
  }

  // ========================= 样式（amber 罗盘体系） =========================
  const css = `
  :root { --qp-bg:#121a2b; --qp-line:#1f2b45; --qp-txt:#e6edf7; --qp-dim:#8aa0c0; --qp-amber:#f59e0b; --qp-amber2:#fbbf24; --qp-ok:#34d399; --qp-bad:#f87171; }
  #qp-fab { position:fixed; right:18px; bottom:18px; z-index:2147483000; width:52px; height:52px; border-radius:50%;
    background:radial-gradient(circle at 30% 30%, #1e2a44, #0d1524); border:2.5px solid var(--qp-amber);
    color:var(--qp-amber2); font-size:12px; display:flex; align-items:center; justify-content:center; cursor:pointer;
    font-weight:bold; box-shadow:0 4px 16px rgba(245,158,11,.25); user-select:none; font-family:"Microsoft YaHei",sans-serif; }
  #qp-fab.on { box-shadow:0 0 18px rgba(245,158,11,.55); border-color:var(--qp-amber2); }
  #qp-fab.paused { border-color:#f87171; color:#f87171; box-shadow:none; }
  #qp-fab .qp-nudge { position:absolute; top:-3px; right:-3px; width:14px; height:14px; border-radius:50%;
    background:#f87171; border:2px solid #0d1524; animation:qpPulse 1.2s ease-in-out infinite; }
  @keyframes qpPulse { 0%,100% { transform:scale(1); opacity:1; } 50% { transform:scale(1.5); opacity:.6; } }
  #qp-panel { position:fixed; right:18px; bottom:80px; z-index:2147483000; width:350px; max-height:74vh; overflow:auto;
    background:var(--qp-bg); color:var(--qp-txt); border:1px solid var(--qp-line); border-radius:14px; padding:14px;
    font-size:13px; box-shadow:0 10px 34px rgba(0,0,0,.55); display:none; font-family:"Microsoft YaHei",sans-serif; }
  #qp-panel h3 { margin:0 0 6px; font-size:15px; color:var(--qp-amber2); display:flex; align-items:center; gap:8px; }
  #qp-panel h4 { margin:12px 0 4px; font-size:12px; color:var(--qp-dim); border-top:1px solid var(--qp-line); padding-top:8px; }
  #qp-panel label { display:block; margin:6px 0 2px; color:var(--qp-dim); font-size:12px; }
  #qp-panel input[type=text], #qp-panel textarea { width:100%; box-sizing:border-box; background:#0a0f1c; color:var(--qp-txt);
    border:1px solid var(--qp-line); border-radius:8px; padding:6px 9px; font-size:12px; }
  #qp-panel textarea { min-height:64px; resize:vertical; }
  #qp-panel .btn { display:inline-block; background:var(--qp-amber); color:#1a1206; font-weight:bold; border:0; border-radius:8px;
    padding:5px 11px; margin:4px 4px 0 0; cursor:pointer; font-size:12px; }
  #qp-panel .btn.ghost { background:transparent; color:var(--qp-dim); border:1px solid var(--qp-line); font-weight:normal; }
  #qp-panel .btn.red { background:transparent; color:var(--qp-bad); border:1px solid var(--qp-bad); font-weight:normal; }
  #qp-panel .row { display:flex; align-items:center; gap:6px; margin-top:6px; font-size:12px; flex-wrap:wrap; }
  #qp-panel .stat { display:flex; gap:10px; margin-top:6px; font-size:11px; color:var(--qp-dim); }
  #qp-panel .stat b { color:var(--qp-txt); }
  #qp-log { background:#070b14; color:var(--qp-ok); font-family:Consolas,monospace; font-size:11px; padding:8px;
    border-radius:8px; max-height:150px; overflow:auto; white-space:pre-wrap; margin-top:8px; border:1px solid var(--qp-line); }
  #qp-dot { width:9px; height:9px; border-radius:50%; background:var(--qp-bad); display:inline-block; }
  #qp-dot.on { background:var(--qp-ok); box-shadow:0 0 6px var(--qp-ok); }
  /* 服务状态灯 + 选项高亮 + 答案卡片 */
  .qp-hl { outline:2.5px solid var(--qp-amber) !important; outline-offset:1px; border-radius:4px;
    background:rgba(245,158,11,.10) !important; transition:outline .2s; }
  .qp-hl-label::after { content:'✈ 智答'; font-size:10px; color:#1a1206; background:var(--qp-amber); border-radius:4px;
    padding:0 5px; margin-left:6px; font-weight:bold; vertical-align:middle; }
  #qp-card { position:fixed; right:18px; bottom:80px; z-index:2147483001; width:320px; background:var(--qp-bg);
    color:var(--qp-txt); border:1px solid var(--qp-line); border-left:4px solid var(--qp-amber); border-radius:12px;
    padding:12px 14px; font-size:13px; box-shadow:0 10px 34px rgba(0,0,0,.55); display:none;
    font-family:"Microsoft YaHei",sans-serif; }
  #qp-card .q { color:var(--qp-dim); font-size:12px; max-height:64px; overflow:auto; margin-bottom:6px; }
  #qp-card .a { font-size:16px; color:var(--qp-amber2); font-weight:bold; margin-bottom:4px; }
  #qp-card .r { font-size:11px; color:var(--qp-dim); }
  #qp-card .tools { margin-top:8px; display:flex; gap:8px; }
  #qp-card .tools button { background:transparent; color:var(--qp-dim); border:1px solid var(--qp-line);
    border-radius:6px; padding:3px 10px; font-size:11px; cursor:pointer; }
  #qp-card .close { position:absolute; top:8px; right:10px; cursor:pointer; color:var(--qp-dim); font-size:14px; }
  `;
  function addStyle(text) {
    if (typeof GM_addStyle === 'function') return GM_addStyle(text);
    const s = document.createElement('style');
    s.textContent = text;
    document.head.appendChild(s);
  }

  // ========================= UI =========================
  let fab, panel, card, healthDot;

  function buildUI() {
    if (document.getElementById('qp-fab')) return;
    addStyle(css);

    fab = document.createElement('div');
    fab.id = 'qp-fab';
    fab.innerHTML = svgCompass(30);
    fab.title = 'QuizPilot 智答领航';
    document.body.appendChild(fab);

    // 答案卡片
    card = document.createElement('div');
    card.id = 'qp-card';
    card.innerHTML = `<span class="close" id="qp-card-x">✕</span>
      <div class="q" id="qp-card-q"></div>
      <div class="a" id="qp-card-a"></div>
      <div class="r" id="qp-card-r"></div>
      <div class="tools"><button id="qp-card-copy">复制答案</button><button id="qp-card-hide">下次不再弹</button></div>`;
    document.body.appendChild(card);
    document.getElementById('qp-card-x').onclick = () => card.style.display = 'none';
    document.getElementById('qp-card-hide').onclick = () => { cfg.showCard = false; saveCfg(); card.style.display = 'none'; log('答案卡片已关闭（面板可重开）'); };
    document.getElementById('qp-card-copy').onclick = () => {
      const t = document.getElementById('qp-card-a').textContent;
      if (typeof GM_setClipboard === 'function') GM_setClipboard(t); else navigator.clipboard?.writeText(t);
    };

    panel = document.createElement('div');
    panel.id = 'qp-panel';
    panel.innerHTML = `
      <h3>${svgCompass(18)} QuizPilot 智答领航 <span style="font-size:10px;color:var(--qp-dim)">v3.3.0</span>
        <span style="flex:1"></span><span id="qp-dot"></span></h3>
      <div class="row" style="color:var(--qp-dim);font-size:11px"><span id="qp-health-text">AI 状态检测中…</span>
        <span style="flex:1"></span><a href="https://github.com/duyue250/quizpilot" target="_blank" style="color:var(--qp-amber2);font-size:11px">GitHub ↗</a></div>

      <h4>第一步：接入你的 AI</h4>
      <div class="row" style="gap:4px;flex-wrap:nowrap">
        <label style="margin:0;flex:1"><input type="radio" name="qp-mode" value="direct" ${cfg.mode !== 'server' ? 'checked' : ''}> <b>直连 AI</b>（填 Key 即用）</label>
        <label style="margin:0;flex:1"><input type="radio" name="qp-mode" value="server" ${cfg.mode === 'server' ? 'checked' : ''}> 本地服务端（高级）</label>
      </div>
      <div id="qp-direct-form">
        <label>AI 接口地址（OpenAI 兼容，一般以 /v1 结尾）</label>
        <input type="text" id="qp-cfg-aiurl" value="${cfg.aiUrl}" placeholder="https://api.deepseek.com/v1">
        <label>API Key（官方 Key / 中转站 Key / 自建反代的 Key）</label>
        <input type="text" id="qp-cfg-aikey" value="${cfg.aiKey}" placeholder="sk-...">
        <div class="row" style="gap:8px">
          <div style="flex:2"><label>模型名</label><input type="text" id="qp-cfg-aimodel" value="${cfg.aiModel}" placeholder="deepseek-chat"></div>
          <div style="flex:1"><label>&nbsp;</label><label style="margin-top:12px"><input type="checkbox" id="qp-cfg-aivision" ${cfg.aiVision ? 'checked' : ''}> 能看图</label></div>
        </div>
        <div class="row"><button class="btn" id="qp-btn-aitest">测试连通</button><span id="qp-aitest-out" style="color:var(--qp-dim);font-size:11px;flex:1"></span></div>
        <div class="row" style="color:var(--qp-dim);font-size:11px;margin-top:4px">
          常用直达：DeepSeek官方 api.deepseek.com/v1 ｜ 豆包/Kimi/智谱等中转填对应地址 ｜ 网页版反代填反代地址
        </div>
      </div>
      <div id="qp-server-form" style="display:none">
        <label>服务端地址</label>
        <input type="text" id="qp-cfg-server" value="${cfg.serverUrl}">
        <label>访问密钥（服务端启用 accessKey 时填写，可留空）</label>
        <input type="text" id="qp-cfg-accesskey" value="${cfg.accessKey}">
        <div class="row" style="color:var(--qp-dim);font-size:11px">服务端模式：多上游切换/缓存/统计更全，部署见仓库 README</div>
      </div>

      <h4>答题设置</h4>
      <label>自定义题目容器选择器（可选）</label>
      <input type="text" id="qp-cfg-selector" value="${cfg.questionSelector}">
      <div class="row"><input type="checkbox" id="qp-cfg-enabled" ${cfg.enabled ? 'checked' : ''}><span>自动答题（全局）</span></div>
      <div class="row"><input type="checkbox" id="qp-cfg-batch" ${cfg.batchMode ? 'checked' : ''}><span>整卷批量模式</span></div>
      <div class="row"><input type="checkbox" id="qp-cfg-card" ${cfg.showCard ? 'checked' : ''}><span>答案弹出卡片</span></div>
      <div class="row"><input type="checkbox" id="qp-cfg-hl" ${cfg.highlight ? 'checked' : ''}><span>命中选项高亮</span></div>
      <div class="row"><input type="checkbox" id="qp-cfg-viewonly" ${cfg.viewOnly ? 'checked' : ''}><span>仅查看模式（只弹卡片，不自动点选）</span></div>
      <div class="row"><input type="checkbox" id="qp-cfg-submit" ${cfg.autoSubmit ? 'checked' : ''}><span>答完自动提交（谨慎）</span></div>
      <div class="row"><input type="checkbox" id="qp-cfg-next" ${cfg.autoNext ? 'checked' : ''}><span>提交后自动下一题</span></div>
      <div class="row"><input type="checkbox" id="qp-cfg-ocs" ${cfg.coexistOcs ? 'checked' : ''}><span>同类助手协同（检测到其他答题助手时待机）</span></div>
      <div class="row"><input type="checkbox" id="qp-cfg-hotkey" ${cfg.hotkey ? 'checked' : ''}><span>快捷键：Alt+Q 开关自动 / Alt+B 整卷一轮 / Alt+P 仅查看</span></div>
      <div class="row">
        <span style="color:var(--qp-dim)">本站（${host}）：</span>
        <button class="btn ghost" id="qp-btn-siteon">启用本站</button>
        <button class="btn red" id="qp-btn-siteoff">禁用本站</button>
        <span id="qp-sitestate" style="color:var(--qp-dim)"></span>
      </div>
      <div class="stat">
        <span>已问 <b id="qp-s1">0</b></span><span>成功 <b id="qp-s2">0</b></span>
        <span>失败 <b id="qp-s3">0</b></span><span>已填 <b id="qp-s4">0</b></span>
      </div>
      <h4>操作</h4>
      <div class="row">
        <button class="btn" id="qp-btn-save">保存配置</button>
        <button class="btn" id="qp-btn-once">抓当前题</button>
        <button class="btn" id="qp-btn-batch">整卷答一轮</button>
        <button class="btn ghost" id="qp-btn-reset">清已答记忆</button>
      </div>
      <h4>配置导入 / 导出</h4>
      <textarea id="qp-cfg-json" placeholder="导出生成 JSON；粘贴 JSON 后点导入"></textarea>
      <div class="row">
        <button class="btn ghost" id="qp-btn-export">导出</button>
        <button class="btn ghost" id="qp-btn-import">导入</button>
        <button class="btn ghost" id="qp-btn-copylog">复制日志</button>
        <button class="btn ghost" id="qp-btn-diag">导出诊断</button>
        <button class="btn ghost" id="qp-btn-clear">清日志</button>
      </div>
      <div id="qp-log"></div>
    `;
    document.body.appendChild(panel);
    logBox = document.getElementById('qp-log');

    fab.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
      refreshUI();
    });

    // 模式切换显示
    const syncModeUI = () => {
      const m = document.querySelector('input[name=qp-mode]:checked')?.value || 'direct';
      document.getElementById('qp-direct-form').style.display = m === 'direct' ? '' : 'none';
      document.getElementById('qp-server-form').style.display = m === 'server' ? '' : 'none';
    };
    document.querySelectorAll('input[name=qp-mode]').forEach(r => r.addEventListener('change', syncModeUI));
    syncModeUI();

    // 直连连通测试：真实发一道题
    document.getElementById('qp-btn-aitest').addEventListener('click', async () => {
      const out = document.getElementById('qp-aitest-out');
      const url = document.getElementById('qp-cfg-aiurl').value.trim().replace(/\/+$/, '');
      const key = document.getElementById('qp-cfg-aikey').value.trim();
      const model = document.getElementById('qp-cfg-aimodel').value.trim() || 'gpt-4o-mini';
      if (!url || !key) { out.textContent = '先填地址和 Key'; return; }
      out.textContent = '测试中…';
      const t0 = Date.now();
      const r = await directChat([
        { role: 'system', content: '输出 JSON：{"answer":"..."}' },
        { role: 'user', content: '1+1=? 只输出 JSON。' }
      ], { url, key, model });
      const ms = Date.now() - t0;
      out.innerHTML = r.ok
        ? `<span class="ok" style="color:var(--qp-ok)">✔ ${ms}ms · 回复: ${String(r.reply).slice(0, 40)}</span>`
        : `<span style="color:var(--qp-bad)">✘ ${r.msg}</span>`;
    });

    document.getElementById('qp-btn-save').addEventListener('click', () => {
      cfg.mode = document.querySelector('input[name=qp-mode]:checked')?.value || 'direct';
      cfg.aiUrl = document.getElementById('qp-cfg-aiurl').value.trim().replace(/\/+$/, '') || DEFAULTS.aiUrl;
      cfg.aiKey = document.getElementById('qp-cfg-aikey').value.trim();
      cfg.aiModel = document.getElementById('qp-cfg-aimodel').value.trim() || 'gpt-4o-mini';
      cfg.aiVision = document.getElementById('qp-cfg-aivision').checked;
      cfg.serverUrl = document.getElementById('qp-cfg-server').value.trim() || DEFAULTS.serverUrl;
      cfg.healthUrl = cfg.serverUrl.replace(/\/answer$/, '/health');
      cfg.accessKey = document.getElementById('qp-cfg-accesskey').value.trim();
      cfg.questionSelector = document.getElementById('qp-cfg-selector').value.trim();
      cfg.enabled = document.getElementById('qp-cfg-enabled').checked;
      cfg.batchMode = document.getElementById('qp-cfg-batch').checked;
      cfg.showCard = document.getElementById('qp-cfg-card').checked;
      cfg.highlight = document.getElementById('qp-cfg-hl').checked;
      cfg.viewOnly = document.getElementById('qp-cfg-viewonly').checked;
      cfg.autoSubmit = document.getElementById('qp-cfg-submit').checked;
      cfg.autoNext = document.getElementById('qp-cfg-next').checked;
      cfg.coexistOcs = document.getElementById('qp-cfg-ocs').checked;
      cfg.hotkey = document.getElementById('qp-cfg-hotkey').checked;
      saveCfg(); log(`配置已保存（${cfg.mode === 'direct' ? '直连 ' + cfg.aiUrl : '服务端 ' + cfg.serverUrl}）${cfg.viewOnly ? ' · 仅查看模式' : ''}`); refreshUI();
    });
    document.getElementById('qp-btn-siteon').addEventListener('click', () => { siteRules[host] = true; store.set('siteRules', siteRules); refreshUI(); log(`本站已启用：${host}`); });
    document.getElementById('qp-btn-siteoff').addEventListener('click', () => { siteRules[host] = false; store.set('siteRules', siteRules); refreshUI(); log(`本站已禁用：${host}`); });

    document.getElementById('qp-btn-once').addEventListener('click', async () => {
      const q = detectQuestion();
      if (!q) return log('没抓到题目：可尝试填写自定义选择器');
      log(`抓到题：${(q.title || '(图片题)').slice(0, 50)} | 选项${q.options.length} | 图${q.images.length} | ${q.type}`);
      await prepareImages(q);
      const r = await answerQuestion(q);
      if (r && r.ok) { showCard(q, r); if (!cfg.viewOnly) fillAnswer(q, r.answer); }
      else log('✘ ' + (r && r.msg));
    });
    document.getElementById('qp-btn-batch').addEventListener('click', () => runBatch(true));
    document.getElementById('qp-btn-reset').addEventListener('click', () => { answered.clear(); failedOnce.clear(); log('已清空已答记忆'); });

    document.getElementById('qp-btn-export').addEventListener('click', () => { document.getElementById('qp-cfg-json').value = JSON.stringify(cfg, null, 2); log('配置已导出'); });
    document.getElementById('qp-btn-import').addEventListener('click', () => {
      try {
        const j = JSON.parse(document.getElementById('qp-cfg-json').value);
        for (const k of Object.keys(DEFAULTS)) if (k in j) cfg[k] = j[k];
        saveCfg(); log('配置已导入'); refreshUI();
      } catch (e) { log('导入失败：' + e.message); }
    });
    document.getElementById('qp-btn-copylog').addEventListener('click', () => {
      const text = logs.join('\n');
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text); log('日志已复制'); }
      else navigator.clipboard?.writeText(text).then(() => log('日志已复制')).catch(() => {});
    });
    document.getElementById('qp-btn-diag').addEventListener('click', () => {
      const diag = {
        time: new Date().toISOString(),
        url: location.href, host,
        version: '3.2.0',
        serverUrl: cfg.serverUrl,
        serverOnline: svcOnline, serverDetail: svcDetail,
        stats, cfg: { ...cfg, accessKey: cfg.accessKey ? '(已填)' : '' },
        pageStats: { questions: detectAllQuestions().length, radios: document.querySelectorAll('input[type=radio]').length, checkboxes: document.querySelectorAll('input[type=checkbox]').length },
        assistantDetected: detectOcs(),
        recentLogs: logs.slice(-30)
      };
      const text = JSON.stringify(diag, null, 2);
      document.getElementById('qp-cfg-json').value = text;
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text);
      log('诊断信息已生成到配置框并复制剪贴板（提 issue 时附上）');
    });
    document.getElementById('qp-btn-clear').addEventListener('click', () => { logs.length = 0; if (logBox) logBox.textContent = ''; });

    refreshUI();
  }

  function svgCompass(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" style="vertical-align:middle">
      <circle cx="32" cy="32" r="27" fill="none" stroke="#f59e0b" stroke-width="4"/>
      <circle cx="32" cy="32" r="20" fill="none" stroke="#1f2b45" stroke-width="2"/>
      <polygon points="32,32 44,14 35,29" fill="#fbbf24"/>
      <polygon points="32,32 20,50 29,35" fill="#31415f"/>
      <circle cx="32" cy="32" r="3.4" fill="#fbbf24" stroke="#121a2b" stroke-width="1.4"/>
    </svg>`;
  }

  function aiConfigured() {
    return cfg.mode === 'server' ? true : !!(cfg.aiUrl && cfg.aiKey);
  }

  function refreshUI() {
    if (!fab) return;
    // 首次引导：AI 未配置 → 悬浮球红点脉冲
    const needsSetup = !aiConfigured();
    const nudge = fab.querySelector('.qp-nudge');
    if (needsSetup && !nudge) {
      const d = document.createElement('div');
      d.className = 'qp-nudge';
      fab.appendChild(d);
      fab.title = 'QuizPilot 智答领航 — 点开面板，第一步填 AI Key';
    } else if (!needsSetup && nudge) {
      nudge.remove();
      fab.title = 'QuizPilot 智答领航';
    }
    const pausedByAssistant = cfg.coexistOcs && detectOcs();
    const active = cfg.enabled && siteEnabled() && !pausedByAssistant;
    fab.className = active ? 'on' : (pausedByAssistant ? 'paused' : '');
    const s = document.getElementById('qp-sitestate');
    if (s) s.textContent = siteEnabled() ? '已启用' : '已禁用';
    for (const [id, key] of [['qp-s1', 'asked'], ['qp-s2', 'ok'], ['qp-s3', 'fail'], ['qp-s4', 'filled']]) {
      const el = document.getElementById(id);
      if (el) el.textContent = stats[key];
    }
    const map = { 'qp-cfg-enabled': 'enabled', 'qp-cfg-batch': 'batchMode', 'qp-cfg-card': 'showCard', 'qp-cfg-hl': 'highlight', 'qp-cfg-viewonly': 'viewOnly', 'qp-cfg-submit': 'autoSubmit', 'qp-cfg-next': 'autoNext', 'qp-cfg-ocs': 'coexistOcs', 'qp-cfg-hotkey': 'hotkey' };
    for (const [id, key] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.checked = cfg[key];
    }
    if (!cfg.showCard && card) card.style.display = 'none';
  }

  // ========================= AI 状态监测（双模式） =========================
  let svcOnline = false;
  let svcDetail = '';
  function checkHealth() {
    if (cfg.mode !== 'server') {
      // 直连模式：有 Key 就绪，Key 不发探测请求（省 token）
      svcOnline = !!(cfg.aiUrl && cfg.aiKey);
      svcDetail = svcOnline ? `直连就绪 · ${cfg.aiModel} @ ${cfg.aiUrl.replace(/^https?:\/\//, '').slice(0, 30)}` : '直连未配置：面板里填 AI 地址和 Key';
      paintHealth();
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET', url: cfg.healthUrl || cfg.serverUrl.replace(/\/answer$/, '/health'), timeout: 6000,
      onload: r => {
        try {
          const j = JSON.parse(r.responseText);
          svcOnline = j.ok === true;
          const ups = (j.upstreams || []).map(u => `${u.name}${u.circuit ? '(熔断)' : ''}`).join('、') || '无上游';
          svcDetail = `在线 · 成功${j.stats.success}/失败${j.stats.fail}/缓存${j.stats.cacheHit} · 上游: ${ups}`;
        } catch (_) { svcOnline = false; svcDetail = '返回异常'; }
        paintHealth();
      },
      onerror: () => { svcOnline = false; svcDetail = '离线 —— 请启动 start-server.bat'; paintHealth(); },
      ontimeout: () => { svcOnline = false; svcDetail = '超时'; paintHealth(); }
    });
  }
  function paintHealth() {
    const dot = document.getElementById('qp-dot');
    const txt = document.getElementById('qp-health-text');
    if (dot) dot.className = svcOnline ? 'on' : '';
    if (txt) { txt.textContent = svcDetail || (svcOnline ? '在线' : '离线'); txt.style.color = svcOnline ? 'var(--qp-ok)' : 'var(--qp-bad)'; }
  }

  // ========================= 答案卡片 =========================
  function showCard(q, result) {
    if (!cfg.showCard || !card) return;
    document.getElementById('qp-card-q').textContent = q.title || '(图片题)';
    const a = Array.isArray(result.answer) ? result.answer.join(' | ') : String(result.answer);
    const meta = [];
    if (result.via) meta.push('上游: ' + result.via);
    if (result.ms) meta.push(result.ms + 'ms');
    if (result.cache) meta.push('缓存');
    document.getElementById('qp-card-a').textContent = '✈ ' + a;
    document.getElementById('qp-card-r').textContent = [(result.reason || ''), meta.join(' · ')].filter(Boolean).join(' ｜ ');
    card.style.display = 'block';
    clearTimeout(showCard._t);
    showCard._t = setTimeout(() => { card.style.display = 'none'; }, 12000);
  }

  // ========================= 同类助手检测 =========================
  function detectOcs() {
    if (!cfg.coexistOcs) return false;
    const el = document.querySelector('[class*="question-guide"], [id*="answer-panel"], [class*="tiku"], [class*="answer-card"]');
    if (el && !detectOcs._logged) {
      detectOcs._logged = true;
      log('检测到其他答题助手，QuizPilot 待机（协同模式）。面板可关闭协同接管。');
    }
    return !!el;
  }

  // ========================= 平台规则 =========================
  const PLATFORM_RULES = [
    {
      name: 'chaoxing',
      question: '.TiMu, .questionLi, .timu-item',
      title: '.Zy_TItle, .qtContent, .Cy_TItle, .fontLabel, .title',
      options: '.answerList li, .Zy_ulPy li, ul li[data-type], .option-item, .answerCard .list li',
      optionText: '.num_option, .after, .fl'
    },
    {
      name: 'zhihuishu',
      question: '.question-item, .exam-question, .ti-item, .topic-item',
      title: '.question-title, .topic-title, .desc, .topic-content',
      options: '.option-item, .op-item, li.option, .topic-option, .option',
      optionText: ''
    },
    {
      name: 'icve',
      question: '.questionItem, .exam-question-item, .queType',
      title: '.questionContent, .queStem, .stem',
      options: '.questionOption li, .optionList li, label.optionItem',
      optionText: ''
    },
    {
      name: 'xueyin',
      question: '.exam-question, .question-wrapper, .q-container',
      title: '.question-stem, .q-text, .stem',
      options: '.choice-item, .option-row, label',
      optionText: ''
    },
    {
      name: 'paper',
      question: '.question, .q-item, .exam-item, .que-item, div[id^="question"]',
      title: '.stem, .q-title, .question-text, h3',
      options: '.opt, .choice, label:has(input[type=radio]), label:has(input[type=checkbox])',
      optionText: ''
    }
  ];

  function textOf(el) { return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function pickImages(container) {
    return [...container.querySelectorAll('img')]
      .filter(im => {
        if (!im.src || im.src.startsWith('data:image/svg')) return false;
        const r = im.getBoundingClientRect();
        return r.width > 30 && r.height > 20;
      })
      .slice(0, cfg.maxImagesPerQuestion)
      .map(im => im.src);
  }

  function extractFrom(container, platform, rule) {
    rule = rule || PLATFORM_RULES.find(r => r.name === platform) || {};
    let title = '';
    if (rule.title) { const t = container.querySelector(rule.title); title = textOf(t); }
    if (!title) title = textOf(container).split(/A[.、．]/)[0].trim();

    let type = 'unknown';
    const radios = [...container.querySelectorAll('input[type=radio]')];
    const checks = [...container.querySelectorAll('input[type=checkbox]')];
    const containerText = textOf(container);
    if (/判断|对错|正确.{0,4}错误|错误.{0,4}正确/.test(title) || (radios.length === 2 && /对|错|正确|错误|是|否/.test(containerText))) type = 'judge';
    else if (checks.length) type = 'multi';
    else if (radios.length) type = 'single';
    else if (container.querySelector('textarea, input[type=text]')) type = 'completion';

    const options = [];
    let optionEls = [];
    if (rule.options) { try { optionEls = [...container.querySelectorAll(rule.options)]; } catch (_) {} }
    if (!optionEls.length) optionEls = [...container.querySelectorAll('li, label')].filter(el => /^[A-Z][.、．．]/.test(textOf(el)));
    optionEls.forEach(el => {
      if (!isVisible(el)) return;
      let t = textOf(el);
      if (rule.optionText) { const sub = el.querySelector(rule.optionText); if (sub && textOf(sub).length > 1) t = textOf(sub); }
      t = t.replace(/^[A-Z][.、．．]\s*/, '').trim();
      if (t && t.length < 200 && !options.includes(t)) options.push(t);
    });
    if (type === 'judge' && options.length === 0) {
      if (/对|正确/.test(containerText) && /错|错误/.test(containerText)) options.push('正确', '错误');
    }
    return { title, options, images: pickImages(container), type, container, platform };
  }

  function detectQuestion() {
    if (cfg.questionSelector) {
      const c = document.querySelector(cfg.questionSelector);
      if (c && isVisible(c)) return extractFrom(c, 'custom');
    }
    for (const rule of PLATFORM_RULES) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(rule.question)]; } catch (_) {}
      const visible = nodes.filter(isVisible);
      if (visible.length) {
        const q = extractFrom(visible[visible.length - 1], rule.name, rule);
        if (q && (q.title || q.images.length)) return q;
      }
    }
    const radio = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')].filter(isVisible);
    if (radio.length) {
      let p = radio[0].closest('li,div');
      for (let i = 0; i < 4 && p && p.parentElement; i++) { if (textOf(p).length > 20) break; p = p.parentElement; }
      if (p) return extractFrom(p, 'fallback');
    }
    return null;
  }

  function detectAllQuestions() {
    const out = [];
    if (cfg.questionSelector) {
      [...document.querySelectorAll(cfg.questionSelector)].forEach(c => out.push(extractFrom(c, 'custom')));
      return out.filter(q => q.title || q.images.length);
    }
    for (const rule of PLATFORM_RULES) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(rule.question)]; } catch (_) {}
      if (nodes.length) {
        nodes.forEach(c => { const q = extractFrom(c, rule.name, rule); if (q && (q.title || q.images.length)) out.push(q); });
        if (out.length) return out;
      }
    }
    return out;
  }

  // ========================= 图片抓取 =========================
  function fetchImageAsDataUrl(src) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET', url: src, responseType: 'blob', timeout: 15000,
        onload: r => {
          if (r.status !== 200 || !r.response) return resolve(null);
          const img = new Image();
          const url = URL.createObjectURL(r.response);
          img.onload = () => {
            try {
              const scale = Math.min(1, cfg.imageMaxWidth / img.width);
              const canvas = document.createElement('canvas');
              canvas.width = Math.round(img.width * scale);
              canvas.height = Math.round(img.height * scale);
              canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
              resolve(canvas.toDataURL('image/jpeg', 0.85));
            } catch (_) { resolve(null); }
            URL.revokeObjectURL(url);
          };
          img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
          img.src = url;
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null)
      });
    });
  }
  async function prepareImages(q) {
    if (!q.images || !q.images.length) { q.imageDataUrls = []; return; }
    const datas = [];
    for (const src of q.images) { const d = await fetchImageAsDataUrl(src); if (d) datas.push(d); }
    q.imageDataUrls = datas;
    if (datas.length) log(`图片已抓取 ${datas.length}/${q.images.length} 张`);
  }

  // ========================= 直连 AI（无需服务端） =========================
  function directChat(messages, opt, timeout) {
    opt = opt || {};
    const url = (opt.url || cfg.aiUrl || '').replace(/\/+$/, '');
    const key = opt.key !== undefined ? opt.key : cfg.aiKey;
    const model = opt.model || cfg.aiModel || 'gpt-4o-mini';
    const full = /\/v\d+$/.test(url) ? url + '/chat/completions' : url + '/v1/chat/completions';
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST', url: full,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        data: JSON.stringify({ model, messages, temperature: 0, stream: false, max_tokens: 500 }),
        timeout: timeout || 90000,
        onload: r => {
          if (r.status === 401) return resolve({ ok: false, msg: 'Key 无效或过期 (401)' });
          if (r.status === 429) return resolve({ ok: false, msg: '触发限流 (429)，稍后再试' });
          if (r.status >= 400) return resolve({ ok: false, msg: 'HTTP ' + r.status + ': ' + r.responseText.slice(0, 120) });
          try {
            const j = JSON.parse(r.responseText);
            const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            resolve({ ok: true, reply: typeof content === 'string' ? content : JSON.stringify(content) });
          } catch (e) { resolve({ ok: false, msg: '返回解析失败: ' + e.message }); }
        },
        onerror: () => resolve({ ok: false, msg: '网络错误/地址不对（注意中转站是否允许浏览器跨域，反代站一般都允许）' }),
        ontimeout: () => resolve({ ok: false, msg: '请求超时' })
      });
    });
  }

  const QP_SYSTEM_PROMPT = '你是网课答题助手。根据题目、选项和图片给出正确答案。规则：单选题只输出一个选项字母；多选题只输出多个字母连写（如 ABD）；判断题只输出「对」或「错」；填空题只输出要填写的文本本身。如果提供了题目截图，以截图内容为准。最终必须输出一个 JSON 对象：{"answer":"...","reason":"一句话理由"}';

  function buildDirectMessages(q) {
    const TYPE_NAME = { single: '单选题', multi: '多选题', judge: '判断题', completion: '填空题' };
    let text = `题型：${TYPE_NAME[q.type] || '未声明（请根据选项数量推断）'}\n题目：${q.title || '（见图片）'}`;
    if (q.options && q.options.length) {
      text += '\n选项：\n' + q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n');
    }
    text += '\n请按系统指令输出 JSON。';
    const msgs = [{ role: 'system', content: QP_SYSTEM_PROMPT }];
    if (q.imageDataUrls && q.imageDataUrls.length) {
      const content = [{ type: 'text', text }];
      for (const d of q.imageDataUrls) content.push({ type: 'image_url', image_url: { url: d } });
      msgs.push({ role: 'user', content });
    } else {
      msgs.push({ role: 'user', content: text });
    }
    return msgs;
  }

  // 从 AI 原文抢 JSON 答案（与服务端 parseAnswer 同逻辑的轻量版）
  function parseDirectAnswer(raw) {
    if (!raw) return null;
    try { const j = JSON.parse(raw); if (j && j.answer) return j; } catch (_) {}
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m) { try { const j = JSON.parse(m[1].trim()); if (j && j.answer) return j; } catch (_) {} }
    const brace = raw.match(/\{[\s\S]*\}/);
    if (brace) { try { const j = JSON.parse(brace[0]); if (j && j.answer) return j; } catch (_) {} }
    const line = raw.trim().split('\n')[0].trim();
    return line ? { answer: line } : null;
  }

  // 按题型规整（与服务端 normalizeAnswer 同逻辑的轻量版）
  function normalizeDirectAnswer(parsed, type, options) {
    let a = String(parsed.answer || '').trim();
    const t = (type || '').toLowerCase();
    if (/single|单选/.test(t) && options.length) {
      const L = a.match(/[A-Za-z]/);
      if (L) { const i = L[0].toUpperCase().charCodeAt(0) - 65; if (i >= 0 && i < options.length) return [options[i]]; }
      return [a];
    }
    if (/multi|多选/.test(t)) {
      const letters = a.toUpperCase().match(/[A-Z]/g) || [];
      const arr = [...new Set(letters.map(l => l.charCodeAt(0) - 65).filter(i => i >= 0 && i < options.length))].sort((x, y) => x - y).map(i => options[i]);
      if (arr.length) return arr;
      return a.split(/\s*[、,，;；\s]\s*/).filter(Boolean);
    }
    if (/judge|判断/.test(t)) {
      if (/对|正确|true|是|√/i.test(a)) return ['正确', '对', '是', 'true'];
      if (/错|错误|false|否|×/i.test(a)) return ['错误', '错', '否', 'false'];
      if (/^A$/i.test(a)) return ['正确', '对', '是', 'true'];
      if (/^B$/i.test(a)) return ['错误', '错', '否', 'false'];
      return [a];
    }
    if (/completion|填空/.test(t)) return [a.replace(/^["'「『]|["'」』]$/g, '')];
    // 未声明题型：猜
    if (options.length === 2 && /^(对|错|正确|错误|是|否)/.test(a)) {
      return /对|正确|是|√|true/i.test(a) ? ['正确', '对', '是', 'true'] : ['错误', '错', '否', 'false'];
    }
    if (options.length && /^[A-Z]{1,6}$/i.test(a)) {
      const letters = a.toUpperCase().match(/[A-Z]/g) || [];
      const arr = [...new Set(letters.map(l => l.charCodeAt(0) - 65).filter(i => i >= 0 && i < options.length))].sort((x, y) => x - y).map(i => options[i]);
      if (arr.length) return arr;
    }
    return [a];
  }

  // ========================= 统一答题入口（双模式） =========================
  async function answerQuestion(q) {
    if (cfg.mode === 'server') {
      const r = await askServer(q, 0);
      if (r && r.ok) return { ok: true, answer: r.answer, reason: r.reason, via: r.via, ms: r.ms, cache: r.cache };
      return { ok: false, msg: r && r.msg };
    }
    // 直连模式
    if (!cfg.aiUrl || !cfg.aiKey) return { ok: false, msg: '直连模式：先在面板填 AI 地址和 Key' };
    if (q.imageDataUrls && q.imageDataUrls.length && !cfg.aiVision) {
      log('题目带图片但当前模型未勾「能看图」，将只按文字作答（可能不准）');
    }
    const r = await directChat(buildDirectMessages(q));
    if (!r.ok) return { ok: false, msg: r.msg };
    const parsed = parseDirectAnswer(r.reply);
    if (!parsed) return { ok: false, msg: 'AI 返回里解析不到答案: ' + String(r.reply).slice(0, 80) };
    return { ok: true, answer: normalizeDirectAnswer(parsed, q.type, q.options), reason: parsed.reason || '', via: cfg.aiModel, ms: null };
  }

  // ========================= 服务端客户端 =========================
  function askServer(question, attempt) {
    attempt = attempt || 0;
    const payload = JSON.stringify({
      title: question.title, options: question.options, type: question.type,
      images: question.imageDataUrls || [],
      accessKey: cfg.accessKey || undefined
    });
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST', url: cfg.serverUrl,
        headers: { 'Content-Type': 'application/json', 'X-Access-Key': cfg.accessKey || '' },
        data: payload,
        timeout: 120000,
        onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (_) { resolve({ ok: false, msg: '返回异常: ' + r.responseText.slice(0, 100) }); } },
        onerror: () => resolve({ ok: false, msg: '请求失败（服务端离线？）', retry: true }),
        ontimeout: () => resolve({ ok: false, msg: '响应超时', retry: true })
      });
    }).then(res => {
      if (res && !res.ok && res.retry && attempt < cfg.retryTimes) {
        const delay = 1000 * Math.pow(2, attempt);
        log(`服务端暂不可用，${delay}ms 后重试`);
        return new Promise(r => setTimeout(r, delay)).then(() => askServer(question, attempt + 1));
      }
      return res;
    });
  }

  // ========================= 填答 + 高亮 =========================
  function collectOptionElements(question) {
    const rule = PLATFORM_RULES.find(r => r.name === question.platform) || {};
    let els = [];
    if (rule.options) { try { els = [...question.container.querySelectorAll(rule.options)]; } catch (_) {} }
    if (!els.length) els = [...question.container.querySelectorAll('li, label')].filter(el => isVisible(el));
    return els.filter(el => { const t = textOf(el); return t && t.length < 200; });
  }
  function clickOption(el) {
    const input = el.querySelector('input[type=radio], input[type=checkbox]') || (el.matches && el.matches('input') ? el : null);
    if (input) { if (!input.checked) input.click(); } else el.click();
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function highlightEl(el) {
    if (!cfg.highlight) return;
    el.classList.add('qp-hl', 'qp-hl-label');
    setTimeout(() => el.classList.remove('qp-hl-label'), 6000); // 标签 6 秒后淡出，描边保留
  }

  function fillAnswer(question, answer) {
    if (!question || answer === undefined || answer === null) return false;
    const arr = (Array.isArray(answer) ? answer : [String(answer)]).map(a => String(a).trim()).filter(Boolean);
    try {
      if (question.type === 'completion') {
        const input = question.container.querySelector('textarea, input[type=text]');
        if (input) { setNativeValue(input, arr.join(' ')); highlightEl(input); stats.filled++; log('✔ 填空已填：' + arr.join(' ')); return true; }
        return false;
      }
      const optionEls = collectOptionElements(question);
      let hit = 0;
      const equiv = a => [a,
        /对|正确|是|true/i.test(a) ? '正确' : null, /对|正确|是|true/i.test(a) ? '对' : null,
        /错|错误|否|false/i.test(a) ? '错误' : null, /错|错误|否|false/i.test(a) ? '错' : null
      ].filter(Boolean);
      const wantVariants = new Set(arr.flatMap(equiv));
      for (const el of optionEls) {
        const t = textOf(el).replace(/^[A-Z][.、．．]\s*/, '').trim();
        const input = el.querySelector('input[type=radio], input[type=checkbox]');
        const valMatch = input && wantVariants.has(String(input.value).trim());
        const textMatch = [...wantVariants].some(w => t && (t === w || t.includes(w) || w.includes(t)));
        if (valMatch || textMatch) { clickOption(el); highlightEl(el); hit++; if (question.type === 'single') break; }
      }
      if (!hit && optionEls.length) {
        const letters = arr.join('').toUpperCase().match(/[A-Z]/g) || [];
        for (const L of letters) {
          const idx = L.charCodeAt(0) - 65;
          if (idx >= 0 && idx < optionEls.length) { clickOption(optionEls[idx]); highlightEl(optionEls[idx]); hit++; if (question.type === 'single') break; }
        }
      }
      if (hit) {
        stats.filled += hit;
        log(`✔ 已选择 ${hit} 个选项：${arr.join(' | ')}`);
        if (cfg.autoSubmit) setTimeout(() => trySubmit(), 800);
        return true;
      }
      log('✘ 选项匹配失败，答案：' + arr.join(' | '));
      return false;
    } catch (e) { log('填答异常：' + e.message); return false; }
  }

  function trySubmit() {
    const btns = [...document.querySelectorAll('button, .btn, a')].filter(b => isVisible(b) && /提交|^确定$|submit/i.test(b.innerText || ''));
    if (btns.length) { btns[0].click(); log('已点击提交'); }
    if (cfg.autoNext) {
      setTimeout(() => {
        const nexts = [...document.querySelectorAll('button, .btn, a')].filter(b => isVisible(b) && /下一题|next|下一个/i.test(b.innerText || ''));
        if (nexts.length) { nexts[0].click(); log('已点击下一题'); }
      }, 1200);
    }
  }

  // ========================= 引擎 =========================
  const answered = new Set();
  const failedOnce = new Set();
  let busy = false;
  const fingerprint = q => ((q.title || '') + '|' + q.options.join('|')).slice(0, 140);
  function alreadyAnswered(q) {
    if (answered.has(fingerprint(q))) return true;
    const checked = q.container.querySelector('input[type=radio]:checked, input[type=checkbox]:checked');
    if (checked) { answered.add(fingerprint(q)); return true; }
    return false;
  }

  async function answerOne(q) {
    const fp = fingerprint(q);
    log(`处理：${(q.title || '(图片题)').slice(0, 60)}（${q.type}，选项${q.options.length}，图${q.images.length}）`);
    answered.add(fp);
    stats.asked++;
    await prepareImages(q);
    const r = await answerQuestion(q);
    if (r && r.ok) {
      stats.ok++;
      showCard(q, r);
      log(`AI：${Array.isArray(r.answer) ? r.answer.join(' | ') : r.answer}${r.reason ? ' ｜ ' + r.reason : ''}`);
      if (cfg.viewOnly) { log('仅查看模式：不自动点选'); return true; }
      return fillAnswer(q, r.answer);
    }
    stats.fail++;
    failedOnce.add(fp);
    log('✘ 获取答案失败：' + (r && r.msg));
    return false;
  }

  async function runBatch(manual) {
    if (busy) return;
    if (!cfg.batchMode && !manual) return;
    busy = true;
    try {
      const list = detectAllQuestions();
      if (!list.length) return;
      const todo = list.filter(q => !alreadyAnswered(q) && (manual || !failedOnce.has(fingerprint(q))));
      log(`整卷扫描：共 ${list.length} 题，待答 ${todo.length} 题`);
      for (const q of todo) { await answerOne(q); await new Promise(r => setTimeout(r, 400)); }
      log('本轮整卷完成');
    } finally { busy = false; refreshUI(); }
  }

  async function tick() {
    if (!cfg.enabled || !siteEnabled() || busy) return;
    if (cfg.coexistOcs && detectOcs()) { refreshUI(); return; }
    if (cfg.batchMode) await runBatch(false);
    else { const q = detectQuestion(); if (q && !alreadyAnswered(q)) await answerOne(q); }
    refreshUI();
  }

  // ========================= 快捷键 =========================
  document.addEventListener('keydown', e => {
    if (!cfg.hotkey) return;
    if (!e.altKey) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'q') {
      e.preventDefault();
      cfg.enabled = !cfg.enabled; saveCfg();
      log(`快捷键 Alt+Q：自动答题${cfg.enabled ? '开' : '关'}`);
      refreshUI();
    } else if (k === 'b') {
      e.preventDefault();
      log('快捷键 Alt+B：整卷答一轮');
      runBatch(true);
    } else if (k === 'p') {
      e.preventDefault();
      cfg.viewOnly = !cfg.viewOnly; saveCfg();
      log(`快捷键 Alt+P：仅查看模式${cfg.viewOnly ? '开（只弹卡片不点选）' : '关'}`);
      refreshUI();
    }
  }, true);

  // ========================= 启动 =========================
  let bootDone = false, observer = null, pollTimer = null, debounceTimer = null, healthTimer = null;

  function scheduleTick() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { tick().catch(e => log('处理异常：' + e.message)); }, 800);
  }

  function boot() {
    if (bootDone) return;
    if (!document.body) return;
    bootDone = true;
    buildUI();
    checkHealth();
    healthTimer = setInterval(checkHealth, 10000);
    log(`QuizPilot v3.3.0 就绪 · ${cfg.mode === 'direct' ? '直连 ' + (cfg.aiModel || 'AI') + (cfg.aiKey ? '' : '（未填 Key）') : '服务端' + (svcOnline ? '在线' : '检测中')} · 自动答题${cfg.enabled ? '开' : '关'} · 整卷${cfg.batchMode ? '开' : '关'}${cfg.viewOnly ? ' · 仅查看' : ''}`);
    if (detectOcs()) log('提示：助手协同已开启，检测到其他答题助手时本插件待机');

    observer = new MutationObserver(muts => {
      if (!cfg.enabled || busy) return;
      if (muts.some(m => m.addedNodes.length > 0)) scheduleTick();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    pollTimer = setInterval(() => { tick().catch(e => log('轮询异常：' + e.message)); }, Math.max(1500, cfg.intervalMs * 3));
    refreshUI();

    // 首次使用引导：AI 未配置时自动弹开面板（每站点只弹一次）
    if (!aiConfigured() && !store.get('onboardShown_' + host)) {
      store.set('onboardShown_' + host, true);
      setTimeout(() => {
        if (panel && aiConfigured()) return; // 用户已手动配好就不打扰
        if (panel) panel.style.display = 'block';
        log('第一次使用：在「第一步」填入你的 AI 接口地址和 Key（DeepSeek 官方 Key、中转站 Key 或自建网页版反代均可），保存后即可答题');
      }, 1200);
    }
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      answered.clear(); failedOnce.clear();
      detectOcs._logged = false;
      log('路由变化，已重置本页状态');
      boot();
    }
  }, 1000);

  gmMenu('打开/关闭 QuizPilot 面板', () => { if (panel) panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; });
  gmMenu('立即整卷答一轮', () => runBatch(true));
  gmMenu('切换自动答题', () => { cfg.enabled = !cfg.enabled; saveCfg(); log('自动答题：' + (cfg.enabled ? '开' : '关')); refreshUI(); });

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 800);
  else window.addEventListener('DOMContentLoaded', () => setTimeout(boot, 800));
})();
