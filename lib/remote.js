import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { C } from './config.js';

const bad = (status, msg) => Object.assign(new Error(msg), { status });
const EXT = /\.(mp4|mov|webm|mkv|m4v|avi|flv|wmv|mpg|mpeg|ts|3gp)$/i;

function privateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const x = ip.toLowerCase(); if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
}
async function checkHost(u) {
  if (!/^https?:$/.test(u.protocol)) throw bad(400, 'Поддерживаются только http(s)-ссылки');
  if (C.allowPrivateUrls) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw bad(422, 'Не удалось найти сервер по ссылке'); });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw bad(400, 'Ссылки на внутренние адреса запрещены');
}

// Скачивание прямой ссылки на видеофайл (например https://site.com/video.mp4). Редиректы проверяются на каждом шаге (защита от SSRF).
export async function downloadDirect(rawUrl, dir, signal) {
  let u; try { u = new URL(rawUrl); } catch { throw bad(400, 'Некорректная ссылка'); }
  let r;
  for (let hop = 0; hop < 5; hop++) {
    await checkHost(u);
    try { r = await fetch(u, { redirect: 'manual', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30 * 60e3)]), headers: { 'user-agent': 'AIClipMaker/1.0' } }); }
    catch { throw bad(422, 'Не удалось подключиться по ссылке. Загрузите файл.'); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u); continue; }
    break;
  }
  if (r.status >= 300 && r.status < 400) throw bad(422, 'Слишком много перенаправлений');
  if (!r.ok) throw bad(422, `Сервер по ссылке ответил ошибкой ${r.status}. Если доступ закрыт — загрузите файл.`);
  const type = (r.headers.get('content-type') || '').toLowerCase(), len = +r.headers.get('content-length') || 0;
  if (/text\/html|application\/json/.test(type) && !EXT.test(u.pathname)) throw bad(422, 'По ссылке открывается веб-страница, а не видеофайл. Нужна прямая ссылка на файл (.mp4, .mov, .webm). Для YouTube используйте ссылку youtube.com/watch?v=…');
  if (len > C.maxUploadBytes) throw bad(413, `Файл больше лимита ${Math.round(C.maxUploadBytes / 1048576)} МБ`);
  const ext = (path.extname(u.pathname).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [type.includes('webm') ? '.webm' : '.mp4'])[0], file = 'video' + ext, fp = path.join(dir, file);
  let n = 0;
  const limit = async function* (src) { for await (const ch of src) { n += ch.length; if (n > C.maxUploadBytes) throw bad(413, 'Файл превышает лимит загрузки'); yield ch; } };
  try { await pipeline(Readable.fromWeb(r.body), limit, fs.createWriteStream(fp)); } catch (e) { if (e.status) throw e; throw bad(422, 'Загрузка по ссылке прервалась. Загрузите файл.'); }
  return { file, name: decodeURIComponent(path.basename(u.pathname, path.extname(u.pathname))) || 'Видео' };
}
