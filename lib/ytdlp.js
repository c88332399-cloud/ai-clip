// Единственное место, где запускается yt-dlp. Аргументы передаются массивом (spawn без shell), URL — только после "--".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { C } from './config.js';
import { run } from './media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const state = { available: false, bin: null, version: null, jsRuntime: false, error: 'yt-dlp ещё не проверялся', checkedAt: 0 };

const candidates = () => [...new Set([C.ytdlpBin, path.join(ROOT, 'bin', 'yt-dlp'), '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp'].filter(Boolean))];

// Реальная проверка: найти исполняемый файл и получить от него версию.
export async function init() {
  if (!C.ytdlp) { Object.assign(state, { available: false, error: 'Отключено переменной YT_DLP_ENABLED=false', checkedAt: Date.now() }); return state; }
  const tried = [];
  for (const bin of candidates()) {
    try {
      const { out } = await run(bin, ['--version'], { timeout: 20000 });
      let jsRuntime = false;
      try { jsRuntime = (await run(bin, ['--help'], { timeout: 20000 })).out.includes('--js-runtimes'); } catch {}
      Object.assign(state, { available: true, bin, version: out.trim(), jsRuntime, error: null, checkedAt: Date.now() });
      return state;
    } catch (e) { tried.push(`${bin}: ${String(e.message).slice(0, 100)}`); }
  }
  Object.assign(state, { available: false, bin: null, version: null, error: 'yt-dlp не найден. Проверено: ' + tried.join('; '), checkedAt: Date.now() });
  return state;
}

export class MissingError extends Error { constructor() { super('yt-dlp не установлен на сервере'); this.code = 'YTDLP_MISSING'; } }

// args — массив; url добавляется после "--", чтобы его нельзя было принять за опцию.
export async function exec(args, url, { signal, onOut, timeout = 30 * 60e3 } = {}) {
  if (!state.available) await init();
  if (!state.available) throw new MissingError();
  const base = ['--ignore-config', '--no-playlist', '--no-warnings', '--socket-timeout', '30', '--retries', '3', ...(state.jsRuntime ? ['--js-runtimes', 'node'] : [])];
  return run(state.bin, [...base, ...args, '--', url], { signal, onOut, timeout });
}
