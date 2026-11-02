// Drift evidence from pixels alone. Spark names what the old control looks like, then
// SAM 3.1 looks for that concept on the old screen and on the new one. It works even
// when the markup says nothing useful, and gives a reviewer something to look at.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { callJSON, imagePart, segment, MODELS } from './llm.mjs';
import { COMPUTER_VIEWPORT } from './computer.mjs';
import { writeJson, log } from './util.mjs';

function imageWidth(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', file]).toString().trim());
}

function crop(file, box, scale, margin = 22) {
  const x = Math.max(0, Math.round((box.x - margin) * scale));
  const y = Math.max(0, Math.round((box.y - margin) * scale));
  const w = Math.round((box.width + margin * 2) * scale);
  const h = Math.round((box.height + margin * 2) * scale);
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '2', 'pipe:1'], { maxBuffer: 1 << 26 });
}

export async function driftEvidence({ before, after, box, outDir }) {
  const scale = imageWidth(before) / COMPUTER_VIEWPORT.width;
  const { concept } = await callJSON({
    model: MODELS.agent,
    effort: 'low',
    system: 'You describe web UI controls for an image segmentation model. The control sits in the center of the crop.',
    user: 'Name what the control in the center looks like as one short noun phrase of at most 3 words, describing its appearance rather than its purpose, for example "plus icon", "blue button" or "gear icon". Ignore anything near the edges of the crop.',
    images: [imagePart(crop(before, box, scale), 'high')],
    schema: { type: 'object', properties: { concept: { type: 'string' } }, required: ['concept'], additionalProperties: false },
    name: 'control_concept',
    label: 'evidence',
  });
  const [was, now] = await Promise.all([segment(fs.readFileSync(before), concept), segment(fs.readFileSync(after), concept)]);
  const out = { concept, before: { file: before, matches: was.matches }, after: { file: after, matches: now.matches } };
  writeJson(path.join(outDir, 'drift-evidence.json'), out);
  log('maintain', `evidence: "${concept}" ${was.matches.length} on the old screen, ${now.matches.length} on the new one`);
  return out;
}
