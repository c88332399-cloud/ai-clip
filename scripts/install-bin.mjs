// Запускается при каждой сборке (npm install -> postinstall). Скачивает yt-dlp (официальный standalone-файл) в ./bin,
// если его нет в системе. Если FFmpeg в системе нет (обычный Node-сервис Render) — пробует скачать статическую сборку.
// Сбой не роняет сборку: сервер при старте сам проверит наличие и покажет причину.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const has = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 20000 }).status === 0;
const log = (...a) => console.log('[install-bin]', ...a);
if (process.platform !== 'linux') { log('пропуск: не Linux'); process.exit(0); }
fs.mkdirSync(BIN, { recursive: true });
const arm = os.arch() === 'arm64';

async function get(url, dest) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

try {
  if (has('yt-dlp') ) log('yt-dlp уже есть в системе');
  else {
    const dest = path.join(BIN, 'yt-dlp');
    await get(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${arm ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'}`, dest);
    fs.chmodSync(dest, 0o755);
    const v = spawnSync(dest, ['--version'], { encoding: 'utf8', timeout: 30000 });
    if (v.status !== 0) throw new Error('скачанный yt-dlp не запускается: ' + (v.stderr || v.error));
    log('yt-dlp установлен:', v.stdout.trim(), '->', dest);
  }
} catch (e) { console.error('[install-bin] ОШИБКА yt-dlp:', e.message); }

try {
  if (has('ffmpeg', ['-version']) && has('ffprobe', ['-version'])) log('ffmpeg/ffprobe уже есть в системе');
  else {
    const tar = path.join(BIN, 'ffmpeg.tar.xz');
    await get(`https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arm ? 'arm64' : 'amd64'}-static.tar.xz`, tar);
    const x = spawnSync('tar', ['-xJf', tar, '-C', BIN, '--strip-components=1', '--wildcards', '*/ffmpeg', '*/ffprobe'], { encoding: 'utf8' });
    fs.rmSync(tar, { force: true });
    if (x.status !== 0) throw new Error('не удалось распаковать: ' + x.stderr);
    log('ffmpeg установлен в', BIN);
  }
} catch (e) { console.error('[install-bin] ОШИБКА ffmpeg:', e.message); }
