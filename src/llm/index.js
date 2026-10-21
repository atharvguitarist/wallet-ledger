'use strict';

/*
 * One small interface for every LLM provider:
 *
 *     llm.name                        -> 'mock' | 'anthropic' | 'openai'
 *     await llm.complete({ task, system, prompt, ...context }) -> string
 *
 * The rest of the app only ever calls complete() and then VALIDATES the
 * string it gets back. The LLM never sees the database and never writes SQL.
 *
 * Provider choice (env LLM_PROVIDER):
 *   mock      - deterministic, no network, no key. Used by every test.
 *   anthropic - needs ANTHROPIC_API_KEY (LLM_MODEL optional)
 *   openai    - needs OPENAI_API_KEY; OPENAI_BASE_URL works with any
 *               OpenAI-compatible endpoint (Groq, Gemini, Ollama, ...)
 *   (unset)   - anthropic if its key is set, else openai if its key is set, else mock
 */

const config = require('../config');
const { MockLlm } = require('./mock');

async function postJson(url, headers, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

class AnthropicLlm {
  constructor({ apiKey, model, timeoutMs }) {
    this.name = 'anthropic';
    this.apiKey = apiKey;
    this.model = model || 'claude-haiku-5-5';
    this.timeoutMs = timeoutMs;
  }

  async complete({ system, prompt, maxTokens = 300 }) {
    const json = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      { model: this.model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: prompt }] },
      this.timeoutMs
    );
    return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
}

class OpenAiCompatibleLlm {
  constructor({ apiKey, baseUrl, model, timeoutMs }) {
    this.name = 'openai';
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model || 'gpt-4o-mini';
    this.timeoutMs = timeoutMs;
  }

  async complete({ system, prompt, maxTokens = 300 }) {
    const json = await postJson(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      },
      this.timeoutMs
    );
    return json.choices?.[0]?.message?.content ?? '';
  }
}

function createLlm(options = config.llm) {
  let provider = options.provider;
  if (!provider) provider = options.anthropicApiKey ? 'anthropic' : options.openaiApiKey ? 'openai' : 'mock';

  switch (provider) {
    case 'mock':
      return new MockLlm();
    case 'anthropic':
      if (!options.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
      return new AnthropicLlm({ apiKey: options.anthropicApiKey, model: options.model, timeoutMs: options.timeoutMs });
    case 'openai':
      if (!options.openaiApiKey) throw new Error('LLM_PROVIDER=openai needs OPENAI_API_KEY');
      return new OpenAiCompatibleLlm({
        apiKey: options.openaiApiKey,
        baseUrl: options.openaiBaseUrl,
        model: options.model,
        timeoutMs: options.timeoutMs,
      });
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}" (use mock, anthropic or openai)`);
  }
}

/** Pull the first {...} JSON object out of an LLM reply (models sometimes add ```json fences). */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

module.exports = { createLlm, extractJson, MockLlm, AnthropicLlm, OpenAiCompatibleLlm };
