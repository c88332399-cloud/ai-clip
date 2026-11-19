import path from 'node:path';
const e = process.env;
export const C = {
  port: +e.PORT || 3000,
  dataDir: path.resolve(e.DATA_DIR || './data'),
  openaiKey: e.OPENAI_API_KEY || '', openaiBase: e.OPENAI_BASE_URL || 'https://api.openai.com/v1', asrModel: e.ASR_MODEL || 'whisper-1',
  anthropicKey: e.ANTHROPIC_API_KEY || '', anthropicBase: e.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', llmModel: e.LLM_MODEL || 'claude-sonnet-5-5',
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
export const missingKeys = () => [!C.openaiKey && 'OPENAI_API_KEY', !C.anthropicKey && 'ANTHROPIC_API_KEY'].filter(Boolean);
