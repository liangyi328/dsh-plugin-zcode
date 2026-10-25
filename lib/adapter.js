/**
 * ZCode Start Plan adapter: Anthropic Messages over the ZCode gateway.
 *
 * Wire facts (measured against the live gateway):
 *   baseURL  = https://zcode.z.ai/api/v1/zcode-plan/anthropic
 *   path     = /v1/messages
 *   auth     = `authorization: Bearer <JWT>` AND `x-api-key: <JWT>`
 *   identity = the WAF fingerprints the top-level `system` array, so the real
 *              client's three prompt segments must be sent verbatim; collapsing
 *              or editing them yields 405 code 3012
 *   protocol = Anthropic Messages with SSE streaming
 *
 * This module imports nothing from the host: a plugin loaded by absolute path
 * resolves its own bare specifiers, and the runtime couples to adapters by duck
 * typing. Failures surface as a terminal `finish` chunk with a stable code.
 */
import { randomUUID } from 'node:crypto';
import {
  START_PLAN_MODELS,
  ZCodeUpstreamError,
  buildUpstreamBody,
  canonicalModel,
  loadFingerprint,
  readJsonResponse,
  refreshBusinessJwt,
  requestHeaders,
} from './upstream.js';

/** A failure with a stable, runtime-routable code. */
export class ZCodeError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ZCodeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Gateway codes that mean "busy, try again", not "you are wrong". */
const RETRYABLE_CODES = new Set([3008, 3009, 3010]);

const MESSAGES_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages';

/** Join the text blocks of one message. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * Map a gateway failure onto a stable code the runtime understands.
 *
 * `RATE_LIMIT` lets the host's retry policy take over; `AUTH` tells the user to
 * sign in again; `CHANNEL` is the fingerprint rejection, which no retry fixes.
 */
function mapFailure(error) {
  if (error instanceof ZCodeUpstreamError) {
    const code = error.code;
    if (error.status === 429 || (code !== undefined && RETRYABLE_CODES.has(code))) {
      return new ZCodeError(`ZCode 忙或额度不足（${code ?? error.status}），请稍后重试`, 'RATE_LIMIT', { status: error.status, upstreamCode: code });
    }
    if (error.status === 401 || error.status === 403) {
      return new ZCodeError(`ZCode 凭据失效，请在 ZCode 客户端重新登录（HTTP ${error.status}）`, 'AUTH', { status: error.status });
    }
    if (code === 3012) {
      return new ZCodeError('ZCode 客户端指纹被网关拒绝（3012）', 'CHANNEL', { status: error.status, upstreamCode: code });
    }
    return new ZCodeError(error.message, 'UPSTREAM', { status: error.status, upstreamCode: code });
  }
  return error;
}

/**
 * The descriptor `listModels` returns.
 *
 * Deliberately minimal: the picker only needs identity and modality. The
 * runtime reads `context`, `defaultMaxTokens` and `reasoning` from
 * `resolveModel` instead, and supplying them here as well is what produced
 * "Cannot read properties of undefined (reading 'length')" — the reasoning
 * shape differs between the two paths.
 */
function toModelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: ['text'],
  };
}

/**
 * The richer descriptor `resolveModel` returns.
 *
 * `reasoning.efforts` is the field the runtime understands (not `levels`), and
 * each entry is `{id, name}`. Omitting it is safe; supplying the wrong shape is
 * not.
 */
function toResolvedInfo(provider, model) {
  const levels = Array.isArray(model.reasoning?.levels) ? model.reasoning.levels : [];
  const reasoning = levels.length === 0
    ? undefined
    : {
        efforts: levels.map((id) => ({ id, name: id })),
        ...(typeof model.reasoning?.default === 'string' && levels.includes(model.reasoning.default)
          ? { defaultEffort: model.reasoning.default }
          : {}),
      };
  return {
    ...toModelInfo(provider, model),
    ...(typeof model.contextWindow === 'number' && model.contextWindow > 0
      ? { context: { contextWindow: model.contextWindow } }
      : {}),
    ...(typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
      ? { defaultMaxTokens: model.maxOutputTokens }
      : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

export class ZCodeAdapter {
  constructor(options) {
    this.options = options;
    this.credential = undefined;
    this.fingerprint = undefined;
    this.refreshInFlight = undefined;
  }

  /** Load credentials and fingerprint once, reusing the last good pair. */
  ensureReady() {
    if (this.fingerprint === undefined) this.fingerprint = loadFingerprint();
    if (this.credential === undefined) {
      this.credential = this.options.getCredential();
      this.options.debugLog(`credentials: ${this.credential.path} user=${this.credential.user?.email ?? '?'}`);
    }
    return this.credential;
  }

  findModel(model) {
    const wanted = canonicalModel(model);
    return START_PLAN_MODELS.find((row) => row.id === wanted);
  }

  /** Identity the host shows for this provider. */
  providerInfo(provider) {
    return { id: provider, name: this.options.displayName ?? 'ZCode (GLM Start Plan)' };
  }

  /**
   * No adapter-owned retry policy.
   *
   * The host's default policy already backs off on `RATE_LIMIT`; the adapter
   * classifies failures, it does not schedule retries itself.
   */
  providerRetryPolicy() {
    return undefined;
  }

  /** No adapter-owned image pricing: the host's neutral estimate applies. */
  imageRequestPricing() {
    return undefined;
  }

  /** Start Plan models are text-only, so an image reference cannot be inlined. */
  async resolveImage(ref) {
    if (ref === undefined || ref === null) return undefined;
    const label = ref.name ?? String(ref.attachmentId ?? 'image');
    return { type: 'text', text: `[image ${label} is not supported by this provider]` };
  }

  listModels(provider) {
    return Promise.resolve(START_PLAN_MODELS.map((model) => toModelInfo(provider, model)));
  }

  resolveModel(provider, model) {
    const found = this.findModel(model);
    if (found === undefined) {
      // Core routing accepts unlisted ids; describe it with neutral defaults.
      return Promise.resolve({
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: 1_000_000 },
        defaultMaxTokens: 128_000,
      });
    }
    return Promise.resolve(toResolvedInfo(provider, found));
  }

  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    };
  }

  /** Exchange the OAuth token for a fresh JWT, de-duplicating concurrent calls. */
  renewJwt() {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const current = this.ensureReady();
      const jwt = await refreshBusinessJwt(current.accessToken, { fetchImpl: this.options.fetchImpl });
      this.credential = { ...current, jwt };
      this.options.debugLog('jwt: refreshed via /api/auth/z/login');
      return jwt;
    })().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  /** One upstream call, renewing the JWT once if the gateway rejects it. */
  async call(jwt, body) {
    const send = (token) => fetch(MESSAGES_URL, {
      method: 'POST',
      headers: requestHeaders(token, randomUUID(), this.options.clientVersion),
      body: JSON.stringify(buildUpstreamBody(body, {
        fingerprint: this.fingerprint,
        deviceId: this.options.deviceId ?? '',
        sessionId: randomUUID(),
      })),
    });
    let response = await send(jwt);
    if (response.status === 401 || response.status === 403) {
      this.options.debugLog(`upstream ${response.status}; renewing the business JWT`);
      try {
        response = await send(await this.renewJwt());
      } catch (error) {
        this.options.debugLog(`jwt renewal failed: ${error?.message ?? error}`);
      }
    }
    return response;
  }

  /** Every failure becomes one terminal `finish` chunk with a stable code. */
  async *stream(options) {
    try {
      yield* this.run(options);
    } catch (error) {
      const mapped = mapFailure(error);
      const code = typeof mapped?.code === 'string' && mapped.code.length > 0 ? mapped.code : 'UNKNOWN';
      const aborted = code === 'ABORTED' || options?.signal?.aborted === true;
      yield {
        type: 'finish',
        reason: {
          kind: aborted ? 'aborted' : 'error',
          failure: {
            message: String(mapped?.message ?? mapped),
            code: aborted ? 'ABORTED' : code,
            ...(typeof mapped?.status === 'number' ? { status: mapped.status } : {}),
          },
        },
      };
    }
  }

  /** The actual turn: build the body, call upstream, translate the stream. */
  async *run(options) {
    const credential = this.ensureReady();
    const model = canonicalModel(options.model);
    const body = {
      model,
      max_tokens: options.maxTokens ?? this.findModel(model)?.maxOutputTokens ?? 8192,
      stream: true,
      messages: this.buildMessages(options.messages),
    };
    if (typeof options.system === 'string' && options.system.length > 0) body.system = options.system;
    const tools = toAnthropicTools(options.tools);
    if (tools !== undefined) body.tools = tools;
    if (options.toolChoice !== undefined) body.tool_choice = toAnthropicToolChoice(options.toolChoice);
    if (typeof options.temperature === 'number') body.temperature = options.temperature;
    if (typeof options.topP === 'number') body.top_p = options.topP;
    // Thinking is opt-in. The models think by default when no `thinking` field
    // is sent, but leaving it implicit gives no control over the budget, and an
    // explicit budget that is too large starves the visible answer. Sending the
    // field only when the caller asked for a level keeps a plain turn cheap and
    // leaves the whole `max_tokens` allowance for the reply.
    if (options.reasoningLevel !== undefined) {
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget(options.reasoningLevel, body.max_tokens) };
    }

    const response = await this.call(credential.jwt, body);
    if (!response.ok) {
      await readJsonResponse(response); // raises a typed upstream error
      return;
    }
    yield* this.readStream(response, options.signal);
  }

  /** Convert host messages into Anthropic messages. */
  buildMessages(messages) {
    const out = [];
    for (const message of messages ?? []) {
      if (message?.role === 'system') continue; // carried through `system`
      const content = normaliseContent(message?.content);
      if (content.length === 0) continue;
      out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
    }
    return out;
  }

  /**
   * Parse the Anthropic SSE stream into the host's block-oriented chunks.
   *
   * The host accumulator understands exactly these variants:
   *   block-start   { index, blockType }
   *   text-delta    { index, text }
   *   reasoning-delta { index, text }
   *   tool-call-delta { index, id, name?, argumentsDelta }
   *   block-end     { index, block }
   *   usage         { usage }
   *   finish        { reason }
   *
   * A bare `{type:'text'}` or `{type:'reasoning'}` is rejected with
   * "unreachable variant in AssistantStreamAccumulator.push".
   *
   * Anthropic interleaves thinking and text blocks, and their indices are not
   * stable across a turn, so each block gets a fresh host index in arrival
   * order and is closed when Anthropic closes it.
   */
  async *readStream(response, signal) {
    if (response.body === null) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** host index -> { kind, anthropicIndex, id?, name?, json, text } */
    const open = new Map();
    /** anthropic block index -> host index */
    const byAnthropic = new Map();
    let nextIndex = 0;
    let usage;
    let finishReason;
    let sawAny = false;

    const openBlock = (kind, anthropicIndex) => {
      const hostIndex = nextIndex;
      nextIndex += 1;
      byAnthropic.set(anthropicIndex, hostIndex);
      const entry = { kind, anthropicIndex, id: undefined, name: undefined, json: '', text: '' };
      open.set(hostIndex, entry);
      return { hostIndex, entry };
    };

    try {
      for (;;) {
        if (signal?.aborted === true) return;
        const { value, done } = await reader.read();
        if (done === true) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice('data:'.length).trim();
          if (data === '' || data === '[DONE]') continue;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          if (event.type === 'message_start') {
            if (event.message?.usage !== undefined) usage = { ...event.message.usage };
            continue;
          }

          if (event.type === 'content_block_start') {
            const block = event.content_block ?? {};
            if (block.type === 'tool_use') {
              const { hostIndex, entry } = openBlock('tool-call', event.index);
              entry.id = typeof block.id === 'string' && block.id.length > 0 ? block.id : `call_${hostIndex}`;
              entry.name = block.name;
              sawAny = true;
              yield { type: 'block-start', index: hostIndex, blockType: 'tool-call' };
            } else if (block.type === 'text') {
              const { hostIndex } = openBlock('text', event.index);
              sawAny = true;
              yield { type: 'block-start', index: hostIndex, blockType: 'text' };
            } else if (block.type === 'thinking') {
              const { hostIndex } = openBlock('reasoning', event.index);
              sawAny = true;
              yield { type: 'block-start', index: hostIndex, blockType: 'reasoning' };
            }
            continue;
          }

          if (event.type === 'content_block_delta') {
            const hostIndex = byAnthropic.get(event.index);
            if (hostIndex === undefined) continue;
            const entry = open.get(hostIndex);
            if (entry === undefined) continue;
            const delta = event.delta ?? {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
              entry.text += delta.text;
              sawAny = true;
              yield { type: 'text-delta', index: hostIndex, text: delta.text };
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
              entry.text += delta.thinking;
              sawAny = true;
              yield { type: 'reasoning-delta', index: hostIndex, text: delta.thinking };
            } else if (delta.type === 'input_json_delta') {
              const piece = delta.partial_json ?? '';
              entry.json += piece;
              sawAny = true;
              yield {
                type: 'tool-call-delta',
                index: hostIndex,
                id: entry.id,
                ...(entry.name === undefined ? {} : { name: entry.name }),
                argumentsDelta: piece,
              };
            }
            continue;
          }

          if (event.type === 'content_block_stop') {
            const hostIndex = byAnthropic.get(event.index);
            if (hostIndex === undefined) continue;
            const entry = open.get(hostIndex);
            byAnthropic.delete(event.index);
            open.delete(hostIndex);
            if (entry === undefined) continue;
            if (entry.kind === 'tool-call') {
              yield {
                type: 'block-end',
                index: hostIndex,
                block: { type: 'tool-call', id: entry.id, name: entry.name ?? 'unknown_tool', arguments: entry.json },
              };
            } else if (entry.kind === 'reasoning') {
              yield { type: 'block-end', index: hostIndex, block: { type: 'reasoning', text: entry.text } };
            } else {
              yield { type: 'block-end', index: hostIndex, block: { type: 'text', text: entry.text } };
            }
            continue;
          }

          if (event.type === 'message_delta') {
            if (event.usage !== undefined) usage = { ...usage, ...event.usage };
            if (typeof event.delta?.stop_reason === 'string') finishReason = event.delta.stop_reason;
            continue;
          }

          if (event.type === 'error') {
            throw new ZCodeUpstreamError(event.error?.message ?? 'stream error', { code: event.error?.code });
          }
        }
      }

      // Any block Anthropic left open (a truncated stream) still has to close,
      // or the accumulator never finalises it.
      for (const [hostIndex, entry] of [...open].sort((a, b) => a[0] - b[0])) {
        if (entry.kind === 'tool-call') {
          yield { type: 'block-end', index: hostIndex, block: { type: 'tool-call', id: entry.id, name: entry.name ?? 'unknown_tool', arguments: entry.json } };
        } else if (entry.kind === 'reasoning') {
          yield { type: 'block-end', index: hostIndex, block: { type: 'reasoning', text: entry.text } };
        } else {
          yield { type: 'block-end', index: hostIndex, block: { type: 'text', text: entry.text } };
        }
      }
      open.clear();

      if (usage !== undefined) {
        yield {
          type: 'usage',
          usage: {
            ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
            ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
            ...(typeof usage.cache_read_input_tokens === 'number' ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
            ...(typeof usage.cache_creation_input_tokens === 'number' ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
          },
        };
      }

      if (!sawAny && signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } };
        return;
      }
      yield {
        type: 'finish',
        reason: finishReason === 'tool_use' ? { kind: 'tool-calls' }
          : finishReason === 'max_tokens' ? { kind: 'max-tokens' }
            : { kind: 'stop' },
      };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }
}

/**
 * How many tokens the model may spend thinking.
 *
 * Thinking is charged against `max_tokens`, so an over-generous budget starves
 * the visible answer: with `max_tokens: 4096` and a 3072-token budget the model
 * produced a complete reasoning block and then stopped with no text at all.
 * The budget is therefore capped well below the total, and the remainder is
 * always left for the reply.
 */
function thinkingBudget(level, maxTokens) {
  const ratio = level === 'low' ? 0.2 : level === 'high' ? 0.35 : 0.5;
  // Keep at least half the budget for the answer, and never exceed a sane cap.
  const ceiling = Math.max(1024, Math.min(Math.floor(maxTokens * ratio), maxTokens - 1024));
  return Math.max(1024, ceiling);
}

/**
 * Convert host tool definitions into Anthropic's shape.
 *
 * The host passes OpenAI-style `{name, description, parameters}`, while the
 * Anthropic Messages API expects `{name, description, input_schema}`. Passing
 * the host shape through unchanged leaves the model with no parameter schema,
 * so it emits tool calls whose arguments are empty or missing entirely — which
 * the host then rejects as "missing required property".
 */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue;
    const name = tool.name ?? tool.function?.name;
    if (typeof name !== 'string' || name === '') continue;
    const description = tool.description ?? tool.function?.description ?? '';
    const schema = tool.input_schema ?? tool.parameters ?? tool.function?.parameters ?? { type: 'object', properties: {} };
    out.push({ name, description, input_schema: schema });
  }
  return out.length === 0 ? undefined : out;
}

/**
 * Convert the host's tool-choice value into Anthropic's.
 *
 * Anthropic accepts `{type:"auto"}`, `{type:"any"}`, `{type:"tool",name}`, or
 * `{type:"none"}`; the host uses the OpenAI spellings ("auto", "required",
 * "none", or `{name}`).
 */
function toAnthropicToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'required' || choice === 'any') return { type: 'any' };
    if (choice === 'none') return { type: 'none' };
    return { type: 'auto' };
  }
  if (typeof choice === 'object') {
    const name = choice.name ?? choice.tool?.name ?? choice.function?.name;
    if (typeof name === 'string' && name !== '') return { type: 'tool', name };
    if (choice.type === 'required' || choice.type === 'any') return { type: 'any' };
    if (choice.type === 'none') return { type: 'none' };
    if (choice.type === 'auto') return { type: 'auto' };
  }
  return { type: 'auto' };
}

/** Coerce host content into Anthropic content blocks. */
function normaliseContent(content) {
  if (typeof content === 'string') return content.length === 0 ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'tool_use') {
      blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} });
      continue;
    }
    if (part.type === 'tool_result') {
      blocks.push({ type: 'tool_result', tool_use_id: part.tool_use_id ?? part.toolUseId, content: part.content ?? '' });
      continue;
    }
    if (part.type === 'image' && part.source !== undefined) blocks.push({ type: 'image', source: part.source });
  }
  return blocks;
}

export { textOf };
