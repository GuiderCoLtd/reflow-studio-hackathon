// Thin wrapper around the OpenAI Responses API: structured JSON calls, tool
// calls, retries, and a token ledger so every run reports its model cost.
import fs from 'node:fs';
import OpenAI from 'openai';
import { sleep } from './util.mjs';

export const MODELS = {
  agent: process.env.AG_AGENT_MODEL || 'gpt-6.1-sol',
  planner: process.env.AG_PLANNER_MODEL || 'gpt-6-astra',
  writer: process.env.AG_WRITER_MODEL || 'gpt-6.1-sol',
  judge: process.env.AG_JUDGE_MODEL || 'gpt-6.1-sol',
};

let client = null;
function getClient() {
  if (!client) client = new OpenAI({ maxRetries: 0, timeout: 180_000 });
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
        tool_choice: 'required',
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
