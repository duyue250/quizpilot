// QuizPilot 单元测试：直连模式答案解析逻辑（与插件内实现同源验证）
// 运行: node test/unit-test.js
'use strict';

// ---- 从插件源码中提取 parseDirectAnswer / normalizeDirectAnswer 进行测试 ----
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'quizpilot.user.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('找不到函数: ' + name);
  // 花括号配对扫描
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const ctx = {};
eval('ctx.parseDirectAnswer = ' + extractFn('parseDirectAnswer'));
eval('ctx.normalizeDirectAnswer = ' + extractFn('normalizeDirectAnswer'));

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✔ ${label}`); }
  else { fail++; console.error(`  ✘ ${label}\n      期望: ${e}\n      实际: ${a}`); }
}

console.log('== parseDirectAnswer ==');
eq(ctx.parseDirectAnswer('{"answer":"A","reason":"r"}'), { answer: 'A', reason: 'r' }, '纯 JSON');
eq(ctx.parseDirectAnswer('好的，答案是：\n```json\n{"answer":"B"}\n```'), { answer: 'B' }, 'markdown 代码块');
eq(ctx.parseDirectAnswer('前置废话 {"answer":"C"} 后缀'), { answer: 'C' }, '花括号提取');
eq(ctx.parseDirectAnswer('对'), { answer: '对' }, '纯文本截取');
eq(ctx.parseDirectAnswer(''), null, '空串 -> null');

console.log('== normalizeDirectAnswer ==');
const opts = ['FTP', 'HTTP', 'SMTP', 'SSH'];
eq(ctx.normalizeDirectAnswer({ answer: 'B' }, 'single', opts), ['HTTP'], '单选字母 -> 选项文本');
eq(ctx.normalizeDirectAnswer({ answer: 'HTTP' }, 'single', opts), ['HTTP'], '单选直接给文本');
eq(ctx.normalizeDirectAnswer({ answer: 'ABD' }, 'multi', opts), ['FTP', 'HTTP', 'SSH'], '多选字母组合');
eq(ctx.normalizeDirectAnswer({ answer: '对' }, 'judge', []), ['正确', '对', '是', 'true'], '判断-对（四写）');
eq(ctx.normalizeDirectAnswer({ answer: '错误' }, 'judge', []), ['错误', '错', '否', 'false'], '判断-错');
eq(ctx.normalizeDirectAnswer({ answer: 'A' }, 'judge', []), ['正确', '对', '是', 'true'], '判断-字母A兜底');
eq(ctx.normalizeDirectAnswer({ answer: 'B' }, 'judge', []), ['错误', '错', '否', 'false'], '判断-字母B兜底');
eq(ctx.normalizeDirectAnswer({ answer: '"超文本传输协议"' }, 'completion', []), ['超文本传输协议'], '填空去引号');
eq(ctx.normalizeDirectAnswer({ answer: '对' }, 'unknown', ['正确', '错误']), ['正确', '对', '是', 'true'], '未声明题型猜判断');
eq(ctx.normalizeDirectAnswer({ answer: 'BD' }, 'unknown', opts), ['HTTP', 'SSH'], '未声明题型猜多选');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
