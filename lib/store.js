import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { C } from './config.js';

export const bus = new EventEmitter(); bus.setMaxListeners(0);
const PD = path.join(C.dataDir, 'projects'), SD = path.join(C.dataDir, 'sources');
fs.mkdirSync(PD, { recursive: true }); fs.mkdirSync(SD, { recursive: true });
export const newId = () => crypto.randomBytes(6).toString('hex');
export const pdir = id => path.join(PD, id);
export const sdir = id => path.join(SD, id);
const ID = /^[a-f0-9]{12}$/;
const cache = new Map(), timers = new Map();
const atomic = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

export function getProject(id) {
  if (!ID.test(id || '')) return null;
  if (cache.has(id)) return cache.get(id);
  try { const p = JSON.parse(fs.readFileSync(path.join(pdir(id), 'project.json'))); cache.set(id, p); return p; } catch { return null; }
}
export function createProject(p) { fs.mkdirSync(path.join(pdir(p.id), 'clips'), { recursive: true }); cache.set(p.id, p); flush(p); return p; }
export function flush(p) { clearTimeout(timers.get(p.id)); timers.delete(p.id); if (fs.existsSync(pdir(p.id))) atomic(path.join(pdir(p.id), 'project.json'), p); }
export function update(p, patch = {}) {
  Object.assign(p, patch); p.ready = p.clips.filter(c => c.status === 'ready').length;
  bus.emit(p.id, p);
  if (!timers.has(p.id)) timers.set(p.id, setTimeout(() => flush(p), 600));
}
export const allProjects = () => fs.readdirSync(PD).map(getProject).filter(Boolean);
export const listProjects = owner => allProjects().filter(p => p.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
export function getSource(id) { if (!ID.test(id || '')) return null; try { return JSON.parse(fs.readFileSync(path.join(sdir(id), 'meta.json'))); } catch { return null; } }
export function saveSource(s) { fs.mkdirSync(sdir(s.id), { recursive: true }); atomic(path.join(sdir(s.id), 'meta.json'), s); }
export const readJson = (p, name) => { try { return JSON.parse(fs.readFileSync(path.join(pdir(p.id), name))); } catch { return null; } };
export const writeJson = (p, name, o) => atomic(path.join(pdir(p.id), name), o);

export function deleteProject(id) {
  const p = getProject(id); cache.delete(id); clearTimeout(timers.get(id)); timers.delete(id);
  fs.rmSync(pdir(id), { recursive: true, force: true });
  if (p && !allProjects().some(x => x.sourceId === p.sourceId)) fs.rmSync(sdir(p.sourceId), { recursive: true, force: true });
}
export function cleanup() {
  const now = Date.now();
  for (const p of allProjects()) if (now - p.createdAt > C.retentionMs && p.status !== 'running') deleteProject(p.id);
  const used = new Set(allProjects().map(p => p.sourceId));
  for (const id of fs.readdirSync(SD)) { const d = sdir(id); try { if (!used.has(id) && now - fs.statSync(d).mtimeMs > 6 * 3600e3) fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
export function publicProject(p) {
  return { id: p.id, title: p.title, createdAt: p.createdAt, status: p.status, stage: p.stage, progress: p.progress, ready: p.ready, total: p.total, notice: p.notice, error: p.error, source: p.source, settings: p.settings, clipCount: p.clips.length,
    clips: p.clips.map(c => ({ id: `${p.id}.${c.id}`, index: c.index, title: c.title, description: c.description, reason: c.reason, start: c.start, end: c.end, duration: c.duration, score: c.score, status: c.status, error: c.error, format: c.format, subs: c.subs })) };
}
