import fs from 'node:fs';
import path from 'node:path';
import { C } from './config.js';

const LANGS = { russian: 'ru', english: 'en', spanish: 'es', german: 'de', french: 'fr', italian: 'it', portuguese: 'pt', ukrainian: 'uk', polish: 'pl', turkish: 'tr', japanese: 'ja', korean: 'ko', chinese: 'zh' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, what) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await fn(); } catch (e) { last = e; if (e.aborted || (e.status && e.status < 500 && e.status !== 429)) break; await sleep(1500 * (i + 1)); }
  }
  throw new Error(`${what}: ${last.message}`);
}
async function call(url, opts, signal) {
  let r; try { r = await fetch(url, { ...opts, signal }); } catch (e) { throw e.name === 'AbortError' ? Object.assign(new Error('Отменено'), { aborted: true }) : e; }
  if (!r.ok) { let m = ''; try { const j = await r.json(); m = j.error?.message || j.error || ''; } catch {} throw Object.assign(new Error(`HTTP ${r.status} ${typeof m === 'string' ? m : ''}`.trim()), { status: r.status }); }
  return r.json();
}

// ---- Распознавание речи (OpenAI-совместимый /audio/transcriptions) ----
export async function transcribe(chunks, lang, segSec, onFrac, signal) {
  if (!C.openaiKey) throw new Error('Не задан OPENAI_API_KEY (распознавание речи)');
  const out = { language: '', segments: [], words: [] };
  for (let i = 0; i < chunks.length; i++) {
    const off = i * segSec;
    const j = await withRetry(async () => {
      const fd = new FormData();
      fd.append('file', await fs.openAsBlob(chunks[i]), path.basename(chunks[i]));
      fd.append('model', C.asrModel); fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word'); fd.append('timestamp_granularities[]', 'segment');
      if (lang && lang !== 'auto') fd.append('language', lang);
      return call(C.openaiBase + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + C.openaiKey }, body: fd }, signal);
    }, 'Распознавание речи');
    if (!out.language && j.language) out.language = LANGS[String(j.language).toLowerCase()] || String(j.language).toLowerCase();
    for (const s of j.segments || []) if (s.text?.trim()) out.segments.push({ start: s.start + off, end: s.end + off, text: s.text.trim() });
    for (const w of j.words || []) out.words.push({ start: w.start + off, end: w.end + off, word: String(w.word).trim() });
    onFrac((i + 1) / chunks.length);
  }
  if (!out.segments.length) throw new Error('В видео не найдено речи — анализ по смыслу невозможен.');
  return out;
}

// ---- Языковая модель (Anthropic Messages API) ----
async function llm(system, user, signal, maxTokens = 4096) {
  if (!C.anthropicKey) throw new Error('Не задан ANTHROPIC_API_KEY (анализ содержания)');
  const j = await withRetry(() => call(C.anthropicBase + '/v1/messages', { method: 'POST', headers: { 'x-api-key': C.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: C.llmModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }) }, signal), 'Анализ содержания');
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
const parseJson = t => { const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']')); if (a < 0 || b < a) throw new Error('Модель вернула ответ не в формате JSON'); return JSON.parse(t.slice(a, b + 1)); };

const HINT = { auto: 'Choose the most compelling moments by your own judgement.', best: 'The most interesting moments overall.', funny: 'Funny moments: jokes, punchlines, comic situations.', surprise: 'Unexpected events and plot twists.', emotion: 'Strong emotional reactions and emotional stories.', ideas: 'Important, well-formulated ideas and strong statements.', tips: 'Practical, useful advice.', debate: 'Arguments, disagreements and lively discussion.', mix: 'Maximum variety: different topics and different kinds of moments.' };
export const durRange = d => d === 'auto' ? [20, 90] : d.split('-').map(Number);

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
    const r = parseJson(await llm(system, user, signal));
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
  const r = parseJson(await llm('You translate subtitles. Reply with a JSON array of strings only, same length and order as the input.', `Translate each line to the language with ISO code "${lang}". Keep it short.\n${JSON.stringify(lines)}`, signal, 8000));
  if (!Array.isArray(r) || r.length !== lines.length) throw new Error('Перевод субтитров вернулся в неверном формате');
  return r.map(String);
}
