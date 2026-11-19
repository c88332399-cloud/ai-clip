// ТОЛЬКО ДЛЯ ТЕСТОВ: имитирует Gemini generateContent, чтобы проверить пайплайн без ключа и без сети.
import http from 'node:http';
export function startMock(port) {
  return new Promise(ok => {
    const s = http.createServer((req, res) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (!/:generateContent$/.test(req.url) || req.headers['x-goog-api-key'] !== 'test') { res.statusCode = 403; return res.end('{"error":{"message":"bad key"}}'); }
        const j = JSON.parse(Buffer.concat(c).toString('utf8')), parts = j.contents[0].parts, text = parts.map(p => p.text || '').join('\n');
        const reply = o => res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] }, finishReason: 'STOP' }] }));
        if (parts.some(p => p.inlineData)) { // распознавание речи: 5-минутный кусок, фразы по 6 с
          const segments = []; for (let i = 0; i < 15; i++) { const st = i * 6, f = t => `${String(t / 60 | 0).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; segments.push({ start: f(st), end: f(st + 5), text: `Тестовая фраза номер ${i + 1}.` }); }
          return reply({ language: 'ru', segments });
        }
        if (/Translate each line/.test(text)) { const arr = JSON.parse(text.slice(text.indexOf('INPUT:\n') + 7)); return reply({ lines: arr.map((_, i) => 'Translated line ' + (i + 1)) }); }
        const lines = [...text.matchAll(/^\[(\d+)-(\d+)\] /gm)].map(m => [+m[1], +m[2]]);
        const pick = [[24, 5], [48, 5], [0, 5], [66, 5]].map(([s]) => { const a = lines.find(l => l[0] === s), b = lines.find(l => l[0] === s + 18); return a && b ? { start: a[0], end: b[1], title: 'Момент с ' + s + ' с', description: 'Описание', reason: 'Законченная мысль', scores: { interest: 90 - s / 3, standalone: 80, hook: 75, clean: 85 } } : null; }).filter(Boolean);
        reply({ candidates: pick });
      });
    }).listen(port, () => ok(s));
  });
}
