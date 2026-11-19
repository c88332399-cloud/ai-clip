import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { C } from './config.js';

export function run(cmd, args, { cwd, signal, onOut, timeout } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timer = timeout && setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); onOut && onOut(String(d)); });
    p.stderr.on('data', d => { err += d; if (err.length > 2e5) err = err.slice(-1e5); });
    p.on('error', e => { clearTimeout(timer); rej(e.name === 'AbortError' ? Object.assign(new Error('Отменено'), { aborted: true }) : new Error(`Не удалось запустить ${cmd}: ${e.message}`)); });
    p.on('close', c => { clearTimeout(timer); c === 0 ? res({ out, err }) : rej(Object.assign(new Error(`${path.basename(cmd)} завершился с кодом ${c}: ${err.trim().split('\n').slice(-2).join(' ')}`), { err })); });
  });
}

export async function probe(file) {
  const { out } = await run(C.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = j.streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = j.streams.find(s => s.codec_type === 'audio');
  if (!v) throw new Error('В файле нет видеодорожки');
  const rot = Math.abs(+(v.tags?.rotate ?? v.side_data_list?.find(x => x.rotation !== undefined)?.rotation ?? 0)) % 180 === 90;
  const [n, d] = String(v.r_frame_rate || '30/1').split('/').map(Number);
  const duration = +j.format.duration || +v.duration;
  if (!(duration > 0)) throw new Error('Не удалось определить длительность видео');
  return { duration, width: rot ? v.height : v.width, height: rot ? v.width : v.height, fps: d ? n / d : 30, hasAudio: !!a };
}

export async function extractAudio(src, dir, signal, segSec = 600) {
  fs.mkdirSync(dir, { recursive: true });
  await run(C.ffmpeg, ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'segment', '-segment_time', String(segSec), '-reset_timestamps', '1', path.join(dir, 'a_%03d.mp3')], { signal });
  return fs.readdirSync(dir).filter(f => f.endsWith('.mp3')).sort().map(f => path.join(dir, f));
}

export async function thumb(src, out, at, width = 480) {
  await run(C.ffmpeg, ['-y', '-ss', String(Math.max(0, at)), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out]);
}

const AR = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
const ev = n => Math.max(2, Math.floor(n / 2) * 2);

// Кадр: cover-кроп под нужное соотношение сторон, без растяжения и без апскейла.
export function plan(info, { format, quality, crop }) {
  const ar = AR[format] || AR['9:16'], sar = info.width / info.height;
  let cw, ch, x = 0, y = 0;
  if (sar > ar) { ch = info.height; cw = ev(ch * ar); x = crop === 'left' ? 0 : crop === 'right' ? info.width - cw : (info.width - cw) / 2; }
  else { cw = info.width; ch = ev(cw / ar); y = (info.height - ch) / 2; }
  cw = ev(cw); ch = ev(ch); x = ev(x); y = ev(y);
  const q = Math.min(+quality || 1080, C.maxQuality);
  let W = format === '16:9' ? q * 16 / 9 : q;
  let H = format === '9:16' ? q * 16 / 9 : q;
  let capped = q < (+quality || 1080);
  const f = Math.min(1, cw / W, ch / H);
  if (f < 1) { W *= f; H *= f; capped = true; }
  return { cw, ch, x, y, W: ev(W), H: ev(H), capped };
}

export async function cutClip({ src, info, out, start, end, format, quality, crop, ass, onFrac, signal }) {
  const pl = plan(info, { format, quality, crop }), dur = end - start;
  let vf = `crop=${pl.cw}:${pl.ch}:${pl.x}:${pl.y},scale=${pl.W}:${pl.H}:flags=lanczos,setsar=1`;
  if (ass) vf += `,ass=${ass}`;
  const args = ['-y', '-ss', start.toFixed(3), '-i', src, '-t', dur.toFixed(3), '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', ...(info.fps > 30.5 ? ['-r', '30'] : []),
    ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', path.basename(out)];
  await run(C.ffmpeg, args, { cwd: path.dirname(out), signal, onOut: s => { const l = s.split('\n').filter(x => x.startsWith('out_time_us=')).pop(); const v = l && +l.slice(12) / 1e6 / dur; if (onFrac && isFinite(v)) onFrac(Math.min(1, Math.max(0, v))); } });
  return pl;
}
