// 假 AI 上游：模拟 OpenAI /v1/chat/completions，用于端到端测试
'use strict';
const http = require('http');

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let q = '';
    let hasImg = false;
    try {
      const j = JSON.parse(body);
      const content = j.messages && j.messages[1] && j.messages[1].content;
      hasImg = Array.isArray(content);
      q = hasImg ? content[0].text : String(content || '');
    } catch (_) {}
    // 模拟按题型回答（故意带 JSON 代码块，验证解析器）
    let answer = 'A';
    if (/多选|multi/i.test(q)) answer = 'ABD';
    else if (/判断|对错/i.test(q)) answer = '对';
    else if (/填空|completion/i.test(q)) answer = '超文本传输协议';
    const out = JSON.stringify({
      choices: [{ message: { content: '```json\n{"answer":"' + answer + '","reason":"mock"}\n```' } }]
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(out);
    console.log('[mock] served q=' + q.slice(0, 50).replace(/\n/g, ' ') + ' img=' + hasImg);
  });
}).listen(18787, () => console.log('mock upstream on 18787'));
