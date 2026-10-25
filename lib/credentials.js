/**
 * ZCode credential store.
 *
 * ZCode keeps its OAuth material in `enc:v1:` envelopes encrypted with a key
 * derived only from public machine facts, so it can be read offline without
 * touching the running client:
 *
 *   key = sha256( ZCODE_CREDENTIAL_SECRET
 *                 ?? `zcode-credential-fallback:${platform}:${homedir}:${username}` )
 *   value = "enc:v1:" + base64url(iv[12]) + "." + base64url(tag[16]) + "." + base64url(data)
 *   cipher = aes-256-gcm
 *
 * The desktop client and the CLI use different base directories, so both are
 * searched. `zcodejwttoken` is the business JWT the model gateway accepts; it
 * carries no `exp`, and is renewed through `/api/auth/z/login` with the OAuth
 * access token.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

/** Base directories that may hold a `.zcode/v2/credentials.json`. */
export function credentialCandidates(override) {
  const out = [];
  if (typeof override === 'string' && override.trim() !== '') out.push(path.resolve(override.trim()));
  const home = os.homedir();
  // The desktop client lets the user relocate its data directory; the usual
  // place is `%APPDATA%`-adjacent, and a relocated one is discovered below.
  out.push(path.join(home, '.zcode', 'v2', 'credentials.json'));
  for (const dir of relocatedBases()) {
    out.push(path.join(dir, '.zcode', 'v2', 'credentials.json'));
  }
  return out;
}

/**
 * Look for relocated ZCode data directories.
 *
 * The client lets the user move its data directory, and a relocated install
 * puts `.zcode/v2` under an arbitrary path (for example
 * `D:\someProject\zcodeData\.zcode\v2`). The recorded crash-database path on the
 * client's command line is the authoritative hint; when the client is not
 * running, drive roots are scanned a couple of levels deep for a `.zcode/v2`
 * marker. Results are cached because the scan touches the filesystem.
 */
let relocatedCache;

function relocatedBases() {
  if (relocatedCache !== undefined) return relocatedCache;
  const found = [];
  const seen = new Set();
  const add = (dir) => {
    if (typeof dir !== 'string' || dir.trim() === '') return;
    const normalised = path.resolve(dir.trim());
    if (seen.has(normalised)) return;
    seen.add(normalised);
    found.push(normalised);
  };
  // `ZCODE_DATA_BASE_DIR` is what the CLI honours.
  add(process.env.ZCODE_DATA_BASE_DIR);
  // The desktop client records its data directory on the process command line.
  for (const dir of scanProcessCommandLines()) add(dir);
  // Fall back to a bounded scan of drive roots.
  for (const dir of scanDriveRoots()) add(dir);
  relocatedCache = found;
  return found;
}

/** Pull `--database=<dir>\.zcode\v2\crash\live` style hints from running clients. */
function scanProcessCommandLines() {
  const out = [];
  if (process.platform !== 'win32') return out;
  try {
    const { execFileSync } = require('node:child_process');
    const raw = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='ZCode.exe'\" | Select-Object -ExpandProperty CommandLine"],
    { encoding: 'utf8', timeout: 4000, windowsHide: true });
    for (const line of raw.split(/\r?\n/)) {
      const match = /--database=([^"\s]+)/.exec(line);
      if (match === null) continue;
      // `<base>\.zcode\v2\crash\live` -> `<base>`
      const marker = `${path.sep}.zcode${path.sep}v2`;
      const index = match[1].indexOf(marker);
      if (index > 0) out.push(match[1].slice(0, index));
    }
  } catch {
    /* the client may not be running, or powershell may be unavailable */
  }
  return out;
}

/** Bounded scan: `<drive>:\<dir>[\<dir>]\zcodeData\.zcode\v2`. */
function scanDriveRoots() {
  const out = [];
  const names = ['zcodeData', 'ZCodeData', 'zcode-data'];
  const drives = [];
  for (let code = 67; code <= 90; code += 1) drives.push(`${String.fromCharCode(code)}:`);
  for (const drive of drives) {
    let level1;
    try {
      level1 = fs.readdirSync(`${drive}${path.sep}`, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of level1) {
      if (!entry.isDirectory()) continue;
      const base = path.join(`${drive}${path.sep}`, entry.name);
      for (const name of names) {
        if (fs.existsSync(path.join(base, name, '.zcode', 'v2', 'credentials.json'))) {
          out.push(path.join(base, name));
        }
      }
      // One level deeper covers `<drive>:\projects\<name>\zcodeData`.
      if (out.length > 8) return out;
      let level2;
      try {
        level2 = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of level2) {
        if (!sub.isDirectory()) continue;
        for (const name of names) {
          if (fs.existsSync(path.join(base, sub.name, name, '.zcode', 'v2', 'credentials.json'))) {
            out.push(path.join(base, sub.name, name));
          }
        }
        if (out.length > 8) return out;
      }
    }
  }
  return out;
}

/** The derivation key, matching the client byte for byte. */
export function credentialKey() {
  const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (secret !== undefined && secret !== '') return crypto.createHash('sha256').update(secret).digest();
  const fallback = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
  return crypto.createHash('sha256').update(fallback).digest();
}

/** Decrypt one `enc:v1:` value; plain values pass through untouched. */
export function decryptValue(value, key = credentialKey()) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
  const parts = value.slice('enc:v1:'.length).split('.');
  if (parts.length !== 3) throw new Error('credential decrypt failed: invalid ciphertext format');
  const [ivB, tagB, dataB] = parts;
  if (ivB === '' || tagB === '' || dataB === '') throw new Error('credential decrypt failed: invalid ciphertext format');
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const data = Buffer.from(dataB, 'base64url');
  if (iv.length !== 12) throw new Error('credential decrypt failed: invalid IV length');
  if (tag.length !== 16) throw new Error('credential decrypt failed: invalid auth tag length');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error('credential decrypt failed: key mismatch or corrupted ciphertext', { cause: error });
  }
}

/**
 * Read the freshest usable credential file.
 *
 * Several data directories can coexist (a relocated desktop install, an older
 * CLI home). Picking the first readable one is wrong: a stale file still parses
 * and decrypts, but its JWT is dead and every request 401s. The most recently
 * written file is the one the user last signed in with.
 *
 * @param override - an explicit credentials.json path, or a base directory.
 * @returns {{path:string, jwt:string, accessToken:string|undefined, user:object|undefined, modifiedAt:number}}
 */
export function readCredentials(override) {
  const key = credentialKey();
  const tried = [];
  const found = [];
  for (const candidate of credentialCandidates(override)) {
    // An explicit override may point at the directory rather than the file.
    const file = candidate.endsWith('.json') ? candidate : path.join(candidate, 'credentials.json');
    if (!fs.existsSync(file)) {
      tried.push(file);
      continue;
    }
    let doc;
    let modifiedAt;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      modifiedAt = fs.statSync(file).mtimeMs;
    } catch {
      tried.push(file);
      continue;
    }
    const rawJwt = doc.zcodejwttoken;
    if (typeof rawJwt !== 'string' || rawJwt === '') {
      tried.push(file);
      continue;
    }
    let jwt;
    let accessToken;
    let user;
    try {
      jwt = decryptValue(rawJwt, key);
    } catch (error) {
      // An undecryptable file is a stale or foreign install; skip it rather
      // than failing the whole lookup.
      tried.push(`${file} (${error.message})`);
      continue;
    }
    if (typeof doc['oauth:zai:access_token'] === 'string') {
      try {
        accessToken = decryptValue(doc['oauth:zai:access_token'], key);
      } catch {
        /* the JWT alone is enough to talk to the gateway */
      }
    }
    if (typeof doc['oauth:zai:user_info'] === 'string') {
      try {
        user = JSON.parse(decryptValue(doc['oauth:zai:user_info'], key));
      } catch {
        /* user info is cosmetic */
      }
    }
    found.push({ path: file, jwt, accessToken, user, modifiedAt });
  }
  if (found.length === 0) {
    throw new Error(`no ZCode credentials found (looked at: ${tried.join(', ') || 'nothing'})`);
  }
  // Newest first: that is the session the user most recently authorised.
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return found[0];
}

/** Every credential file that decrypted, newest first. Useful for diagnostics. */
export function listCredentials(override) {
  const out = [];
  for (const candidate of credentialCandidates(override)) {
    const file = candidate.endsWith('.json') ? candidate : path.join(candidate, 'credentials.json');
    if (!fs.existsSync(file)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof doc.zcodejwttoken !== 'string') continue;
      out.push({ path: file, modifiedAt: fs.statSync(file).mtimeMs });
    } catch {
      /* unreadable */
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
