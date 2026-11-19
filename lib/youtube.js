import fs from 'node:fs';
import { C } from './config.js';
import * as ytdlp from './ytdlp.js';

// Допускаются только ссылки YouTube; ссылка приводится к каноническому виду (защита от инъекций опций и подмены хоста).
export function canonical(u) {
  let x; try { x = new URL(String(u || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(x.protocol) || x.username || x.password) return null;
  const h = x.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, ''); let id;
  if (h === 'youtube.com') { if (x.pathname === '/watch') id = x.searchParams.get('v'); else { const m = /^\/(shorts|live|embed)\/([\w-]{11})\/?$/.exec(x.pathname); id = m && m[2]; } }
  else if (h === 'youtu.be') id = x.pathname.replace(/^\//, '').replace(/\/$/, '');
  return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : null;
}
export const isYoutube = u => !!canonical(u);

const friendly = e => {
  if (e.code === 'YTDLP_MISSING') return 'На сервере не найден yt-dlp (' + (ytdlp.state.error || '') + '). Загрузите файл или вставьте прямую ссылку на .mp4.';
  const t = (e.err || e.message || '').toLowerCase();
  if (/sign in|not a bot|private|members-only|age|drm|unavailable|copyright|blocked|403/.test(t))
    return 'YouTube не отдаёт это видео серверу (нужен вход, доступ ограничен, видео защищено или YouTube блокирует запросы с серверов). Обход ограничений не выполняется — загрузите файл.';
  if (/timed out|killed|sigkill/.test(t)) return 'Превышено время ожидания при получении видео. Загрузите файл.';
  return 'Не удалось получить видео по ссылке. Загрузите файл. (' + (e.err || e.message).trim().split('\n').pop().slice(0, 160) + ')';
};

export async function meta(url, signal) {
  if (!C.ytdlp) throw Object.assign(new Error('Загрузка по ссылкам YouTube отключена на сервере. Загрузите файл.'), { status: 400 });
  const u = canonical(url); if (!u) throw Object.assign(new Error('Некорректная ссылка YouTube'), { status: 400 });
  try {
    const { out } = await ytdlp.exec(['-J'], u, { signal, timeout: 60000 });
    const j = JSON.parse(out);
    if (j.is_live) throw Object.assign(new Error('Прямые эфиры не поддерживаются. Дождитесь записи или загрузите файл.'), { status: 400 });
    const h = Math.max(...(j.formats || []).map(f => f.height || 0), 0);
    return { title: j.title, duration: j.duration, width: h ? Math.round(h * 16 / 9) : undefined, height: h || undefined, thumbnail: j.thumbnail, channel: j.uploader };
  } catch (e) { throw e.status ? e : Object.assign(new Error(friendly(e)), { status: 422 }); }
}

export async function download(url, dir, quality, onFrac, signal) {
  const u = canonical(url); if (!u) throw new Error('Некорректная ссылка YouTube');
  const h = Math.min(C.maxSourceHeight, Math.max(720, +quality || 1080));
  let streams = 0;
  try {
    await ytdlp.exec(['--newline', '--max-filesize', String(C.maxUploadBytes), '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4', '-o', `${dir}/video.%(ext)s`], u,
      { signal, onOut: s => { for (const l of s.split('\n')) { if (l.includes('Destination:')) streams++; const m = /\[download\]\s+([\d.]+)%/.exec(l); if (m && onFrac) onFrac(Math.min(0.99, ((Math.max(1, streams) - 1) + m[1] / 100) / Math.max(2, streams))); } } });
  } catch (e) { throw e.aborted ? e : new Error(friendly(e)); }
  const f = fs.readdirSync(dir).find(n => n.startsWith('video.') && !n.endsWith('.part'));
  if (!f) throw new Error('Видео не было скачано. Загрузите файл.');
  return f;
}
