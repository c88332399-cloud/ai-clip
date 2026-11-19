import fs from 'node:fs';
import { C } from './config.js';
import { run } from './media.js';

const RX = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{11}/;
export const isYoutube = u => RX.test(u || '');

const friendly = e => {
  const t = (e.err || e.message || '').toLowerCase();
  if (/sign in|not a bot|private|members-only|age|drm|unavailable|copyright|blocked/.test(t))
    return 'YouTube не отдаёт это видео серверу (нужен вход, доступ ограничен или видео защищено). Обход ограничений не выполняется — загрузите файл.';
  if (/enoent|не удалось запустить/.test(t)) return 'На сервере не установлен yt-dlp. Загрузите файл или установите yt-dlp.';
  return 'Не удалось получить видео по ссылке. Загрузите файл. (' + (e.err || e.message).trim().split('\n').pop().slice(0, 160) + ')';
};

export async function meta(url, signal) {
  if (!C.ytdlp) throw Object.assign(new Error('Загрузка по ссылкам отключена на сервере. Загрузите файл.'), { status: 400 });
  try {
    const { out } = await run(C.ytdlpBin, ['-J', '--no-playlist', '--no-warnings', url], { signal, timeout: 60000 });
    const j = JSON.parse(out);
    if (j.is_live) throw Object.assign(new Error('Прямые эфиры не поддерживаются. Дождитесь записи или загрузите файл.'), { status: 400 });
    const h = Math.max(...(j.formats || []).map(f => f.height || 0), 0);
    return { title: j.title, duration: j.duration, width: h ? Math.round(h * 16 / 9) : undefined, height: h || undefined, thumbnail: j.thumbnail, channel: j.uploader };
  } catch (e) { throw e.status ? e : Object.assign(new Error(friendly(e)), { status: 422 }); }
}

export async function download(url, dir, quality, onFrac, signal) {
  const h = Math.min(C.maxSourceHeight, Math.max(720, +quality || 1080));
  let streams = 0;
  try {
    await run(C.ytdlpBin, ['--no-playlist', '--no-warnings', '--newline', '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4', '-o', `${dir}/video.%(ext)s`, url],
      { signal, onOut: s => { for (const l of s.split('\n')) { if (l.includes('Destination:')) streams++; const m = /\[download\]\s+([\d.]+)%/.exec(l); if (m && onFrac) onFrac(Math.min(0.99, ((Math.max(1, streams) - 1) + m[1] / 100) / Math.max(2, streams))); } } });
  } catch (e) { throw e.aborted ? e : new Error(friendly(e)); }
  const f = fs.readdirSync(dir).find(n => n.startsWith('video.') && !n.endsWith('.part'));
  if (!f) throw new Error('Видео не было скачано. Загрузите файл.');
  return f;
}
