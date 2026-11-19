import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-'));
Object.assign(process.env, { DATA_DIR: path.join(tmp, 'data'), PORT: '3999', OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', OPENAI_BASE_URL: 'http://localhost:4010/v1', ANTHROPIC_BASE_URL: 'http://localhost:4010', MIN_FREE_GB: '0.01' });
const { startMock } = await import('./mock-ai.js');
await startMock(4010);
const { server } = await import('../server.js');
await new Promise(r => server.listen(3999, r));
const B = 'http://localhost:3999', ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const video = path.join(tmp, 'in.mp4');
execSync(`ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 90 -pix_fmt yuv420p -shortest ${video}`);
let cookie = '';
const api = async (p, o = {}, ck = cookie) => { const r = await fetch(B + '/api' + p, { ...o, headers: { ...(o.headers || {}), cookie: ck } }); const sc = r.headers.get('set-cookie'); if (sc && !cookie) cookie = sc.split(';')[0]; return r; };
const post = (p, b, ck) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, ck);

let r = await api('/config'); const cfg = await r.json(); ok(cfg.capabilities.speech && cfg.capabilities.analysis, 'config: ключи видны как настроенные');
r = await api('/uploads?name=my%20video.mp4', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: fs.readFileSync(video) });
const src = await r.json(); ok(r.status === 200 && src.width === 1280 && Math.round(src.duration) === 90, `upload + ffprobe: ${src.width}x${src.height}, ${src.duration}s`);
r = await api('/uploads?name=bad.mp4', { method: 'POST', body: Buffer.from('not a video') }); ok(r.status === 400, 'upload: невидео отклонён (400)');
r = await post('/sources', { url: 'https://example.com/x' }); ok(r.status === 400, 'sources: не-YouTube ссылка отклонена');
r = await post('/projects', { sourceId: src.id, count: 99, duration: 'auto', format: '9:16', quality: 1080, moments: 'best', subs: {} }); ok(r.status === 400, 'projects: count=99 отклонён');

const events = []; const ctl = new AbortController();
const sse = fetch(B + '/api/projects/PLACEHOLDER/events', { signal: ctl.signal }).catch(() => {});
const settings = { sourceId: src.id, count: 3, duration: '15-30', format: '9:16', quality: 1080, moments: 'best', subs: { on: true, srcLang: 'auto', lang: 'ru', size: 'L', font: 'Arial', color: '#FFFFFF', outline: true, pos: 'bottom', anim: 'pop', highlight: true, style: 'bold' } };
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
// перевод субтитров
r = await post('/projects', { ...settings, count: 1, subs: { ...settings.subs, lang: 'en', anim: 'word' } }); const p2id = (await r.json()).id; let p2;
for (let i = 0; i < 90; i++) { p2 = await (await api('/projects/' + p2id)).json(); if (['done', 'partial', 'failed'].includes(p2.status)) break; await new Promise(r => setTimeout(r, 1000)); }
ok(p2.status === 'done' && p2.clips.length === 1, 'проект с переводом субтитров (lang=en) завершён: ' + (p2.error || p2.status));
r = await api('/projects/' + p2id, { method: 'DELETE' }); ok(r.status === 200 && !fs.existsSync(path.join(tmp, 'data', 'projects', p2id)), 'удаление проекта чистит диск');
r = await api('/clips/' + p.clips[1].id, { method: 'DELETE' }); const after = await (await api('/projects/' + pid)).json(); ok(after.clips.length === 2 && after.clips.every(c => c.status === 'ready'), 'удаление клипа не затрагивает остальные');
console.log('tmp:', tmp); server.close(); process.exit(process.exitCode || 0);
