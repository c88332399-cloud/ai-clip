// ТОЛЬКО ДЛЯ ТЕСТОВ: имитирует внешние API (Whisper/Anthropic), чтобы проверить пайплайн без ключей.
import http from 'node:http';
export function startMock(port) {
  return new Promise(ok => {
    const s = http.createServer((req, res) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => {
        const body = Buffer.concat(c).toString('utf8'); res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/audio/transcriptions')) {
          const segments = [], words = [];
          for (let i = 0; i < 15; i++) { const st = i * 6; segments.push({ start: st, end: st + 5.8, text: `Тестовая фраза номер ${i + 1}.` }); ['Тестовая', 'фраза', 'номер', String(i + 1)].forEach((w, k) => words.push({ word: w, start: st + k * 1.2, end: st + k * 1.2 + 1 })); }
          return res.end(JSON.stringify({ language: 'russian', duration: 90, segments, words }));
        }
        if (req.url.endsWith('/v1/messages')) {
          const j = JSON.parse(body), u = j.messages[0].content;
          if (/translate/i.test(j.system)) { const arr = JSON.parse(u.slice(u.indexOf('['))); return res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(arr.map((_, i) => 'Translated line ' + (i + 1))) }] })); }
          const lines = [...u.matchAll(/^\[(\d+)-(\d+)\] /gm)].map(m => [+m[1], +m[2]]);
          const pick = [[24, 5], [48, 5], [0, 5], [66, 5]].map(([s, k]) => { const a = lines.find(l => l[0] === s), b = lines.find(l => l[0] === s + 18); return a && b ? { start: a[0], end: b[1], title: 'Момент с ' + s + ' с', description: 'Описание', reason: 'Законченная мысль', scores: { interest: 90 - s / 3, standalone: 80, hook: 75, clean: 85 } } : null; }).filter(Boolean);
          return res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ candidates: pick }) }] }));
        }
        res.statusCode = 404; res.end('{}');
      });
    }).listen(port, () => ok(s));
  });
}
