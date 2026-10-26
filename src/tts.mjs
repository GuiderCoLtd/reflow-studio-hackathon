// Narration synthesis behind a provider-neutral adapter (OpenAI or
// ElevenLabs), cached by content hash. Every clip is normalised to 48 kHz mono
// WAV and measured, because the video timeline is built from real durations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, ensureDir } from './util.mjs';

const CACHE = ensureDir(path.join(ROOT, 'runs', '_tts-cache'));

export const VOICES = {
  openai: {
    ko: { model: 'gpt-4o-mini-tts-2025-12-15', voice: process.env.AG_TTS_VOICE || 'marin', instructions: '차분하고 친절한 한국어 소프트웨어 교육 영상 내레이터. 또렷한 발음, 보통 속도, 문장 끝을 자연스럽게 내린다.' },
    en: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'marin', instructions: 'Calm, friendly software tutorial narrator. Clear diction, moderate pace.' },
  },
  elevenlabs: {
    ko: { model: 'eleven_v4', voice: 'uyVNoMrnUku1dZyVEXwD' }, // Anna Kim
    en: { model: 'eleven_v4', voice: 'Xb7hH8MSUJpSbSDYk0k2' }, // Alice
  },
};

function key(...parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

export function audioDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim();
  return Number(out);
}

function toWav(src, dst) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '48000', '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', dst]);
}

async function openaiSpeech(text, cfg) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, instructions: cfg.instructions, response_format: 'mp3' }),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function elevenSpeech(text, cfg, lang) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.voice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.model, language_code: lang, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.1, speed: 1.0 } }),
  });
  if (!res.ok) throw new Error(`elevenlabs tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// Returns { wav, duration } for one narration line.
export async function speak(text, { provider = 'openai', lang = 'ko' } = {}) {
  const cfg = VOICES[provider]?.[lang] || VOICES[provider]?.ko;
  const k = key(provider, cfg.model, cfg.voice, cfg.instructions || '', text);
  const wav = path.join(CACHE, `${k}.wav`);
  if (!fs.existsSync(wav)) {
    const mp3 = path.join(CACHE, `${k}.mp3`);
    const buf = provider === 'elevenlabs' ? await elevenSpeech(text, cfg, lang) : await openaiSpeech(text, cfg);
    fs.writeFileSync(mp3, buf);
    toWav(mp3, wav);
  }
  return { wav, duration: audioDuration(wav), provider, voice: cfg.voice, model: cfg.model };
}
