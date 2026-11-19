import fs from 'node:fs';
import path from 'node:path';
import { C } from './config.js';
import * as store from './store.js';
import * as media from './media.js';
import * as ai from './ai.js';
import * as yt from './youtube.js';
import { groups, groupText, buildAss } from './subs.js';

const SEG = 600;
const SPAN = { 1: [0, 8], 2: [8, 33], 3: [33, 58], 4: [58, 62], 5: [62, 66], 6: [66, 72], 7: [72, 100] };
const q = [], ctrls = new Map(); let active = 0;
const pump = () => { while (active < C.maxConcurrent && q.length) { active++; q.shift()().finally(() => { active--; pump(); }); } };
const prog = (p, stage, frac = 0) => { const [a, b] = SPAN[stage]; store.update(p, { stage: Math.max(p.stage || 0, stage), progress: Math.max(p.progress || 0, +(a + (b - a) * Math.min(1, Math.max(0, +frac || 0))).toFixed(1)) }); };
const note = (p, t) => { if (!p.notice?.includes(t)) store.update(p, { notice: (p.notice ? p.notice + ' ' : '') + t }); };
const errMsg = e => String(e.message || e).slice(0, 400);

export const abort = id => ctrls.get(id)?.abort();
export function schedule(p) {
  store.update(p, { status: 'queued', stage: 0, progress: 0, error: null, notice: '' });
  q.push(() => runProject(p)); pump();
}

async function runProject(p) {
  if (!store.getProject(p.id)) return;
  const ac = new AbortController(); ctrls.set(p.id, ac);
  try { store.update(p, { status: 'running' }); await core(p, ac.signal); }
  catch (e) { if (!ac.signal.aborted && store.getProject(p.id)) store.update(p, { status: 'failed', error: errMsg(e) }); }
  finally { ctrls.delete(p.id); fs.rmSync(path.join(store.pdir(p.id), 'tmp'), { recursive: true, force: true }); if (store.getProject(p.id)) store.flush(p); }
}

async function ensureSource(p, signal) {
  const src = store.getSource(p.sourceId); if (!src) throw new Error('Исходное видео не найдено (возможно, удалено по сроку хранения). Создайте проект заново.');
  let file = src.file && path.join(store.sdir(src.id), src.file);
  if (!file || !fs.existsSync(file)) {
    if (src.kind !== 'youtube') throw new Error('Файл исходного видео удалён. Загрузите его заново.');
    prog(p, 1, 0);
    src.file = await yt.download(src.url, store.sdir(src.id), p.settings.quality, f => prog(p, 1, f), signal);
    file = path.join(store.sdir(src.id), src.file);
  }
  const info = await media.probe(file);
  if (info.duration > C.maxSourceSec) throw new Error(`Видео длиннее лимита сервера (${Math.round(C.maxSourceSec / 60)} мин).`);
  if (!info.hasAudio) throw new Error('В видео нет звуковой дорожки — распознавание речи невозможно.');
  Object.assign(src, info); store.saveSource(src);
  store.update(p, { source: { ...p.source, duration: info.duration, width: info.width, height: info.height } });
  return { src, file, info };
}

async function core(p, signal) {
  const s = p.settings;
  const { file, info } = await ensureSource(p, signal);
  prog(p, 1, 1);
  // Этап 2: речь
  let tr = store.readJson(p, 'transcript.json');
  if (!tr) {
    prog(p, 2, 0);
    const chunks = await media.extractAudio(file, path.join(store.pdir(p.id), 'tmp', 'audio'), signal, SEG);
    tr = await ai.transcribe(chunks, s.subs.srcLang, SEG, f => prog(p, 2, f), signal);
    store.writeJson(p, 'transcript.json', tr);
    fs.rmSync(path.join(store.pdir(p.id), 'tmp'), { recursive: true, force: true });
  }
  prog(p, 2, 1);
  // Этапы 3-4: смысл и выбор
  let cands = store.readJson(p, 'candidates.json');
  prog(p, 3, 0);
  if (!cands) { cands = await ai.findCandidates(tr, s, s.count, info.duration, f => prog(p, 3, f), signal); store.writeJson(p, 'candidates.json', cands); }
  prog(p, 4, 0);
  const best = ai.selectBest(cands, s.count);
  if (!best.length) throw new Error('Подходящих моментов не найдено. Попробуйте другой тип моментов или длительность.');
  if (best.length < s.count) note(p, `Найдено подходящих моментов: ${best.length} из ${s.count}. Искусственные клипы не добавлялись.`);
  const clips = best.map((c, i) => ({ id: 'c' + (i + 1), index: i + 1, ...c, duration: +(c.end - c.start).toFixed(2), status: 'processing', format: s.format, subs: !!s.subs.on, crop: 'auto' }));
  store.update(p, { clips, total: clips.length }); prog(p, 4, 1);
  // Этапы 5-7: сборка клипов (каждый — отдельный MP4)
  prog(p, 5, 1);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    try { await renderClip(p, c, tr, file, info, signal, st => { if (st.phase === 'subs') prog(p, 6, (i + st.f) / clips.length); else prog(p, 7, (i + st.f) / clips.length); }); }
    catch (e) { if (signal.aborted) throw e; c.status = 'failed'; c.error = errMsg(e); }
    store.update(p, {});
  }
  const ok = clips.filter(c => c.status === 'ready').length;
  store.update(p, { status: ok === clips.length ? 'done' : ok ? 'partial' : 'failed', progress: 100, error: ok ? null : 'Не удалось создать ни одного клипа', stage: 7 });
}

export async function renderClip(p, c, tr, file, info, signal, on = () => {}) {
  const dir = path.join(store.pdir(p.id), 'clips'), out = path.join(dir, c.id + '.mp4'), assName = c.id + '.ass', s = p.settings;
  const pl = media.plan(info, { format: c.format, quality: s.quality, crop: c.crop });
  let ass = null;
  if (c.subs) {
    on({ phase: 'subs', f: 0 });
    const G = groups(tr, c.start, c.end, pl.W > pl.H ? 40 : 22);
    const target = s.subs.lang;
    if (G.length && target && target !== 'auto' && target !== tr.language) {
      const tx = await ai.translate(G.map(groupText), target, signal);
      G.forEach((g, i) => { g.text = tx[i]; g.words = null; });
    }
    fs.writeFileSync(path.join(dir, assName), buildAss(G, { W: pl.W, H: pl.H, s: s.subs })); ass = assName;
    on({ phase: 'subs', f: 1 });
  }
  const res = await media.cutClip({ src: file, info, out, start: c.start, end: c.end, format: c.format, quality: s.quality, crop: c.crop, ass, signal, onFrac: f => on({ phase: 'enc', f }) });
  await media.thumb(out, path.join(dir, c.id + '.jpg'), (c.end - c.start) / 2).catch(() => {});
  if (ass) fs.rmSync(path.join(dir, assName), { force: true });
  if (res.capped) note(p, 'Разрешение клипов ограничено исходником или настройкой сервера (MAX_OUTPUT_QUALITY).');
  c.status = 'ready'; c.error = null; c.size = fs.statSync(out).size;
}

// Повторный экспорт одного клипа из редактора
export function scheduleExport(p, c, params) {
  Object.assign(c, { status: 'processing', error: null, start: params.start, end: params.end, duration: +(params.end - params.start).toFixed(2), format: params.format, crop: params.crop, subs: params.subs });
  store.update(p, {});
  q.push(async () => {
    try {
      const src = store.getSource(p.sourceId), file = src?.file && path.join(store.sdir(src.id), src.file);
      if (!file || !fs.existsSync(file)) throw new Error('Исходное видео удалено — повторный экспорт невозможен.');
      const tr = store.readJson(p, 'transcript.json') || { segments: [], words: [], language: '' };
      await renderClip(p, c, tr, file, await media.probe(file), undefined);
    } catch (e) { c.status = 'failed'; c.error = errMsg(e); }
    if (store.getProject(p.id)) store.update(p, {});
  });
  pump();
}

export function recover() {
  for (const p of store.allProjects()) {
    if (p.status === 'queued') { schedule(p); continue; }
    let dirty = false;
    if (p.status === 'running') { p.status = 'failed'; p.error = 'Сервер был перезапущен во время обработки. Нажмите «Повторить» — готовые этапы будут использованы повторно.'; dirty = true; }
    for (const c of p.clips) if (c.status === 'processing') { c.status = 'failed'; c.error = 'Экспорт был прерван перезапуском сервера'; dirty = true; }
    if (dirty) store.update(p, {});
  }
}
