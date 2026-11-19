import fs from 'node:fs';
import { C } from './config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LNAME = { ru: 'ru', en: 'en', es: 'es', de: 'de', fr: 'fr' };

async function withRetry(fn, what) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return await fn(); } catch (e) { last = e; if (e.aborted || (e.status && e.status < 500 && e.status !== 429)) break; await sleep(2500 * (i + 1) ** 2); }
  }
  throw new Error(`${what}: ${last.message}`);
}

// ---- Gemini REST (generateContent). Ключ только из переменной окружения, передаётся заголовком ----
async function gemini(model, body, signal) {
  if (!C.geminiKey) throw new Error('Не задан GEMINI_API_KEY');
  let r;
  try { r = await fetch(`${C.geminiBase}/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': C.geminiKey, 'content-type': 'application/json' }, body: JSON.stringify(body), signal }); }
  catch (e) { throw e.name === 'AbortError' ? Object.assign(new Error('Отменено'), { aborted: true }) : e; }
  if (!r.ok) {
    let m = ''; try { m = (await r.json()).error?.message || ''; } catch {}
    const hint = r.status === 429 ? ' (превышен лимит запросов Gemini — подождите минуту или включите оплату в Google AI Studio)' : r.status === 400 && /api key/i.test(m) || r.status === 403 ? ' (проверьте GEMINI_API_KEY и доступ к модели ' + model + ')' : '';
    throw Object.assign(new Error(`HTTP ${r.status} ${m.slice(0, 200)}${hint}`.trim()), { status: r.status });
  }
  const j = await r.json(), c = j.candidates?.[0];
  if (!c) throw Object.assign(new Error('Gemini не вернул ответ' + (j.promptFeedback?.blockReason ? ': ' + j.promptFeedback.blockReason : '')), { status: 422 });
  const text = (c.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  if (!text) throw Object.assign(new Error('Gemini вернул пустой ответ (' + (c.finishReason || '?') + ')'), { status: 422 });
  return text;
}
const parseJson = t => { const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']')); if (a < 0 || b < a) throw new Error('Модель вернула ответ не в формате JSON'); return JSON.parse(t.slice(a, b + 1)); };
const jsonCall = (model, system, parts, schema, signal, maxTokens = 8192) => gemini(model, {
  ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  contents: [{ role: 'user', parts }],
  generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2, maxOutputTokens: maxTokens },
}, signal).then(parseJson);

// ---- Распознавание речи с таймкодами (Gemini, аудио передаётся кусками) ----
const TR_SCHEMA = { type: 'OBJECT', properties: { language: { type: 'STRING' }, segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['start', 'end', 'text'] } } }, required: ['segments'] };
const tsec = v => { if (typeof v === 'number') return v; const p = String(v).trim().split(':').map(Number); if (!p.length || p.some(x => !isFinite(x))) return NaN; return p.reduce((a, b) => a * 60 + b, 0); };

// Gemini даёт время на уровне фраз; слова для караоке-субтитров распределяются внутри фразы пропорционально длине (это оценка, не точная разметка).
function spreadWords(seg) {
  const ws = seg.text.split(/\s+/).filter(Boolean), tot = ws.reduce((a, w) => a + w.length + 1, 0), out = []; let t = seg.start;
  for (const w of ws) { const d = (seg.end - seg.start) * (w.length + 1) / tot; out.push({ start: t, end: t + d, word: w, approx: true }); t += d; }
  return out;
}

export async function transcribe(chunks, lang, segSec, onFrac, signal, chunkLens = []) {
  const out = { language: '', segments: [], words: [] };
  for (let i = 0; i < chunks.length; i++) {
    const off = i * segSec, len = chunkLens[i] || segSec;
    const data = (await fs.promises.readFile(chunks[i])).toString('base64');
    const j = await withRetry(() => jsonCall(C.asrModel, 'You are a precise speech-to-text engine. Output JSON only.', [
      { inlineData: { mimeType: 'audio/mpeg', data } },
      { text: `Transcribe all speech in this audio verbatim${lang && lang !== 'auto' ? ` (language: ${lang})` : ''}. Split it into segments of 2-12 seconds. For each segment give "start" and "end" as MM:SS or MM:SS.s from the START OF THIS AUDIO FILE (not absolute), and "text". Do not translate, do not summarize, do not invent words; skip music and silence. Also return "language" as ISO 639-1 code. If there is no speech return an empty segments array.` }], TR_SCHEMA, signal, 16384), 'Распознавание речи');
    if (!out.language && j.language) out.language = String(j.language).toLowerCase().slice(0, 2);
    let prev = 0;
    for (const s of j.segments || []) {
      let a = tsec(s.start), b = tsec(s.end), text = String(s.text || '').trim();
      if (!text || !isFinite(a)) continue;
      if (!isFinite(b) || b <= a) b = a + Math.max(1.5, text.length / 15);
      a = Math.min(Math.max(a, prev), len); b = Math.min(Math.max(b, a + 0.4), len + 1); prev = b;
      const seg = { start: +(a + off).toFixed(2), end: +(b + off).toFixed(2), text };
      out.segments.push(seg); out.words.push(...spreadWords(seg));
    }
    onFrac((i + 1) / chunks.length);
  }
  if (!out.segments.length) throw new Error('В видео не найдено речи — анализ по смыслу невозможен.');
  out.wordsApprox = true;
  return out;
}

const HINT = { auto: 'Choose the most compelling moments by your own judgement.', best: 'The most interesting moments overall.', funny: 'Funny moments: jokes, punchlines, comic situations.', surprise: 'Unexpected events and plot twists.', emotion: 'Strong emotional reactions and emotional stories.', ideas: 'Important, well-formulated ideas and strong statements.', tips: 'Practical, useful advice.', debate: 'Arguments, disagreements and lively discussion.', mix: 'Maximum variety: different topics and different kinds of moments.' };
export const durRange = d => { if (d === 'auto') return [20, 90]; if (String(d).includes('-')) return String(d).split('-').map(Number); const t = +d; return [Math.max(5, Math.round(t * .65)), Math.round(t * 1.15)]; };

function windows(segs) {
  const W = []; let i = 0;
  while (i < segs.length) {
    let j = i, chars = 0;
    while (j < segs.length && chars < 22000 && segs[j].end - segs[i].start < 1200) chars += segs[j++].text.length + 12;
    W.push(segs.slice(i, j));
    if (j >= segs.length) break;
    let k = j; while (k > i + 1 && segs[k - 1].start > segs[j - 1].end - 60) k--;
    i = Math.max(k, i + 1);
  }
  return W;
}

const CAND_SCHEMA = { type: 'OBJECT', properties: { candidates: { type: 'ARRAY', items: { type: 'OBJECT', properties: { start: { type: 'NUMBER' }, end: { type: 'NUMBER' }, title: { type: 'STRING' }, description: { type: 'STRING' }, reason: { type: 'STRING' }, scores: { type: 'OBJECT', properties: { interest: { type: 'NUMBER' }, standalone: { type: 'NUMBER' }, hook: { type: 'NUMBER' }, clean: { type: 'NUMBER' } } } }, required: ['start', 'end', 'title'] } } }, required: ['candidates'] };
export async function findCandidates(tr, s, total, duration, onFrac, signal) {
  const [mn, mx] = durRange(s.duration), W = windows(tr.segments), per = Math.min(12, Math.max(4, Math.ceil(total * 2.5 / W.length)));
  const system = `You are an expert short-form video editor. You receive a timestamped transcript of a long video and pick the best self-contained moments to cut as standalone short clips. Reply with JSON only.`;
  const all = [];
  for (let w = 0; w < W.length; w++) {
    const text = W[w].map(x => `[${Math.round(x.start)}-${Math.round(x.end)}] ${x.text}`).join('\n');
    const user = `Transcript lines are formatted "[start_sec-end_sec] text".
Goal: ${HINT[s.moments] || HINT.best}
Pick up to ${per} candidate clips from THIS part of the transcript. Rules:
- clip length between ${mn} and ${mx} seconds;
- start and end must be start/end times of transcript lines; start where a thought begins (strong first sentence), end when it is complete;
- the clip must be understandable without the rest of the video; avoid long pauses, filler and repetition;
- do not invent content; do not pick overlapping clips;
- if there are no good moments, return fewer or none. Quality over quantity.
Write "title" (max 70 chars), "description" and "reason" in Russian.
Scores 1-100: interest, standalone, hook (quality of the opening), clean (no filler/repetition).
Return: {"candidates":[{"start":0,"end":0,"title":"","description":"","reason":"","scores":{"interest":0,"standalone":0,"hook":0,"clean":0}}]}

TRANSCRIPT:
${text}`;
    const r = await withRetry(() => jsonCall(C.llmModel, system, [{ text: user }], CAND_SCHEMA, signal), 'Анализ содержания');
    for (const c of r.candidates || []) all.push(c);
    onFrac((w + 1) / W.length);
  }
  return refine(all, tr.segments, mn, mx, duration);
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
function refine(cands, segs, mn, mx, duration) {
  const out = [], nearest = (arr, t) => arr.reduce((b, x) => Math.abs(x - t) < Math.abs(b - t) ? x : b, arr[0]);
  const starts = segs.map(s => s.start), ends = segs.map(s => s.end);
  for (const c of cands) {
    let s = +c.start, e = +c.end; if (!isFinite(s) || !isFinite(e) || e <= s) continue;
    s = nearest(starts, s); e = nearest(ends, e);
    if (e - s > mx) { const ok = ends.filter(x => x > s && x - s <= mx); if (!ok.length) continue; e = ok[ok.length - 1]; }
    if (e - s < mn) { const ok = ends.filter(x => x - s >= mn && x - s <= mx); if (!ok.length) continue; e = ok[0]; }
    if (e - s < Math.min(mn, 5)) continue;
    s = clamp(s - 0.15, 0, duration); e = clamp(e + 0.3, 0, duration);
    const q = c.scores || {}, g = k => clamp(+q[k] || 50, 1, 100);
    out.push({ start: +s.toFixed(2), end: +e.toFixed(2), title: String(c.title || 'Момент').slice(0, 90), description: String(c.description || ''), reason: String(c.reason || ''), score: Math.round(g('interest') * .4 + g('standalone') * .25 + g('hook') * .2 + g('clean') * .15) });
  }
  return out;
}

export function selectBest(cands, n) {
  const chosen = [];
  for (const c of [...cands].sort((a, b) => b.score - a.score)) {
    const dup = chosen.some(x => { const ov = Math.min(x.end, c.end) - Math.max(x.start, c.start); return ov > 0.3 * Math.min(x.end - x.start, c.end - c.start); });
    if (!dup) chosen.push(c);
    if (chosen.length >= n) break;
  }
  return chosen;
}

export async function translate(lines, lang, signal) {
  const schema = { type: 'OBJECT', properties: { lines: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['lines'] };
  const r = await withRetry(() => jsonCall(C.llmModel, 'You translate subtitles. Output JSON only.', [{ text: `Translate each line to the language with ISO 639-1 code "${lang}". Keep it short, same number of lines and same order. Return {"lines":[...]}.\nINPUT:\n${JSON.stringify(lines)}` }], schema, signal), 'Перевод субтитров');
  if (!Array.isArray(r.lines) || r.lines.length !== lines.length) throw new Error('Перевод субтитров вернулся в неверном формате');
  return r.lines.map(String);
}
