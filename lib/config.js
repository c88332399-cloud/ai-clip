import path from 'node:path';
const e = process.env;
export const C = {
  port: +e.PORT || 3000,
  dataDir: path.resolve(e.DATA_DIR || './data'),
  geminiKey: e.GEMINI_API_KEY || '', geminiBase: e.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
  asrModel: e.GEMINI_ASR_MODEL || e.GEMINI_MODEL || 'gemini-2.5-flash', llmModel: e.GEMINI_MODEL || 'gemini-2.5-flash',
  allowPrivateUrls: e.ALLOW_PRIVATE_URLS === 'true', maxProjectsPerHour: +e.MAX_PROJECTS_PER_HOUR || 20,
  maxUploadBytes: (+e.MAX_UPLOAD_MB || 2048) * 1048576,
  maxSourceSec: (+e.MAX_SOURCE_MINUTES || 180) * 60,
  maxConcurrent: +e.MAX_CONCURRENT_JOBS || 1,
  minFreeBytes: (+e.MIN_FREE_GB || 2) * 1073741824,
  retentionMs: (+e.RETENTION_DAYS || 7) * 86400000,
  maxQuality: +e.MAX_OUTPUT_QUALITY || 1080,
  maxSourceHeight: +e.MAX_SOURCE_HEIGHT || 1080,
  ytdlp: e.YT_DLP_ENABLED !== 'false', ytdlpBin: e.YT_DLP_BIN || 'yt-dlp',
  ffmpeg: e.FFMPEG_BIN || 'ffmpeg', ffprobe: e.FFPROBE_BIN || 'ffprobe',
};
export const missingKeys = () => [!C.geminiKey && 'GEMINI_API_KEY'].filter(Boolean);
