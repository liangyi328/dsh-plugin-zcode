/**
 * ZCode Start Plan upstream.
 *
 * The gateway (an Aliyun ESA WAF in front of zcode.z.ai) admits a request only
 * when it looks like the real desktop client. Two things matter, both measured:
 *
 *   1. auth      `authorization: Bearer <JWT>` and `x-api-key: <JWT>` together,
 *                where the JWT is the business token (`zcodejwttoken`).
 *   2. fingerprint  the top-level `system` array must carry the client's three
 *                real prompt segments verbatim, the last two with
 *                `cache_control: {type:"ephemeral"}`. Collapsing it to a string,
 *                shortening it, or changing a character yields 405 code 3012.
 *
 * Everything else — tools, tool_choice, thinking, message contents — is free.
 * A request that keeps the fingerprint but drops cache_control instead gets 429
 * code 3009, which is the busy/retry code, not a rejection.
 *
 * `zcodejwttoken` has no `exp`; when the gateway starts returning 401/403 the
 * token is exchanged for a fresh one at `/api/auth/z/login` using the OAuth
 * access token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const UPSTREAM_ORIGIN = 'https://zcode.z.ai';
export const MESSAGES_PATH = '/api/v1/zcode-plan/anthropic/v1/messages';
export const LOGIN_PATH = '/api/auth/z/login';

/** Models exposed by the Start Plan, with their measured limits. */
export const START_PLAN_MODELS = Object.freeze([
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: { levels: ['low', 'high', 'max'], default: 'max' },
  },
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: { levels: ['low', 'high', 'max'], default: 'max' },
  },
]);

/** Lower-case aliases the picker or a model override may send. */
const MODEL_ALIASES = new Map([
  ['glm-5.3', 'GLM-5.3'],
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['glm5.3', 'GLM-5.3'],
  ['glm-5.3-flash-free', 'GLM-5.3-Flash'],
]);

export function canonicalModel(name) {
  const value = String(name ?? '').trim();
  return MODEL_ALIASES.get(value.toLowerCase()) ?? value;
}

/**
 * Load the client fingerprint shipped next to this module.
 *
 * The file is a copy of the desktop client's own system prompt segments. It is
 * data, not code: the gateway hashes it to decide whether the caller is a real
 * client, so it must be sent byte for byte.
 */
export function loadFingerprint(file = path.join(HERE, 'system-template.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('system-template.json is not a non-empty array');
  return raw.map((segment) => ({ ...segment }));
}

function hex(bytes) {
  return randomBytes(bytes).toString('hex');
}

/** The client sends `01` followed by a dash-grouped hex id. */
function queryId() {
  return `01${hex(6)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

/** Static headers observed on a real client model request. */
export function staticHeaders(clientVersion = '3.15.3') {
  return {
    accept: 'application/json',
    'anthropic-beta': 'mid-conversation-system-2026-04-07',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'http-referer': UPSTREAM_ORIGIN,
    'user-agent': `ZCode/${clientVersion} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`,
    'x-client-language': 'zh-CN',
    'x-client-timezone': 'Etc/GMT-8',
    'x-os-category': 'windows',
    'x-os-version': '10.0.26200',
    'x-platform': 'win32-x64',
    'x-release-channel': 'production',
    'x-title': 'Z Code@electron',
    'x-zcode-agent': 'glm',
    'x-zcode-app-version': clientVersion,
    'x-zcode-query-source': 'main_turn',
    'x-zcode-session-type': 'main',
  };
}

/** Normalise an Anthropic `system` value into text blocks. */
function systemToBlocks(system) {
  if (system === undefined || system === null) return [];
  if (typeof system === 'string') {
    return system.length === 0 ? [] : [{ type: 'text', text: system }];
  }
  if (!Array.isArray(system)) return [];
  const blocks = [];
  for (const segment of system) {
    if (typeof segment === 'string') {
      if (segment.length > 0) blocks.push({ type: 'text', text: segment });
      continue;
    }
    if (segment !== null && typeof segment === 'object' && typeof segment.text === 'string' && segment.text.length > 0) {
      const block = { type: 'text', text: segment.text };
      if (segment.cache_control !== undefined) block.cache_control = segment.cache_control;
      blocks.push(block);
    }
  }
  return blocks;
}

/**
 * Reshape a standard Anthropic request into the shape the gateway accepts.
 *
 * The caller's own system prompt becomes a leading `role:"system"` message,
 * because the top-level `system` slot is reserved for the fingerprint. That
 * arrangement is accepted by the gateway and leaves the fingerprint untouched.
 */
export function buildUpstreamBody(incoming, { fingerprint, deviceId = '', sessionId }) {
  const messages = Array.isArray(incoming.messages) ? incoming.messages : [];
  const systemBlocks = systemToBlocks(incoming.system);
  const body = {
    model: canonicalModel(incoming.model),
    max_tokens: typeof incoming.max_tokens === 'number' ? incoming.max_tokens : 128_000,
    stream: incoming.stream === true,
    metadata: {
      user_id: JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId }),
    },
    system: fingerprint.map((segment) => ({ ...segment })),
    messages: systemBlocks.length === 0 ? messages : [{ role: 'system', content: systemBlocks }, ...messages],
  };
  // These are optional for the gateway; forwarding them keeps behaviour intact.
  if (Array.isArray(incoming.tools) && incoming.tools.length > 0) body.tools = incoming.tools;
  if (incoming.tool_choice !== undefined) body.tool_choice = incoming.tool_choice;
  if (incoming.thinking !== undefined) body.thinking = incoming.thinking;
  if (incoming.stop_sequences !== undefined) body.stop_sequences = incoming.stop_sequences;
  if (typeof incoming.temperature === 'number') body.temperature = incoming.temperature;
  if (typeof incoming.top_p === 'number') body.top_p = incoming.top_p;
  return body;
}

/** Headers for one model request, including the per-request correlation ids. */
export function requestHeaders(jwt, sessionId, clientVersion) {
  return {
    ...staticHeaders(clientVersion),
    authorization: `Bearer ${jwt}`,
    'x-api-key': jwt,
    'x-session-id': sessionId,
    'x-request-id': randomUUID(),
    'x-zcode-trace-id': randomUUID(),
    'x-query-id': queryId(),
  };
}

/**
 * Exchange the OAuth access token for a fresh business JWT.
 *
 * The JWT is what the model gateway authenticates; the access token is only
 * useful for this exchange and for the quota endpoints.
 */
export async function refreshBusinessJwt(accessToken, { fetchImpl = fetch, signal } = {}) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('no oauth access token available; sign in with the ZCode client once');
  }
  const response = await fetchImpl(`${UPSTREAM_ORIGIN}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: accessToken }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`z/login failed (HTTP ${response.status}): ${detail}`);
  }
  const doc = await response.json();
  if (typeof doc?.token !== 'string' || doc.token === '') throw new Error('z/login response carried no token');
  return doc.token;
}

/** Raised when the gateway answers with a business error. */
export class ZCodeUpstreamError extends Error {
  constructor(message, { status, code, detail } = {}) {
    super(message);
    this.name = 'ZCodeUpstreamError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Pull the business code out of either error envelope shape. */
function businessCode(payload) {
  const candidates = [payload?.error?.code, payload?.code, payload?.error?.type];
  for (const value of candidates) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/**
 * Send one model request.
 *
 * @param options.jwt - the business JWT.
 * @param options.body - a standard Anthropic request body.
 * @param options.fingerprint - the client system segments.
 * @param options.clientVersion - echoed in the app-version headers.
 * @param options.fetchImpl - injectable for tests.
 * @returns the raw `Response` (streaming or JSON, per `body.stream`).
 */
export async function sendMessages({ jwt, body, fingerprint, clientVersion = '3.15.3', deviceId = '', fetchImpl = fetch, signal }) {
  const sessionId = randomUUID();
  const upstreamBody = buildUpstreamBody(body, { fingerprint, deviceId, sessionId });
  return fetchImpl(`${UPSTREAM_ORIGIN}${MESSAGES_PATH}`, {
    method: 'POST',
    headers: requestHeaders(jwt, sessionId, clientVersion),
    body: JSON.stringify(upstreamBody),
    signal,
  });
}

/** Read a non-streaming response, raising a typed error for business failures. */
export async function readJsonResponse(response) {
  const text = await response.text();
  let payload;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    throw new ZCodeUpstreamError(`unexpected non-JSON response (HTTP ${response.status})`, {
      status: response.status,
      detail: text.slice(0, 300),
    });
  }
  if (!response.ok) {
    const code = businessCode(payload);
    const detail = payload?.error?.message ?? payload?.msg ?? text.slice(0, 300);
    throw new ZCodeUpstreamError(`gateway rejected the request (HTTP ${response.status}${code === undefined ? '' : `, code ${code}`})`, {
      status: response.status,
      code,
      detail,
    });
  }
  return payload;
}
