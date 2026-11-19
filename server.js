import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { C, missingKeys } from './lib/config.js';
import * as store from './lib/store.js';
import * as media from './lib/media.js';
import * as yt from './lib/youtube.js';
import * as pipe from './lib/pipeline.js';
import { zipTo } from './lib/zip.js';
import * as remote from './lib/remote.js';
import * as ytdlp from './lib/ytdlp.js';
import { groups, groupText } from './lib/subs.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj ?? {})); };
const readBody = (req, max = 1e6) => new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > max) { no(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { no(new HttpError(400, 'Некорректный JSON')); } }); req.on('error', no); });
function owner(req, res) {
  const m = /(?:^|;\s*)acm_uid=([a-f0-9]{32})/.exec(req.headers.cookie || ''); if (m) return m[1];
  const id = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `acm_uid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`); return id;
}
const freeBytes = async () => { const s = await fs.promises.statfs(C.dataDir); return s.bavail * s.bsize; };
const needSpace = async (extra = 0) => { if (await freeBytes() - extra < C.minFreeBytes) throw new HttpError(507, 'На сервере недостаточно свободного места. Попробуйте позже.'); };
const pubSource = s => ({ id: s.id, title: s.title, duration: s.duration, width: s.width, height: s.height, thumbnail: s.thumbnail || `/api/sources/${s.id}/thumb` });

function serveFile(req, res, file, type, dlName) {
  let st; try { st = fs.statSync(file); } catch { throw new HttpError(404, 'Файл не найден'); }
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=60' };
  if (dlName) h['Content-Disposition'] = `attachment; filename="${dlName}"`;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    let a = m[1] === '' ? st.size - +m[2] : +m[1], b = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (!(a >= 0 && a <= b && a < st.size)) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
    return fs.createReadStream(file, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...h, 'Content-Length': st.size }); fs.createReadStream(file).pipe(res);
}

const ENUM = { count: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15], duration: ['auto', '15', '30', '45', '60', '90', '15-30', '30-60', '60-90', '90-180'], format: ['9:16', '1:1', '16:9'], quality: [720, 1080, 1440, 2160], moments: ['auto', 'best', 'funny', 'surprise', 'emotion', 'ideas', 'tips', 'debate', 'mix'] };
function validateSettings(b) {
  const bad = k => new HttpError(400, `Некорректное значение параметра «${k}»`);
  const s = { count: +b.count, duration: String(b.duration), format: String(b.format), quality: +b.quality, moments: String(b.moments) };
  for (const k of Object.keys(ENUM)) if (!ENUM[k].includes(s[k])) throw bad(k);
  const u = b.subs || {}, L = ['auto', 'ru', 'en', 'es', 'de', 'fr'];
  s.subs = { on: !!u.on, srcLang: L.includes(u.srcLang) ? u.srcLang : 'auto', lang: L.includes(u.lang) ? u.lang : 'auto', size: ['S', 'M', 'L'].includes(u.size) ? u.size : 'M', font: String(u.font || 'Arial').replace(/[^\w ]/g, '').slice(0, 40) || 'Arial',
    color: /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : '#FFFFFF', outline: u.outline !== false, pos: ['bottom', 'center', 'top'].includes(u.pos) ? u.pos : 'bottom', anim: ['none', 'pop', 'word', 'fade'].includes(u.anim) ? u.anim : 'none', highlight: !!u.highlight, style: String(u.style || '').slice(0, 20) };
  return s;
}
const hits = new Map();
function rateLimit(uid) { const now = Date.now(), a = (hits.get(uid) || []).filter(t => now - t < 3600e3); if (a.length >= C.maxProjectsPerHour) throw new HttpError(429, 'Слишком много запусков за час. Попробуйте позже.'); a.push(now); hits.set(uid, a); }
function own(req, res, uid, pid) { const p = store.getProject(pid); if (!p || p.owner !== uid) throw new HttpError(404, 'Проект не найден'); return p; }
function clipOf(uid, cid) { const [pid, id] = String(cid).split('.'); const p = store.getProject(pid); const c = p && p.owner === uid && p.clips.find(x => x.id === id); if (!c) throw new HttpError(404, 'Клип не найден'); return [p, c]; }
const clipPath = (p, c, ext) => path.join(store.pdir(p.id), 'clips', c.id + ext);
const num = n => String(n).padStart(2, '0');

async function upload(req, res, uid, url) {
  const len = +req.headers['content-length'] || 0;
  if (len > C.maxUploadBytes) throw new HttpError(413, `Файл больше лимита ${Math.round(C.maxUploadBytes / 1048576)} МБ`);
  await needSpace(len);
  const id = store.newId(), dir = store.sdir(id); fs.mkdirSync(dir, { recursive: true });
  const name = (url.searchParams.get('name') || 'video').slice(0, 150), ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.mp4'])[0], file = 'video' + ext, fp = path.join(dir, file);
  try {
    let n = 0;
    await new Promise((ok, no) => { const ws = fs.createWriteStream(fp); req.on('data', d => { n += d.length; if (n > C.maxUploadBytes) { no(new HttpError(413, 'Файл превышает лимит загрузки')); req.destroy(); ws.destroy(); } }); req.on('error', no); ws.on('error', no); ws.on('finish', ok); req.pipe(ws); });
    let info; try { info = await media.probe(fp); } catch { throw new HttpError(400, 'Не удалось прочитать файл как видео. Проверьте формат.'); }
    if (info.duration > C.maxSourceSec) throw new HttpError(400, `Видео длиннее лимита сервера (${Math.round(C.maxSourceSec / 60)} мин).`);
    await media.thumb(fp, path.join(dir, 'thumb.jpg'), info.duration * 0.1).catch(() => {});
    const s = { id, owner: uid, kind: 'upload', title: path.basename(name, path.extname(name)) || 'Видео', file, createdAt: Date.now(), ...info };
    store.saveSource(s); send(res, 200, pubSource(s));
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}

async function route(req, res, url) {
  const uid = owner(req, res), seg = url.pathname.split('/').filter(Boolean), m = req.method;
  if (m !== 'GET' && m !== 'HEAD' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Запрещённый источник запроса');
  if (seg[0] !== 'api') return staticFile(req, res, url);
  const a = seg[1], id = seg[2], sub = seg[3];

  if (a === 'config' && m === 'GET') return send(res, 200, { maxUploadMb: Math.round(C.maxUploadBytes / 1048576), maxQuality: C.maxQuality, capabilities: { speech: !!C.geminiKey, analysis: !!C.geminiKey, youtube: ytdlp.state.available, directLinks: true }, ytdlp: { available: ytdlp.state.available, version: ytdlp.state.version, error: ytdlp.state.available ? null : ytdlp.state.error }, missing: missingKeys() });
  if (a === 'sources' && !id && m === 'POST') {
    const { url: u0 } = await readBody(req), u = String(u0 || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new HttpError(400, 'Вставьте ссылку, начинающуюся с http:// или https://');
    await needSpace();
    if (yt.isYoutube(u)) {
      const cu = yt.canonical(u), md = await yt.meta(cu);
      if (md.duration > C.maxSourceSec) throw new HttpError(400, `Видео длиннее лимита сервера (${Math.round(C.maxSourceSec / 60)} мин).`);
      const s = { id: store.newId(), owner: uid, kind: 'youtube', url: cu, createdAt: Date.now(), ...md }; store.saveSource(s);
      return send(res, 200, pubSource(s));
    }
    // прямая ссылка на видеофайл
    const id2 = store.newId(), dir = store.sdir(id2); fs.mkdirSync(dir, { recursive: true });
    try {
      const d = await remote.downloadDirect(u, dir);
      let info; try { info = await media.probe(path.join(dir, d.file)); } catch { throw new HttpError(422, 'Файл по ссылке не удалось прочитать как видео. Проверьте формат или загрузите файл.'); }
      if (info.duration > C.maxSourceSec) throw new HttpError(400, `Видео длиннее лимита сервера (${Math.round(C.maxSourceSec / 60)} мин).`);
      await media.thumb(path.join(dir, d.file), path.join(dir, 'thumb.jpg'), info.duration * 0.1).catch(() => {});
      const s = { id: id2, owner: uid, kind: 'upload', title: d.name, file: d.file, createdAt: Date.now(), ...info }; store.saveSource(s);
      return send(res, 200, pubSource(s));
    } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  }
  if (a === 'sources' && id && sub === 'file' && m === 'GET') { const s = store.getSource(id); if (!s || s.owner !== uid || !s.file) throw new HttpError(404, 'Не найдено'); return serveFile(req, res, path.join(store.sdir(id), s.file), 'video/mp4'); }
  if (a === 'sources' && id && sub === 'thumb') { const s = store.getSource(id); if (!s || s.owner !== uid) throw new HttpError(404, 'Не найдено'); return serveFile(req, res, path.join(store.sdir(id), 'thumb.jpg'), 'image/jpeg'); }
  if (a === 'uploads' && m === 'POST') return upload(req, res, uid, url);

  if (a === 'projects') {
    if (!id && m === 'GET') return send(res, 200, store.listProjects(uid).map(store.publicProject).map(({ clips, ...r }) => r));
    if (!id && m === 'POST') {
      const b = await readBody(req), s = validateSettings(b), src = store.getSource(String(b.sourceId));
      if (!src || src.owner !== uid) throw new HttpError(404, 'Источник не найден — подтвердите ссылку или загрузите файл заново');
      const miss = missingKeys(); if (miss.length) throw new HttpError(503, 'На сервере не настроены ключи: ' + miss.join(', ') + '. См. .env.example.');
      rateLimit(uid);
      await needSpace();
      const p = store.createProject({ id: store.newId(), owner: uid, sourceId: src.id, title: src.title, createdAt: Date.now(), status: 'queued', stage: 0, progress: 0, ready: 0, total: s.count, notice: '', error: null, settings: s, source: pubSource(src), clips: [] });
      pipe.schedule(p); return send(res, 201, { id: p.id });
    }
    const p = own(req, res, uid, id);
    if (!sub && m === 'GET') return send(res, 200, store.publicProject(p));
    if (!sub && m === 'DELETE') { pipe.abort(p.id); store.deleteProject(p.id); return send(res, 200, { ok: true }); }
    if (sub === 'retry' && m === 'POST') {
      if (p.status === 'running' || p.status === 'queued') throw new HttpError(409, 'Проект уже обрабатывается');
      const miss = missingKeys(); if (miss.length && !store.readJson(p, 'transcript.json')) throw new HttpError(503, 'Не настроены ключи: ' + miss.join(', '));
      fs.rmSync(path.join(store.pdir(p.id), 'candidates.json'), { force: true });
      for (const f of fs.readdirSync(path.join(store.pdir(p.id), 'clips'))) fs.rmSync(path.join(store.pdir(p.id), 'clips', f), { force: true });
      store.update(p, { clips: [], total: p.settings.count }); pipe.schedule(p); return send(res, 200, { ok: true });
    }
    if (sub === 'events' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const push = pp => res.write(`data: ${JSON.stringify(store.publicProject(pp))}\n\n`);
      push(p); store.bus.on(p.id, push); const hb = setInterval(() => res.write(': ping\n\n'), 20000);
      return req.on('close', () => { store.bus.off(p.id, push); clearInterval(hb); });
    }
    if (sub === 'zip' && m === 'GET') {
      const files = p.clips.filter(c => c.status === 'ready' && fs.existsSync(clipPath(p, c, '.mp4'))).map(c => ({ name: `clip_${num(c.index)}.mp4`, path: clipPath(p, c, '.mp4') }));
      if (!files.length) throw new HttpError(404, 'Нет готовых клипов');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="clips_${p.id}.zip"` });
      return zipTo(res, files);
    }
  }

  if (a === 'clips' && id) {
    const [p, c] = clipOf(uid, id);
    if (!sub && m === 'GET') return send(res, 200, { ...store.publicProject({ ...p, clips: [c] }).clips[0], sourceId: p.sourceId, sourceDuration: store.getSource(p.sourceId)?.duration });
    if (!sub && m === 'DELETE') {
      for (const e of ['.mp4', '.jpg']) fs.rmSync(clipPath(p, c, e), { force: true });
      const clips = p.clips.filter(x => x !== c); store.update(p, { clips, total: clips.length, status: clips.length && clips.every(x => x.status === 'ready') ? 'done' : p.status });
      return send(res, 200, { ok: true });
    }
    if (sub === 'file' && m === 'GET') { if (c.status !== 'ready') throw new HttpError(404, 'Клип ещё не готов'); return serveFile(req, res, clipPath(p, c, '.mp4'), 'video/mp4', url.searchParams.has('dl') ? `clip_${num(c.index)}.mp4` : null); }
    if (sub === 'dl' && m === 'GET') { if (c.status !== 'ready') throw new HttpError(404, 'Клип ещё не готов'); return serveFile(req, res, clipPath(p, c, '.mp4'), 'video/mp4', `clip_${num(c.index)}.mp4`); }
    if (sub === 'thumb' && m === 'GET') return serveFile(req, res, clipPath(p, c, '.jpg'), 'image/jpeg');
    if (sub === 'subs' && m === 'GET') {
      const st = +url.searchParams.get('start'), en = +url.searchParams.get('end'), wide = url.searchParams.get('format') === '16:9';
      if (!(st >= 0 && en > st)) throw new HttpError(400, 'Некорректные границы клипа');
      const tr = store.readJson(p, 'transcript.json'); if (!tr) throw new HttpError(404, 'Транскрипция недоступна');
      const G = groups(tr, st, en, wide ? 40 : 22); return send(res, 200, G.map(g => ({ start: +g.start.toFixed(2), end: +g.end.toFixed(2), text: groupText(g) })));
    }
    if (sub === 'export' && m === 'POST') {
      if (c.status === 'processing') throw new HttpError(409, 'Клип уже экспортируется');
      const b = await readBody(req), src = store.getSource(p.sourceId), dur = src?.duration || Infinity;
      const start = +b.start, end = +b.end;
      if (!(start >= 0 && end > start && end <= dur + 0.5)) throw new HttpError(400, 'Некорректные границы клипа');
      if (end - start < 1 || end - start > 600) throw new HttpError(400, 'Длительность клипа должна быть от 1 секунды до 10 минут');
      if (!ENUM.format.includes(b.format)) throw new HttpError(400, 'Некорректный формат');
      await needSpace();
      const lines = Array.isArray(b.lines) && b.lines.length ? b.lines.slice(0, 500).map(x => String(x).slice(0, 300)) : null;
      pipe.scheduleExport(p, c, { start, end: Math.min(end, dur), format: b.format, crop: ['auto', 'center', 'left', 'right'].includes(b.crop) ? b.crop : 'auto', subs: !!b.subs, lines });
      return send(res, 202, { ok: true });
    }
  }
  throw new HttpError(404, 'Не найдено');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png' };
function staticFile(req, res, url) {
  const p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\\/])+/, ''), f = path.join(PUB, p === path.sep || p === '.' ? 'index.html' : p);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return serveFile(req, res, path.join(PUB, 'index.html'), MIME['.html']);
  serveFile(req, res, f, MIME[path.extname(f)] || 'application/octet-stream');
}

export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
  try { await route(req, res, new URL(req.url, 'http://x')); }
  catch (e) { if (res.headersSent) return res.end(); const st = e.status || 500; if (st === 500) console.error(e); send(res, st, { error: st === 500 ? 'Внутренняя ошибка сервера' : e.message }); }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ytdlp.init(); console.log(ytdlp.state.available ? `yt-dlp ${ytdlp.state.version} (${ytdlp.state.bin})` : `yt-dlp НЕ НАЙДЕН: ${ytdlp.state.error}`);
  pipe.recover(); store.cleanup(); setInterval(store.cleanup, 3600e3).unref();
  server.requestTimeout = 0; server.listen(C.port, () => console.log(`AI Clip Maker: http://localhost:${C.port}  | ключи отсутствуют: ${missingKeys().join(', ') || 'нет'}`));
}
