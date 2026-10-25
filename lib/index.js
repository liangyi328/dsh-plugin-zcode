/**
 * ZCode Start Plan provider for DeepSeek Harness.
 *
 * Registers a `zcode` provider that talks the Anthropic Messages protocol
 * straight to `zcode.z.ai`, using the credential the ZCode desktop client
 * already holds on disk. Nothing has to be running and no API key is pasted:
 * the client's own OAuth material is decrypted locally with a key derived from
 * public machine facts.
 *
 * No configuration is required. Optional overrides exist for unusual layouts:
 *   credentialsPath  explicit credentials.json (or its directory)
 *   fingerprintPath  explicit system-template.json
 *   debugLogPath     append diagnostics here
 */
import fs from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { ZCodeAdapter } from './adapter.js';
import { readCredentials } from './credentials.js';

const name = 'llm-zcode';
// `llm` is the provider registry; nothing else is touched.
const inject = ['llm'];

const PROVIDER = 'zcode';
const DISPLAY_NAME = 'ZCode (GLM Start Plan)';

const Config = z.object({
  provider: z.string().default(PROVIDER),
  displayName: z.string().default(DISPLAY_NAME),
  // Empty means "discover it": the client relocates its data directory, so a
  // hard-coded path is wrong on most machines.
  credentialsPath: z.string().default(''),
  fingerprintPath: z.string().default(''),
  // The version echoed in `X-Client-Version` and the app-version headers.
  clientVersion: z.string().default('3.15.3').volatile(),
  deviceId: z.string().default('').volatile(),
  debugLogPath: z.string().default(''),
});

/**
 * @param ctx - the plugin context.
 * @param config - a schemastery Config instance.
 */
export function apply(ctx, config) {
  // Read every field once per operation so a settings edit applies immediately.
  // `volatile()` fields are accessor objects, not plain values: they must be
  // read through `.get()`, and calling `.get()` on a plain field throws.
  const options = () => ({
    provider: read(config.provider, PROVIDER),
    displayName: read(config.displayName, DISPLAY_NAME),
    credentialsPath: read(config.credentialsPath, ''),
    fingerprintPath: read(config.fingerprintPath, ''),
    clientVersion: read(config.clientVersion, '3.15.3'),
    deviceId: read(config.deviceId, ''),
    debugLogPath: read(config.debugLogPath, ''),
  });
  const debugLog = createDebugLog(() => options().debugLogPath);

  /** Credential lookup is repeated on each failure so a re-login is picked up. */
  const getCredential = () => {
    try {
      return readCredentials(options().credentialsPath || undefined);
    } catch (error) {
      throw new ZCodeStartupError(`无法读取 ZCode 凭据：${error?.message ?? error}`);
    }
  };

  const adapter = new ZCodeAdapter({
    getCredential,
    debugLog,
    displayName: options().displayName,
    clientVersion: options().clientVersion,
    deviceId: options().deviceId,
  });

  const settingsNs = ctx.fiber?.entry?.options?.id ?? name;
  ctx.llm.registerConfigurableProviders([{
    provider: options().provider,
    displayName: options().displayName,
    settingsNs,
    settingsPath: [],
  }]);
  ctx.llm.registerAdapter([options().provider], adapter);
  debugLog(`apply: provider=${options().provider} ns=${settingsNs}`);

  // Startup self-check: proves the module loaded and whether a credential is
  // readable. A failure is logged, not thrown — the host must still start, and
  // the user can fix the credential without restarting.
  void Promise.resolve()
    .then(() => {
      const credential = getCredential();
      debugLog(`ready: user=${credential.user?.email ?? '?'} jwt=${credential.jwt.length} chars path=${credential.path}`);
      return adapter.listModels(options().provider);
    })
    .then((models) => debugLog(`models: ${models.map((m) => m.id).join(', ')}`))
    .catch((error) => debugLog(`startup check failed: ${error?.message ?? error}`));
}

/** Raised when the credential cannot be read at all. */
class ZCodeStartupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZCodeStartupError';
    this.code = 'AUTH';
  }
}

/**
 * Read one config field.
 *
 * schemastery marks `volatile()` fields as accessors; those expose `get()`,
 * while plain fields are already values. Both shapes appear here depending on
 * the field, so the read has to handle either.
 */
function read(field, fallback) {
  if (field === undefined || field === null) return fallback;
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get();
    return value === undefined || value === null || value === '' ? fallback : value;
  }
  return field === '' ? fallback : field;
}

/** A tiny append-only logger that never throws. */
function createDebugLog(pathOf) {
  return (message) => {
    const target = pathOf();
    if (typeof target !== 'string' || target === '') return;
    try {
      fs.appendFileSync(target, `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch {
      /* logging must never break a request */
    }
  };
}

export { Config, inject, name };
