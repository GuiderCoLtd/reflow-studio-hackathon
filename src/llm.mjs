// Thin wrapper around the OpenAI Responses API: structured JSON calls, tool
// calls, retries, and a token ledger so every run reports its model cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { sleep } from './util.mjs';

// Meta Model API speaks the same Responses protocol, so a provider is just a
// base URL, a key and a model roster. We call the Standard models, not the
// -contributor variants that hand content over for training. Hackathon credits
// are a separate case: Billing says content may be used for product improvement
// while they are in use, so only test apps run on them.
const PROVIDERS = {
  openai: {
    models: { agent: 'gpt-6.1-sol', planner: 'gpt-6-astra', writer: 'gpt-6.1-sol', judge: 'gpt-6.1-sol' },
  },
  meta: {
    baseURL: 'https://api.meta.ai/v1',
    apiKey: () => process.env.MODEL_API_KEY || fs.readFileSync(path.join(os.homedir(), '.config/meta-model-api/key'), 'utf8').trim(),
    models: { agent: 'muse-spark-1.3', planner: 'muse-spark-1.3', writer: 'muse-spark-1.3', judge: 'muse-spark-1.3' },
  },
};

let provider = process.env.AG_PROVIDER || 'openai';
export const MODELS = {};
let client = null;

export function useProvider(name) {
  if (!PROVIDERS[name]) throw new Error(`unknown provider ${name}`);
  provider = name;
  client = null;
  const m = PROVIDERS[name].models;
  MODELS.agent = process.env.AG_AGENT_MODEL || m.agent;
  MODELS.planner = process.env.AG_PLANNER_MODEL || m.planner;
  MODELS.writer = process.env.AG_WRITER_MODEL || m.writer;
  MODELS.judge = process.env.AG_JUDGE_MODEL || m.judge;
}
useProvider(provider);

export function currentProvider() {
  return provider;
}

function getClient() {
  if (!client) {
    const p = PROVIDERS[provider];
    client = new OpenAI({ maxRetries: 0, timeout: 180_000, ...(p.baseURL ? { baseURL: p.baseURL, apiKey: p.apiKey() } : {}) });
  }
  return client;
}

const ledger = { calls: 0, byModel: {} };
export function usageLedger() {
  return JSON.parse(JSON.stringify(ledger));
}
function account(model, usage, ms, label) {
  ledger.calls++;
  const m = (ledger.byModel[model] ||= { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, ms: 0, labels: {} });
  m.calls++;
  m.input += usage?.input_tokens || 0;
  m.cached += usage?.input_tokens_details?.cached_tokens || 0;
  m.output += usage?.output_tokens || 0;
  m.reasoning += usage?.output_tokens_details?.reasoning_tokens || 0;
  m.ms += ms;
  if (label) m.labels[label] = (m.labels[label] || 0) + 1;
}

async function withRetry(fn, label) {
  let delay = 1500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status;
      const retryable = !status || status === 408 || status === 409 || status === 429 || status >= 500;
      if (!retryable || attempt >= 5) throw err;
      await sleep(delay + Math.random() * 500);
      delay *= 2;
    }
  }
}

export function imagePart(dataUrlOrBuffer, detail = 'auto') {
  const url = Buffer.isBuffer(dataUrlOrBuffer) ? `data:image/jpeg;base64,${dataUrlOrBuffer.toString('base64')}` : dataUrlOrBuffer;
  return { type: 'input_image', image_url: url, detail };
}

export function imageFilePart(file, detail = 'auto') {
  const ext = file.endsWith('.png') ? 'png' : 'jpeg';
  return { type: 'input_image', image_url: `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`, detail };
}

// Structured output call. `schema` is a JSON schema (strict mode rules apply:
// every property listed in `required`, additionalProperties false).
export async function callJSON({ model = MODELS.planner, effort = 'medium', system, user, images = [], schema, name = 'result', label }) {
  const content = [{ type: 'input_text', text: user }, ...images];
  const t0 = Date.now();
  const r = await withRetry(
    () =>
      getClient().responses.create({
        model,
        reasoning: { effort },
        instructions: system,
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name, schema, strict: true } },
      }),
    label,
  );
  account(model, r.usage, Date.now() - t0, label);
  const text = r.output_text || '';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Model returned non-JSON output for ${label || name}: ${text.slice(0, 200)}`);
  }
}

// One agent decision: forces exactly one tool call and returns it parsed.
export async function callTool({ model = MODELS.agent, effort = 'medium', system, user, images = [], tools, label }) {
  const content = [{ type: 'input_text', text: user }, ...images];
  const t0 = Date.now();
  const r = await withRetry(
    () =>
      getClient().responses.create({
        model,
        reasoning: { effort },
        instructions: system,
        input: [{ role: 'user', content }],
        tools,
        // Meta Model API only accepts "auto"; the missing-tool check below covers it.
        tool_choice: provider === 'meta' ? 'auto' : 'required',
        parallel_tool_calls: false,
      }),
    label,
  );
  account(model, r.usage, Date.now() - t0, label);
  const call = r.output.find((o) => o.type === 'function_call');
  if (!call) throw new Error('Model did not call a tool');
  let args = {};
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    args = {};
  }
  return { name: call.name, args, ms: Date.now() - t0, usage: r.usage };
}

export async function callText({ model = MODELS.writer, effort = 'low', system, user, label }) {
  const t0 = Date.now();
  const r = await withRetry(
    () => getClient().responses.create({ model, reasoning: { effort }, instructions: system, input: user }),
    label,
  );
  account(model, r.usage, Date.now() - t0, label);
  return r.output_text || '';
}

// One turn of the native computer tool (Responses API only). The caller owns the
// loop: it executes the returned actions and sends back a screenshot.
export async function callComputer({ model = MODELS.agent, effort = 'medium', system, input, previousResponseId, label = 'computer' }) {
  const t0 = Date.now();
  const r = await withRetry(
    () =>
      getClient().responses.create({
        model,
        reasoning: { effort },
        instructions: system,
        tools: [{ type: 'computer' }],
        input,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      }),
    label,
  );
  account(model, r.usage, Date.now() - t0, label);
  return r;
}

// SAM 3.1 finds every instance of a short noun phrase in an image. It answers only
// as a stream of records like <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>, in image pixels.
export async function segment(image, concept, { mime = 'image/jpeg' } = {}) {
  const meta = PROVIDERS.meta;
  const t0 = Date.now();
  const res = await fetch(`${meta.baseURL}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${meta.apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sam-3.1',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: concept }, { type: 'input_image', image_url: `data:${mime};base64,${image.toString('base64')}` }] }],
    }),
  });
  if (!res.ok) throw new Error(`sam-3.1 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let out = '';
  let usage = null;
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const e = JSON.parse(line.slice(5));
      if (e.type === 'response.output_text.delta') out += e.delta;
      if (e.response?.usage) usage = e.response.usage;
    } catch {
      /* keep-alive or partial line */
    }
  }
  account('sam-3.1', usage, Date.now() - t0, 'segment');
  const matches = [...out.matchAll(/box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)/g)].map((m) => {
    const [x1, y1, x2, y2, w, h] = m.slice(1, 7).map(Number);
    return { x1, y1, x2, y2, w, h };
  });
  return { concept, matches };
}

// Muse Voice Transcribe, file endpoint. WAV must be mono s16le at 16 or 24 kHz.
export async function transcribe(wav) {
  const meta = PROVIDERS.meta;
  const t0 = Date.now();
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' })], { type: 'application/json' }));
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
  const res = await fetch(`${meta.baseURL}/asr/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${meta.apiKey()}` }, body: form });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`transcribe: ${body.error?.message || res.status}`);
  account('muse-voice-transcribe-1.0', null, Date.now() - t0, 'transcribe');
  return body.transcript || '';
}

// Function tool definition helper with strict JSON schema.
export function fnTool(name, description, properties, required = Object.keys(properties)) {
  return {
    type: 'function',
    name,
    description,
    strict: true,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}
