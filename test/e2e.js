import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-'));
Object.assign(process.env, { DATA_DIR: path.join(tmp, 'data'), PORT: '3999', GEMINI_API_KEY: 'test', GEMINI_BASE_URL: 'http://localhost:4010', ALLOW_PRIVATE_URLS: 'true', YT_DLP_BIN: path.resolve('test/fake-ytdlp.sh'), FAKE_LOG: path.join(tmp, 'ytdlp.log'), MIN_FREE_GB: '0.01' });
const { startMock } = await import('./mock-ai.js');
await startMock(4010);
const { server } = await import('../server.js');
await new Promise(r => server.listen(3999, r));
const B = 'http://localhost:3999', ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const video = path.join(tmp, 'in.mp4');
execSync(`ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 90 -pix_fmt yuv420p -shortest ${video}`);
process.env.FAKE_VIDEO = video;
let cookie = '';
const api = async (p, o = {}, ck = cookie) => { const r = await fetch(B + '/api' + p, { ...o, headers: { ...(o.headers || {}), cookie: ck } }); const sc = r.headers.get('set-cookie'); if (sc && !cookie) cookie = sc.split(';')[0]; return r; };
const post = (p, b, ck) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, ck);

let r = await api('/config'); const cfg = await r.json(); ok(cfg.capabilities.speech && cfg.capabilities.analysis, 'config: ключи видны как настроенные');
r = await api('/uploads?name=my%20video.mp4', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: fs.readFileSync(video) });
const src = await r.json(); ok(r.status === 200 && src.width === 1280 && Math.round(src.duration) === 90, `upload + ffprobe: ${src.width}x${src.height}, ${src.duration}s`);
r = await api('/uploads?name=bad.mp4', { method: 'POST', body: Buffer.from('not a video') }); ok(r.status === 400, 'upload: невидео отклонён (400)');
r = await post('/sources', { url: 'ftp://example.com/x' }); ok(r.status === 400, 'sources: не-http ссылка отклонена');
// прямая ссылка на видеофайл (локальный http-сервер)
const fsrv = (await import('node:http')).createServer((q, w) => { if (q.url === '/v.mp4') { w.writeHead(200, { 'content-type': 'video/mp4' }); w.end(fs.readFileSync(video)); } else { w.writeHead(200, { 'content-type': 'text/html' }); w.end('<html></html>'); } }); await new Promise(r => fsrv.listen(4020, r));
r = await post('/sources', { url: 'http://localhost:4020/v.mp4' }); const ds = await r.json(); ok(r.status === 200 && ds.width === 1280 && Math.round(ds.duration) === 90, `sources: прямая ссылка на .mp4 скачана и прочитана (${ds.width}x${ds.height})`);
r = await post('/sources', { url: 'http://localhost:4020/page' }); ok(r.status === 422, 'sources: ссылка на HTML-страницу отклонена');
r = await api(`/sources/${ds.id}/file`, { headers: { range: 'bytes=0-9' } }); ok(r.status === 206, 'sources: исходник доступен для предпросмотра (Range)');
fsrv.close();
r = await post('/projects', { sourceId: src.id, count: 99, duration: 'auto', format: '9:16', quality: 1080, moments: 'best', subs: {} }); ok(r.status === 400, 'projects: count=99 отклонён');

const events = []; const ctl = new AbortController();
const sse = fetch(B + '/api/projects/PLACEHOLDER/events', { signal: ctl.signal }).catch(() => {});
const settings = { sourceId: src.id, count: 3, duration: '15-30', format: '9:16', quality: 1080, moments: 'best', subs: { on: true, srcLang: 'auto', lang: 'auto', size: 'L', font: 'Arial', color: '#FFFFFF', outline: true, pos: 'bottom', anim: 'pop', highlight: true, style: 'bold' } };
r = await post('/projects', settings); const { id: pid } = await r.json(); ok(r.status === 201 && pid, 'projects: создан ' + pid);
const sr = await fetch(`${B}/api/projects/${pid}/events`, { headers: { cookie }, signal: ctl.signal });
(async () => { const rd = sr.body.getReader(), dec = new TextDecoder(); try { for (;;) { const { value, done } = await rd.read(); if (done) break; for (const l of dec.decode(value).split('\n')) if (l.startsWith('data: ')) { const p = JSON.parse(l.slice(6)); events.push([p.stage, p.progress]); } } } catch {} })();
let p; for (let i = 0; i < 120; i++) { p = await (await api('/projects/' + pid)).json(); if (['done', 'partial', 'failed'].includes(p.status)) break; await new Promise(r => setTimeout(r, 1000)); }
ctl.abort();
ok(p.status === 'done', `проект завершён: ${p.status} ${p.error || ''} ${p.notice || ''}`);
ok(p.clips.length === 3 && p.clips.every(c => c.status === 'ready'), `3 отдельных клипа готовы`);
const progs = events.map(e => e[1]); if (progs.some((v, i) => i && v < progs[i - 1])) console.log(JSON.stringify(events)); ok(events.length > 5 && progs.every((v, i) => !i || v >= progs[i - 1]) && new Set(events.map(e => e[0])).size >= 5, `SSE: ${events.length} событий, прогресс монотонный, этапы: ${[...new Set(events.map(e => e[0]))].join(',')}`);
const files = [];
for (const c of p.clips) {
  const f = path.join(tmp, `dl_${c.index}.mp4`); const rr = await api(`/clips/${c.id}/dl`); fs.writeFileSync(f, Buffer.from(await rr.arrayBuffer())); files.push(f);
  const pr = JSON.parse(execSync(`ffprobe -v error -print_format json -show_streams -show_format ${f}`)); const v = pr.streams.find(s => s.codec_type === 'video');
  ok(v.height >= 700 && v.width / v.height < 0.6 && pr.streams.some(s => s.codec_type === 'audio') && Math.abs(+pr.format.duration - c.duration) < 0.6, `clip ${c.index}: ${v.width}x${v.height}, ${(+pr.format.duration).toFixed(1)}s, score ${c.score}, "${c.title}", с аудио`);
}
ok(new Set(files.map(f => fs.readFileSync(f).length)).size >= 1 && files.length === 3, 'файлы скачаны по отдельности');
r = await api(`/clips/${p.clips[0].id}/file`, { headers: { range: 'bytes=0-99' } }); ok(r.status === 206 && (await r.arrayBuffer()).byteLength === 100, 'Range-запрос для плеера (206)');
const zr = await api(`/projects/${pid}/zip`); fs.writeFileSync(path.join(tmp, 'all.zip'), Buffer.from(await zr.arrayBuffer()));
const zl = execSync(`cd ${tmp} && unzip -t all.zip 2>&1`).toString(); ok(/No errors/.test(zl) && ['clip_01.mp4', 'clip_02.mp4', 'clip_03.mp4'].every(n => zl.includes(n)), 'ZIP валиден, внутри 3 отдельных MP4');
r = await api('/projects/' + pid, {}, 'acm_uid=' + 'a'.repeat(32)); ok(r.status === 404, 'доступ: чужой пользователь получает 404');
r = await api('/projects'); const list = await r.json(); ok(list.length === 1 && list[0].clipCount === 3, 'список проектов');
// повторный экспорт из редактора
const c1 = p.clips[0]; r = await post(`/clips/${c1.id}/export`, { start: c1.start + 2, end: c1.end - 2, format: '1:1', subs: false, crop: 'left' }); ok(r.status === 202, 'export: принят');
let cc; for (let i = 0; i < 60; i++) { cc = await (await api('/clips/' + c1.id)).json(); if (cc.status !== 'processing') break; await new Promise(r => setTimeout(r, 500)); }
const f2 = path.join(tmp, 'e.mp4'); fs.writeFileSync(f2, Buffer.from(await (await api(`/clips/${c1.id}/dl`)).arrayBuffer())); const v2 = JSON.parse(execSync(`ffprobe -v error -print_format json -show_streams ${f2}`)).streams.find(s => s.codec_type === 'video');
ok(cc.status === 'ready' && v2.width === v2.height, `повторный экспорт 1:1: ${v2.width}x${v2.height}`);
r = await api(`/clips/${c1.id}/subs?start=${c1.start}&end=${c1.end}&format=9:16`); const sl = await r.json(); ok(r.status === 200 && sl.length > 0 && sl[0].text, `subs: получены ${sl.length} строк субтитров для редактора`);
r = await post(`/clips/${c1.id}/export`, { start: c1.start, end: c1.end, format: '9:16', subs: true, crop: 'auto', lines: sl.map((_, i) => 'Моя строка ' + (i + 1)) }); ok(r.status === 202, 'export: с отредактированными субтитрами принят');
for (let i = 0; i < 60; i++) { cc = await (await api('/clips/' + c1.id)).json(); if (cc.status !== 'processing') break; await new Promise(r => setTimeout(r, 500)); }
ok(cc.status === 'ready', 'export: клип с отредактированными субтитрами создан');
// перевод субтитров
r = await post('/projects', { ...settings, duration: '30', count: 1, subs: { ...settings.subs, lang: 'en', anim: 'word' } }); const p2id = (await r.json()).id; let p2;
for (let i = 0; i < 90; i++) { p2 = await (await api('/projects/' + p2id)).json(); if (['done', 'partial', 'failed'].includes(p2.status)) break; await new Promise(r => setTimeout(r, 1000)); }
ok(p2.status === 'done' && p2.clips.length === 1, 'проект с переводом субтитров (lang=en) завершён: ' + (p2.error || p2.status));
r = await api('/projects/' + p2id, { method: 'DELETE' }); ok(r.status === 200 && !fs.existsSync(path.join(tmp, 'data', 'projects', p2id)), 'удаление проекта чистит диск');
r = await api('/clips/' + p.clips[1].id, { method: 'DELETE' }); const after = await (await api('/projects/' + pid)).json(); ok(after.clips.length === 2 && after.clips.every(c => c.status === 'ready'), 'удаление клипа не затрагивает остальные');
// --- YouTube-ветка через yt-dlp (интеграция нашего кода с внешним бинарником; сам yt-dlp здесь заменён заглушкой) ---
await (await import('../lib/ytdlp.js')).init();
cfg2: { const c = await (await api('/config')).json(); ok(c.ytdlp.available && c.ytdlp.version === '2099.01.01-test' && c.capabilities.youtube, `config: yt-dlp найден, версия ${c.ytdlp.version}`); }
r = await post('/sources', { url: 'https://youtube.com.evil.example/watch?v=abcdefghijk' }); ok(r.status >= 400, 'sources: поддельный хост youtube.com.evil… отклонён');
r = await post('/sources', { url: 'https://youtu.be/abcdefghijk?x=--exec%20touch%20pwned' }); const ys = await r.json(); ok(r.status === 200 && ys.title === 'Fake YT video', 'sources: YouTube-ссылка принята, метаданные получены через yt-dlp');
r = await post('/projects', { ...settings, sourceId: ys.id, count: 1, duration: '15-30', subs: { ...settings.subs, on: false } }); const yp = (await r.json()).id; let ypr;
for (let i = 0; i < 90; i++) { ypr = await (await api('/projects/' + yp)).json(); if (['done', 'partial', 'failed'].includes(ypr.status)) break; await new Promise(r => setTimeout(r, 1000)); }
ok(ypr.status === 'done' && ypr.clips[0]?.status === 'ready', 'YouTube-проект: yt-dlp скачал файл → FFmpeg создал клип: ' + (ypr.error || ypr.status));
const log = fs.readFileSync(path.join(tmp, 'ytdlp.log'), 'utf8'); ok(!log.includes('pwned') && log.includes('-- https://www.youtube.com/watch?v=abcdefghijk') && !log.includes('exec'), 'yt-dlp получает только каноническую ссылку после "--" (без инъекции опций)');
console.log('tmp:', tmp); server.close(); process.exit(process.exitCode || 0);
