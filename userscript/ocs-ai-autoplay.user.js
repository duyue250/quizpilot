// ==UserScript==
// @name         AI Answer Link — 网课 AI 自动答题助手
// @namespace    https://github.com/your-name/ai-answer-link
// @version      2.0.0
// @description  通过本地 AI 服务端抓取网课题目（含图片）并自动填答。支持单题/整卷批量模式、多平台识别、重试与缓存协同。可作为独立助手使用，也可与 OCS 网课助手协同（通过其公开的 AnswererWrapper 自定义题库协议）。
// @author       your-name
// @license      MIT
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
// @noframes     true
// ==/UserScript==

/**
 * AI Answer Link v2.0.0
 * ------------------------------------------------------------------
 * 原创独立实现（MIT）。与 OCS 网课助手的关系：通过其官方文档公开的
 * AnswererWrapper 自定义题库协议协同工作，未复制、未修改其源码。
 *
 * v2.0.0 相对 1.x 的变化：
 *  1. 整卷批量模式：一次扫描整页所有题目，逐题问 AI、逐题填答
 *  2. 请求重试（指数退避）+ 题目级失败缓存，避免反复问同一道失败题
 *  3. MutationObserver 动态监听新题，比纯轮询更快更省
 *  4. OCS 协同模式：检测到 OCS 面板时自动暂停，避免双引擎抢答
 *  5. 配置导入/导出（JSON），日志一键复制
 *  6. 站点级开关记忆（按域名记住启用状态）
 *  7. 填答增强：input.value 匹配兜底、字母答案索引兜底、判断题语义匹配
 *  8. 更多平台规则（vlearning/uetc/职教云等）+ 通用试卷页识别
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  // =========================================================================
  // 存储层：GM 优先，localStorage 兜底（兼容 ScriptCat / 极简管理器）
  // =========================================================================
  const store = (() => {
    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    return {
      get: k => hasGM ? GM_getValue(k, undefined) : (() => { try { const v = localStorage.getItem('aal_' + k); return v === null ? undefined : JSON.parse(v); } catch (_) { return undefined; } })(),
      set: (k, v) => hasGM ? GM_setValue(k, v) : (() => { try { localStorage.setItem('aal_' + k, JSON.stringify(v)); } catch (_) {} })()
    };
  })();

  // =========================================================================
  // 配置
  // =========================================================================
  const DEFAULTS = {
    serverUrl: 'http://127.0.0.1:8787/answer',
    enabled: false,            // 自动答题总开关（全局）
    autoSubmit: false,         // 自动提交（危险开关，默认关）
    autoNext: false,           // 提交后自动下一题
    coexistOcs: true,          // 检测到 OCS 面板时暂停自动答题
    intervalMs: 2000,          // 轮询兜底间隔
    maxImagesPerQuestion: 3,
    imageMaxWidth: 900,
    questionSelector: '',      // 用户自定义题目容器选择器
    batchMode: true,           // 整卷批量模式
    retryTimes: 1,             // 失败重试次数
    debug: true
  };

  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = store.get('cfg_' + k);
    if (v !== undefined) cfg[k] = v;
  }
  const saveCfg = () => { for (const k of Object.keys(DEFAULTS)) store.set('cfg_' + k, cfg[k]); };

  // 站点级启用记忆：{ [host]: true|false }，false = 该站禁用
  const siteRules = store.get('siteRules') || {};
  const host = location.host;
  function siteEnabled() {
    if (host in siteRules) return siteRules[host];
    return true; // 未设置过的站点默认可用
  }

  // =========================================================================
  // 日志 + 统计
  // =========================================================================
  const stats = { asked: 0, ok: 0, fail: 0, filled: 0 };
  const logs = [];
  let logBox = null;

  function log(msg, level) {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    logs.push(line);
    if (logs.length > 300) logs.shift();
    if (cfg.debug) console.log('%c[AAL]', 'color:#0ea5e9;font-weight:bold', msg);
    if (logBox) logBox.textContent = logs.join('\n');
  }

  // =========================================================================
  // 样式
  // =========================================================================
  const css = `
    #aal-fab { position:fixed; right:18px; bottom:18px; z-index:2147483000; width:52px; height:52px;
      border-radius:50%; background:linear-gradient(135deg,#0ea5e9,#6366f1); color:#fff; font-size:12px;
      display:flex; align-items:center; justify-content:center; cursor:pointer; font-weight:bold;
      box-shadow:0 4px 14px rgba(0,0,0,.35); user-select:none; font-family:"Microsoft YaHei",sans-serif; }
    #aal-fab.on { background:linear-gradient(135deg,#22c55e,#0ea5e9); }
    #aal-fab.paused { background:linear-gradient(135deg,#f59e0b,#ef4444); }
    #aal-panel { position:fixed; right:18px; bottom:80px; z-index:2147483000; width:340px; max-height:72vh;
      overflow:auto; background:#1e293b; color:#e2e8f0; border-radius:12px; padding:14px; font-size:13px;
      box-shadow:0 8px 30px rgba(0,0,0,.5); display:none; font-family:"Microsoft YaHei",sans-serif; }
    #aal-panel h3 { margin:0 0 8px; font-size:15px; color:#38bdf8; }
    #aal-panel h4 { margin:12px 0 4px; font-size:12px; color:#94a3b8; border-top:1px solid #334155; padding-top:8px; }
    #aal-panel label { display:block; margin:6px 0 2px; color:#94a3b8; font-size:12px; }
    #aal-panel input[type=text], #aal-panel textarea { width:100%; box-sizing:border-box; background:#0f172a;
      color:#e2e8f0; border:1px solid #334155; border-radius:6px; padding:6px 8px; font-size:12px; }
    #aal-panel textarea { min-height:70px; resize:vertical; }
    #aal-panel .btn { display:inline-block; background:#0ea5e9; color:#fff; border:0; border-radius:6px;
      padding:5px 10px; margin:4px 4px 0 0; cursor:pointer; font-size:12px; }
    #aal-panel .btn.green { background:#22c55e; } #aal-panel .btn.red { background:#ef4444; }
    #aal-panel .btn.gray { background:#475569; }
    #aal-panel .row { display:flex; align-items:center; gap:6px; margin-top:6px; font-size:12px; }
    #aal-panel .stat { display:flex; gap:8px; margin-top:6px; font-size:11px; color:#94a3b8; }
    #aal-panel .stat b { color:#e2e8f0; }
    #aal-log { background:#020617; color:#4ade80; font-family:Consolas,monospace; font-size:11px;
      padding:8px; border-radius:6px; max-height:150px; overflow:auto; white-space:pre-wrap; margin-top:8px; }
    #aal-badge { position:fixed; right:14px; bottom:76px; z-index:2147483000; font-size:10px; color:#fff;
      background:#334155; border-radius:10px; padding:1px 7px; display:none; font-family:sans-serif; }
  `;
  function addStyle(text) {
    if (typeof GM_addStyle === 'function') return GM_addStyle(text);
    const s = document.createElement('style');
    s.textContent = text;
    document.head.appendChild(s);
  }

  // =========================================================================
  // UI
  // =========================================================================
  let fab, panel, badge;

  function buildUI() {
    if (document.getElementById('aal-fab')) return;
    addStyle(css);

    fab = document.createElement('div');
    fab.id = 'aal-fab';
    fab.textContent = 'AI答';
    document.body.appendChild(fab);

    badge = document.createElement('div');
    badge.id = 'aal-badge';
    document.body.appendChild(badge);

    panel = document.createElement('div');
    panel.id = 'aal-panel';
    panel.innerHTML = `
      <h3>AI Answer Link <span style="font-size:10px;color:#64748b">v2.0.0</span></h3>
      <label>服务端地址</label>
      <input type="text" id="aal-cfg-server" value="${cfg.serverUrl}">
      <label>自定义题目容器选择器（可选，留空用内置规则）</label>
      <input type="text" id="aal-cfg-selector" value="${cfg.questionSelector}">
      <div class="row"><input type="checkbox" id="aal-cfg-enabled" ${cfg.enabled ? 'checked' : ''}><span>自动答题（全局开关）</span></div>
      <div class="row"><input type="checkbox" id="aal-cfg-batch" ${cfg.batchMode ? 'checked' : ''}><span>整卷批量模式（一次答完本页所有题）</span></div>
      <div class="row"><input type="checkbox" id="aal-cfg-submit" ${cfg.autoSubmit ? 'checked' : ''}><span>答完自动提交（谨慎）</span></div>
      <div class="row"><input type="checkbox" id="aal-cfg-next" ${cfg.autoNext ? 'checked' : ''}><span>提交后自动下一题</span></div>
      <div class="row"><input type="checkbox" id="aal-cfg-ocs" ${cfg.coexistOcs ? 'checked' : ''}><span>OCS 协同（检测到 OCS 面板时暂停）</span></div>
      <div class="row">
        <span style="color:#94a3b8">本站（${host}）：</span>
        <button class="btn green" id="aal-btn-siteon">启用本站</button>
        <button class="btn red" id="aal-btn-siteoff">禁用本站</button>
        <span id="aal-sitestate" style="color:#94a3b8"></span>
      </div>
      <div class="stat">
        <span>已问 <b id="aal-s1">0</b></span><span>成功 <b id="aal-s2">0</b></span>
        <span>失败 <b id="aal-s3">0</b></span><span>已填 <b id="aal-s4">0</b></span>
      </div>
      <h4>操作</h4>
      <div class="row">
        <button class="btn" id="aal-btn-once">抓当前题试一发</button>
        <button class="btn" id="aal-btn-batch">整卷答一轮</button>
        <button class="btn gray" id="aal-btn-reset">清空已答记忆</button>
      </div>
      <h4>配置导入 / 导出</h4>
      <textarea id="aal-cfg-json" placeholder="点导出生成 JSON；粘贴 JSON 后点导入"></textarea>
      <div class="row">
        <button class="btn gray" id="aal-btn-export">导出</button>
        <button class="btn gray" id="aal-btn-import">导入</button>
        <button class="btn gray" id="aal-btn-copylog">复制日志</button>
        <button class="btn gray" id="aal-btn-clear">清日志</button>
      </div>
      <div id="aal-log"></div>
    `;
    document.body.appendChild(panel);
    logBox = document.getElementById('aal-log');

    fab.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
      refreshUI();
    });

    document.getElementById('aal-btn-save')?.remove();
    // 保存按钮（放日志上方）
    const saveBtn = document.createElement('div');
    saveBtn.className = 'row';
    saveBtn.innerHTML = '<button class="btn green" id="aal-btn-save">保存配置</button>';
    panel.insertBefore(saveBtn, document.getElementById('aal-log'));

    document.getElementById('aal-btn-save').addEventListener('click', () => {
      cfg.serverUrl = document.getElementById('aal-cfg-server').value.trim() || DEFAULTS.serverUrl;
      cfg.questionSelector = document.getElementById('aal-cfg-selector').value.trim();
      cfg.enabled = document.getElementById('aal-cfg-enabled').checked;
      cfg.batchMode = document.getElementById('aal-cfg-batch').checked;
      cfg.autoSubmit = document.getElementById('aal-cfg-submit').checked;
      cfg.autoNext = document.getElementById('aal-cfg-next').checked;
      cfg.coexistOcs = document.getElementById('aal-cfg-ocs').checked;
      saveCfg();
      log('配置已保存');
      refreshUI();
    });

    document.getElementById('aal-btn-siteon').addEventListener('click', () => { siteRules[host] = true; store.set('siteRules', siteRules); refreshUI(); log(`本站已启用：${host}`); });
    document.getElementById('aal-btn-siteoff').addEventListener('click', () => { siteRules[host] = false; store.set('siteRules', siteRules); refreshUI(); log(`本站已禁用：${host}`); });

    document.getElementById('aal-btn-once').addEventListener('click', async () => {
      const q = detectQuestion();
      if (!q) return log('没抓到题目：可尝试填写自定义选择器');
      log(`抓到题：${(q.title || '(图片题)').slice(0, 50)} | 选项${q.options.length}个 | 图片${q.images.length}张 | 类型${q.type}`);
      await prepareImages(q);
      const r = await askServer(q, 0);
      log('AI 返回：' + (r && r.ok ? JSON.stringify(r.answer) : (r && r.msg)));
      if (r && r.ok) fillAnswer(q, r.answer);
    });

    document.getElementById('aal-btn-batch').addEventListener('click', () => runBatch(true));

    document.getElementById('aal-btn-reset').addEventListener('click', () => { answered.clear(); log('已清空本页已答记忆'); });

    document.getElementById('aal-btn-export').addEventListener('click', () => {
      document.getElementById('aal-cfg-json').value = JSON.stringify(cfg, null, 2);
      log('配置已导出到文本框');
    });
    document.getElementById('aal-btn-import').addEventListener('click', () => {
      try {
        const j = JSON.parse(document.getElementById('aal-cfg-json').value);
        for (const k of Object.keys(DEFAULTS)) if (k in j) cfg[k] = j[k];
        saveCfg(); log('配置已导入'); refreshUI();
      } catch (e) { log('导入失败：' + e.message); }
    });
    document.getElementById('aal-btn-copylog').addEventListener('click', () => {
      const text = logs.join('\n');
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text); log('日志已复制到剪贴板'); }
      else { navigator.clipboard?.writeText(text).then(() => log('日志已复制')).catch(() => log('复制失败，请手动选中文本')); }
    });
    document.getElementById('aal-btn-clear').addEventListener('click', () => { logs.length = 0; if (logBox) logBox.textContent = ''; });

    refreshUI();
  }

  function refreshUI() {
    if (!fab || !badge) return;
    const active = cfg.enabled && siteEnabled() && !(cfg.coexistOcs && detectOcs());
    fab.className = active ? 'on' : (cfg.enabled ? 'paused' : '');
    badge.style.display = active ? 'block' : 'none';
    badge.textContent = active ? '自动答题运行中' : (cfg.coexistOcs && detectOcs() ? 'OCS 协同暂停中' : '待机');
    const s = document.getElementById('aal-sitestate');
    if (s) s.textContent = siteEnabled() ? '已启用' : '已禁用';
    for (const [id, key] of [['aal-s1', 'asked'], ['aal-s2', 'ok'], ['aal-s3', 'fail'], ['aal-s4', 'filled']]) {
      const el = document.getElementById(id);
      if (el) el.textContent = stats[key];
    }
    // 同步复选框显示
    const map = { 'aal-cfg-enabled': 'enabled', 'aal-cfg-batch': 'batchMode', 'aal-cfg-submit': 'autoSubmit', 'aal-cfg-next': 'autoNext', 'aal-cfg-ocs': 'coexistOcs' };
    for (const [id, key] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.checked = cfg[key];
    }
  }

  // =========================================================================
  // OCS 检测（协同模式）：识别 OCS 网课助手注入的面板元素
  // =========================================================================
  function detectOcs() {
    if (!cfg.coexistOcs) return false;
    // OCS 面板及其悬浮元素的 id/class 带 ocs 前缀；脚本标签带 ocsjs 特征
    const el = document.querySelector('[id^="ocs-"], [class^="ocs-"], [id*="OCS"], script[src*="ocsjs"]');
    const found = !!el;
    if (found && !detectOcs._logged) {
      detectOcs._logged = true;
      log('检测到 OCS 网课助手，自动答题已暂停（协同模式）。可在面板关闭「OCS 协同」让本插件接管。');
    }
    return found;
  }

  // =========================================================================
  // 平台规则
  // =========================================================================
  const PLATFORM_RULES = [
    { // 超星/学习通（章节测验 + 考试）
      name: 'chaoxing',
      question: '.TiMu, .questionLi, .timu-item',
      title: '.Zy_TItle, .qtContent, .Cy_TItle, .fontLabel, .title',
      options: '.answerList li, .Zy_ulPy li, ul li[data-type], .option-item, .answerCard .list li',
      optionText: '.num_option, .after, .fl'
    },
    { // 智慧树
      name: 'zhihuishu',
      question: '.question-item, .exam-question, .ti-item, .topic-item',
      title: '.question-title, .topic-title, .desc, .topic-content',
      options: '.option-item, .op-item, li.option, .topic-option, .option',
      optionText: ''
    },
    { // 职教云 icve
      name: 'icve',
      question: '.questionItem, .exam-question-item, .queType',
      title: '.questionContent, .queStem, .stem',
      options: '.questionOption li, .optionList li, label.optionItem',
      optionText: ''
    },
    { // 学习联盟/雨课堂类
      name: 'xueyin',
      question: '.exam-question, .question-wrapper, .q-container',
      title: '.question-stem, .q-text, .stem',
      options: '.choice-item, .option-row, label',
      optionText: ''
    },
    { // 通用：整卷页面（多题并存）
      name: 'paper',
      question: '.question, .q-item, .exam-item, .que-item, div[id^="question"]',
      title: '.stem, .q-title, .question-text, h3',
      options: '.opt, .choice, label:has(input[type=radio]), label:has(input[type=checkbox])',
      optionText: ''
    }
  ];

  function textOf(el) {
    return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

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
    if (rule.title) {
      const t = container.querySelector(rule.title);
      title = textOf(t);
    }
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
    if (rule.options) {
      try { optionEls = [...container.querySelectorAll(rule.options)]; } catch (_) { /* :has 兼容 */ }
    }
    if (!optionEls.length) {
      optionEls = [...container.querySelectorAll('li, label')].filter(el => /^[A-Z][.、．．]/.test(textOf(el)));
    }
    optionEls.forEach(el => {
      if (!isVisible(el)) return;
      let t = textOf(el);
      if (rule.optionText) {
        const sub = el.querySelector(rule.optionText);
        if (sub && textOf(sub).length > 1) t = textOf(sub);
      }
      t = t.replace(/^[A-Z][.、．．]\s*/, '').trim();
      if (t && t.length < 200 && !options.includes(t)) options.push(t);
    });

    if (type === 'judge' && options.length === 0) {
      if (/对|正确/.test(containerText) && /错|错误/.test(containerText)) options.push('正确', '错误');
    }

    return { title, options, images: pickImages(container), type, container, platform };
  }

  /** 单题抓取：当前可见的题 */
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
    // 兜底：就近 radio 组
    const radio = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')].filter(isVisible);
    if (radio.length) {
      let p = radio[0].closest('li,div');
      for (let i = 0; i < 4 && p && p.parentElement; i++) {
        if (textOf(p).length > 20) break;
        p = p.parentElement;
      }
      if (p) return extractFrom(p, 'fallback');
    }
    return null;
  }

  /** 整卷抓取：页面内所有题目容器 */
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
        nodes.forEach(c => {
          const q = extractFrom(c, rule.name, rule);
          if (q && (q.title || q.images.length)) out.push(q);
        });
        if (out.length) return out;
      }
    }
    return out;
  }

  // =========================================================================
  // 图片抓取与压缩
  // =========================================================================
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
    for (const src of q.images) {
      const d = await fetchImageAsDataUrl(src);
      if (d) datas.push(d);
    }
    q.imageDataUrls = datas;
    if (datas.length) log(`图片已抓取 ${datas.length}/${q.images.length} 张`);
  }

  // =========================================================================
  // 服务端客户端（重试 + 指数退避）
  // =========================================================================
  function askServer(question, attempt) {
    attempt = attempt || 0;
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: cfg.serverUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          title: question.title,
          options: question.options,
          type: question.type,
          images: question.imageDataUrls || []
        }),
        timeout: 120000,
        onload: r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (_) { resolve({ ok: false, msg: '服务端返回异常: ' + r.responseText.slice(0, 100) }); }
        },
        onerror: () => resolve({ ok: false, msg: '请求失败（检查服务端）', retry: true }),
        ontimeout: () => resolve({ ok: false, msg: '响应超时', retry: true })
      });
    }).then(res => {
      if (res && !res.ok && res.retry && attempt < cfg.retryTimes) {
        const delay = 1000 * Math.pow(2, attempt);
        log(`服务端暂不可用，${delay}ms 后重试（${attempt + 1}/${cfg.retryTimes}）`);
        return new Promise(r => setTimeout(r, delay)).then(() => askServer(question, attempt + 1));
      }
      return res;
    });
  }

  // =========================================================================
  // 填答
  // =========================================================================
  function collectOptionElements(question) {
    const rule = PLATFORM_RULES.find(r => r.name === question.platform) || {};
    let els = [];
    if (rule.options) { try { els = [...question.container.querySelectorAll(rule.options)]; } catch (_) {} }
    if (!els.length) els = [...question.container.querySelectorAll('li, label')].filter(el => isVisible(el));
    return els.filter(el => { const t = textOf(el); return t && t.length < 200; });
  }

  function clickOption(el) {
    const input = el.querySelector('input[type=radio], input[type=checkbox]')
      || (el.matches && el.matches('input') ? el : null);
    if (input) {
      if (!input.checked) input.click();
    } else {
      el.click();
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillAnswer(question, answer) {
    if (!question || answer === undefined || answer === null) return false;
    const arr = Array.isArray(answer) ? answer.map(String) : [String(answer)];
    const wantSet = arr.map(a => a.trim()).filter(Boolean);

    try {
      if (question.type === 'completion') {
        const input = question.container.querySelector('textarea, input[type=text]');
        if (input) {
          setNativeValue(input, wantSet.join(' '));
          stats.filled++; log('✔ 填空已填：' + wantSet.join(' '));
          return true;
        }
        return false;
      }

      const optionEls = collectOptionElements(question);
      let hit = 0;

      // 1) 文本匹配（含判断题语义等价：对=正确=是）
      const equiv = a => [a,
        /对|正确|是|true/i.test(a) ? '正确' : null,
        /错|错误|否|false/i.test(a) ? '错误' : null,
        /对|正确|是|true/i.test(a) ? '对' : null,
        /错|错误|否|false/i.test(a) ? '错' : null
      ].filter(Boolean);
      const wantVariants = new Set(wantSet.flatMap(equiv));

      for (const el of optionEls) {
        const t = textOf(el).replace(/^[A-Z][.、．．]\s*/, '').trim();
        const input = el.querySelector('input[type=radio], input[type=checkbox]');
        const valMatch = input && wantVariants.has(String(input.value).trim());
        const textMatch = [...wantVariants].some(w => t && (t === w || t.includes(w) || w.includes(t)));
        if (valMatch || textMatch) {
          clickOption(el); hit++;
          if (question.type === 'single') break;
        }
      }

      // 2) 字母答案按索引点
      if (!hit && optionEls.length) {
        const letters = wantSet.join('').toUpperCase().match(/[A-Z]/g) || [];
        for (const L of letters) {
          const idx = L.charCodeAt(0) - 65;
          if (idx >= 0 && idx < optionEls.length) {
            clickOption(optionEls[idx]); hit++;
            if (question.type === 'single') break;
          }
        }
      }

      if (hit) {
        stats.filled += hit;
        log(`✔ 已选择 ${hit} 个选项：${wantSet.join(' | ')}`);
        if (cfg.autoSubmit) setTimeout(() => trySubmit(), 800);
        return true;
      }
      log('✘ 选项匹配失败，答案：' + wantSet.join(' | '));
      return false;
    } catch (e) {
      log('填答异常：' + e.message);
      return false;
    }
  }

  function trySubmit() {
    const btns = [...document.querySelectorAll('button, .btn, a')]
      .filter(b => isVisible(b) && /提交|^确定$|submit/i.test(b.innerText || ''));
    if (btns.length) { btns[0].click(); log('已点击提交'); }
    if (cfg.autoNext) {
      setTimeout(() => {
        const nexts = [...document.querySelectorAll('button, .btn, a')]
          .filter(b => isVisible(b) && /下一题|next|下一个/i.test(b.innerText || ''));
        if (nexts.length) { nexts[0].click(); log('已点击下一题'); }
      }, 1200);
    }
  }

  // =========================================================================
  // 引擎：单题 + 整卷批量
  // =========================================================================
  const answered = new Set();      // 本页已处理题目指纹
  const failedOnce = new Set();    // 失败过一次的题：批量模式下跳过，避免循环重问
  let busy = false;                // 批量互斥锁

  function fingerprint(q) {
    return ((q.title || '') + '|' + q.options.join('|')).slice(0, 140);
  }

  function alreadyAnswered(q) {
    if (answered.has(fingerprint(q))) return true;
    const checked = q.container.querySelector('input[type=radio]:checked, input[type=checkbox]:checked');
    if (checked) { answered.add(fingerprint(q)); return true; }
    return false;
  }

  async function answerOne(q, silent) {
    const fp = fingerprint(q);
    if (!silent) log(`处理：${(q.title || '(图片题)').slice(0, 60)}（${q.type}，选项${q.options.length}，图${q.images.length}）`);
    answered.add(fp);
    stats.asked++;
    await prepareImages(q);
    const r = await askServer(q, 0);
    if (r && r.ok) {
      stats.ok++;
      log(`AI：${Array.isArray(r.answer) ? r.answer.join(' | ') : r.answer}${r.reason ? ' ｜ ' + r.reason : ''}`);
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
      for (const q of todo) {
        await answerOne(q, false);
        await new Promise(r => setTimeout(r, 400)); // 节流，避免上游限流
      }
      log('本轮整卷完成');
    } finally {
      busy = false;
      refreshUI();
    }
  }

  async function tick() {
    if (!cfg.enabled || !siteEnabled() || busy) return;
    if (cfg.coexistOcs && detectOcs()) { refreshUI(); return; }
    if (cfg.batchMode) {
      await runBatch(false);
    } else {
      const q = detectQuestion();
      if (q && !alreadyAnswered(q)) await answerOne(q, false);
    }
    refreshUI();
  }

  // =========================================================================
  // 启动：MutationObserver 为主，轮询兜底
  // =========================================================================
  let bootDone = false;
  let observer = null;
  let pollTimer = null;
  let debounceTimer = null;

  function scheduleTick() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { tick().catch(e => log('处理异常：' + e.message)); }, 800);
  }

  function boot() {
    if (bootDone) return;
    if (!document.body) return;
    bootDone = true;
    buildUI();
    log(`v2.0.0 就绪 · 服务端 ${cfg.serverUrl} · 自动答题${cfg.enabled ? '开' : '关'} · 本站${siteEnabled() ? '启用' : '禁用'} · 整卷${cfg.batchMode ? '开' : '关'}`);
    if (detectOcs()) log('提示：已启用 OCS 协同，OCS 存在时本插件待机');

    observer = new MutationObserver(muts => {
      if (!cfg.enabled || busy) return;
      // 只关心节点增删，且数量不小（过滤高频微变更）
      const meaningful = muts.some(m => m.addedNodes.length > 0);
      if (meaningful) scheduleTick();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    pollTimer = setInterval(() => { tick().catch(e => log('轮询异常：' + e.message)); }, Math.max(1500, cfg.intervalMs * 3));

    refreshUI();
  }

  // SPA 路由变化时重置已答记忆
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      answered.clear(); failedOnce.clear();
      detectOcs._logged = false;
      log('页面路由变化，已重置本页状态');
      boot();
    }
  }, 1000);

  GM_registerMenuCommand('打开/关闭 AI 答题面板', () => {
    if (panel) panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  });
  GM_registerMenuCommand('立即整卷答一轮', () => runBatch(true));
  GM_registerMenuCommand('切换自动答题', () => {
    cfg.enabled = !cfg.enabled; saveCfg(); log('自动答题：' + (cfg.enabled ? '开' : '关')); refreshUI();
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(boot, 800);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(boot, 800));
  }
})();
