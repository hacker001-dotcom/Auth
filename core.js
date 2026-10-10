// Auth core: one-time codes, setup keys and the encrypted vault.
// No DOM access here, so the same file runs in the browser and in tests (Node 20+).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const VAULT_FORMAT = 'auth-vault';
export const VAULT_VERSION = 1;
export const KDF_ITERATIONS = 600000; // PBKDF2-HMAC-SHA256, OWASP 2023 guidance
export const MIN_ITERATIONS = 100000;
export const MAX_ITERATIONS = 5000000;
export const AUTO_LOCK_CHOICES = [30, 60, 120, 300];
export const DEFAULT_AUTO_LOCK = 60;
export const MIN_PASSWORD_LENGTH = 8;
const AAD = enc.encode('auth-vault/v1');
const ALGORITHMS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Errors whose message is written for the person using the app.
export class InputError extends Error {}

// Errors about stored or imported vault data. `code` is one of:
// 'wrong-password', 'format', 'unsupported'.
export class VaultError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---------------------------------------------------------------- bytes

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new VaultError('format');
  }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// --------------------------------------------------------------- base32

// Turns whatever someone pasted ("abcd efgh ijkl", "ABCD-EFGH==") into
// canonical base32: uppercase, no spaces, no padding.
export function normalizeSecret(input) {
  const s = String(input ?? '')
    .replace(/[\s\-_]/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (!s) throw new InputError('Enter the setup key.');
  if (/[^A-Z2-7]/.test(s)) {
    throw new InputError(
      'That setup key has characters that don’t belong in one. It only uses the letters A–Z and the numbers 2–7.'
    );
  }
  if ([1, 3, 6].includes(s.length % 8)) {
    throw new InputError('That setup key looks cut off. Check that you copied all of it.');
  }
  if (s.length < 16) {
    throw new InputError('That setup key is too short. Check that you copied all of it.');
  }
  if (s.length > 256) throw new InputError('That setup key is too long to be real.');
  return s;
}

export function base32Decode(input) {
  const s = String(input).replace(/=+$/, '').toUpperCase();
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new InputError('Invalid base32 character.');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Splits a key into groups of four so it is easier to read and type.
export function groupSecret(secret) {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

// ------------------------------------------------------------ TOTP/HOTP

export function importTotpKey(secretBytes, algorithm = 'SHA1') {
  const hash = ALGORITHMS[algorithm];
  if (!hash) throw new InputError('Unsupported algorithm.');
  return subtle.importKey('raw', secretBytes, { name: 'HMAC', hash }, false, ['sign']);
}

export async function hotp(key, counter, digits = 6) {
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCounter(nowMs, period = 30) {
  return Math.floor(nowMs / 1000 / period);
}

export function totp(key, { nowMs = Date.now(), period = 30, digits = 6 } = {}) {
  return hotp(key, totpCounter(nowMs, period), digits);
}

// Seconds left in the current window, as a float in (0, period].
export function secondsLeft(nowMs, period = 30) {
  const elapsed = (nowMs / 1000) % period;
  return period - elapsed;
}

// "482917" -> ["482", "917"]; 7 digits -> 3+4; 8 digits -> 4+4.
export function splitCode(code) {
  const cut = code.length === 8 ? 4 : 3;
  return [code.slice(0, cut), code.slice(cut)];
}

// ------------------------------------------------------------- accounts

export function cleanText(value, max = 64) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function checkAlgorithm(value) {
  const alg = String(value ?? 'SHA1').toUpperCase().replace(/-/g, '');
  if (!ALGORITHMS[alg]) {
    throw new InputError('Auth supports the SHA1, SHA256 and SHA512 algorithms.');
  }
  return alg;
}

function checkDigits(value) {
  const d = Number(value ?? 6);
  if (![6, 7, 8].includes(d)) throw new InputError('Codes can be 6, 7 or 8 digits long.');
  return d;
}

function checkPeriod(value) {
  const p = Number(value ?? 30);
  if (!Number.isInteger(p) || p < 10 || p > 300) {
    throw new InputError('The code period must be between 10 and 300 seconds.');
  }
  return p;
}

// Checks and tidies account fields. Used for new accounts and for every
// account read back out of a vault, so bad data can never reach the screen.
export function checkAccount(fields) {
  const secret = normalizeSecret(fields.secret);
  const issuer = cleanText(fields.issuer);
  const label = cleanText(fields.label);
  if (!issuer && !label) {
    throw new InputError('Give this account a name, like “Instagram”.');
  }
  return {
    issuer,
    label,
    secret,
    algorithm: checkAlgorithm(fields.algorithm),
    digits: checkDigits(fields.digits),
    period: checkPeriod(fields.period),
  };
}

export function newAccount(fields) {
  return {
    id: globalThis.crypto.randomUUID(),
    ...checkAccount(fields),
    createdAt: new Date().toISOString(),
  };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Reads the text inside an authenticator QR code:
// otpauth://totp/Instagram:username?secret=...&issuer=Instagram
export function parseOtpauth(text) {
  const raw = String(text ?? '').trim();
  if (/^otpauth-migration:/i.test(raw)) {
    throw new InputError(
      'This is a Google Authenticator export code. Auth can’t read those. Use the setup key from the service instead.'
    );
  }
  const m = /^otpauth:\/\/([a-z]+)\/([^?#]*)(?:\?([^#]*))?/i.exec(raw);
  if (!m) throw new InputError('That QR code isn’t a two-factor setup code.');
  const type = m[1].toLowerCase();
  if (type === 'hotp') {
    throw new InputError(
      'This is a counter-based (HOTP) code. Auth only does time-based codes, which is what Instagram uses.'
    );
  }
  if (type !== 'totp') throw new InputError('That QR code isn’t a two-factor setup code.');

  const params = new URLSearchParams(m[3] || '');
  // The label is "Issuer:account". Split on the separator before decoding,
  // so an encoded colon inside a name can't be mistaken for it. The spec
  // allows the separator itself to be written as %3A.
  const rawLabel = m[2];
  let cut = rawLabel.indexOf(':');
  let sepLength = 1;
  if (cut < 0) {
    cut = rawLabel.search(/%3A/i);
    sepLength = 3;
  }
  let issuerFromLabel = '';
  let label = safeDecode(rawLabel);
  if (cut >= 0) {
    issuerFromLabel = safeDecode(rawLabel.slice(0, cut));
    label = safeDecode(rawLabel.slice(cut + sepLength));
  }
  const issuer = params.get('issuer') || issuerFromLabel;
  if (!params.get('secret')) throw new InputError('That QR code has no setup key in it.');
  return checkAccount({
    issuer,
    label,
    secret: params.get('secret'),
    algorithm: params.get('algorithm') || 'SHA1',
    digits: params.get('digits') || 6,
    period: params.get('period') || 30,
  });
}

// Builds the QR text another authenticator app can scan.
export function buildOtpauth(account) {
  const issuer = account.issuer;
  const label = issuer
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account.label || issuer)}`
    : encodeURIComponent(account.label);
  const q = new URLSearchParams({ secret: account.secret });
  if (issuer) q.set('issuer', issuer);
  if (account.algorithm !== 'SHA1') q.set('algorithm', account.algorithm);
  if (account.digits !== 6) q.set('digits', String(account.digits));
  if (account.period !== 30) q.set('period', String(account.period));
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, '%20')}`;
}

// --------------------------------------------------------------- vault

export function emptyVaultData() {
  return { v: 1, accounts: [], settings: { autoLockSeconds: DEFAULT_AUTO_LOCK } };
}

export function checkNewPassword(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new InputError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 1024) throw new InputError('That password is too long.');
  if (confirm !== undefined && password !== confirm) {
    throw new InputError('The two passwords don’t match.');
  }
}

// A rough guide, not a guarantee. It deliberately undersells: people pick
// real words, names and years, which attackers try first, so those patterns
// are scored as what they are rather than by their raw length.
export function passwordStrength(password) {
  const pw = String(password || '');
  if (!pw) return { score: 0, label: '' };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  let bits = pw.length * Math.log2(Math.max(pool, 2));
  bits *= Math.min(1, unique / Math.max(4, pw.length * 0.6));

  const extras = (/[A-Z]/.test(pw) ? 2 : 0) + (/\d/.test(pw) ? 7 : 0) + (/[^a-zA-Z0-9\s\-_.]/.test(pw) ? 4 : 0);
  const words = pw.split(/[\s\-_.]+/).filter(Boolean);
  const letterWords = words.filter((w) => /^[a-z]+$/i.test(w));
  if (/^[a-z]+$/i.test(pw)) {
    // One run of letters: probably a word or a name.
    bits = Math.min(bits, pw.length * 2.5 + extras);
  } else if (words.length >= 2 && letterWords.length >= words.length - 1) {
    // Several words, maybe with a number: about 12 bits per word.
    bits = Math.min(bits, letterWords.length * 12 + extras);
  } else if (/^[a-z]+[\s\-_.@#!$%&*]?\d{1,4}[^a-z0-9]?$/i.test(pw) || /^\d{1,4}[^a-z0-9]?[a-z]+[^a-z0-9]?$/i.test(pw)) {
    // A word or name with a year or short number, like "Dhaka@2026".
    bits = Math.min(bits, pw.replace(/[^a-z]/gi, '').length * 2.5 + extras);
  }
  if (/^(?:password|qwerty|123456|abc123|letmein|iloveyou|admin|welcome)/i.test(pw)) bits = Math.min(bits, 10);
  if (/(.)\1{2,}/.test(pw)) bits *= 0.8;
  if (/^\d+$/.test(pw)) bits = Math.min(bits, 30);
  let score;
  if (bits < 36) score = 1;
  else if (bits < 56) score = 2;
  else if (bits < 76) score = 3;
  else score = 4;
  const label = ['', 'Weak', 'Okay', 'Good', 'Strong'][score];
  return { score, label, bits: Math.round(bits) };
}

async function deriveKey(password, salt, iterations) {
  const base = await subtle.importKey(
    'raw',
    enc.encode(String(password).normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Checks the shape of a stored or imported vault before any expensive work,
// so a damaged or hostile file can't hang the app.
export function checkRecord(record) {
  if (!record || typeof record !== 'object') throw new VaultError('format');
  if (record.format !== VAULT_FORMAT) throw new VaultError('format');
  if (record.version !== VAULT_VERSION) throw new VaultError('unsupported');
  const kdf = record.kdf;
  if (
    !kdf ||
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < MIN_ITERATIONS ||
    kdf.iterations > MAX_ITERATIONS
  ) {
    throw new VaultError('format');
  }
  const salt = base64ToBytes(kdf.salt);
  if (salt.length < 16 || salt.length > 64) throw new VaultError('format');
  if (!record.cipher || record.cipher.name !== 'AES-GCM') throw new VaultError('format');
  const iv = base64ToBytes(record.cipher.iv);
  if (iv.length !== 12) throw new VaultError('format');
  const ciphertext = base64ToBytes(record.ciphertext);
  if (ciphertext.length < 17 || ciphertext.length > 4000000) throw new VaultError('format');
  return { salt, iv, ciphertext, iterations: kdf.iterations };
}

export function readVaultData(json) {
  let d;
  try {
    d = JSON.parse(json);
  } catch {
    throw new VaultError('format');
  }
  if (!d || d.v !== 1 || !Array.isArray(d.accounts)) throw new VaultError('format');
  const accounts = d.accounts.map((a) => {
    if (!a || typeof a !== 'object') throw new VaultError('format');
    let fields;
    try {
      fields = checkAccount(a);
    } catch {
      throw new VaultError('format');
    }
    return {
      id: typeof a.id === 'string' && a.id ? a.id.slice(0, 64) : globalThis.crypto.randomUUID(),
      ...fields,
      createdAt: typeof a.createdAt === 'string' ? a.createdAt.slice(0, 40) : new Date().toISOString(),
    };
  });
  const lock = d.settings && d.settings.autoLockSeconds;
  return {
    v: 1,
    accounts,
    settings: { autoLockSeconds: AUTO_LOCK_CHOICES.includes(lock) ? lock : DEFAULT_AUTO_LOCK },
  };
}

// Encrypts `data` with an already-derived key. A fresh IV every time.
export async function sealVault(session, data) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify(data));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, session.key, plaintext)
  );
  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    kdf: { ...session.kdf },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    ciphertext: bytesToBase64(ct),
    updatedAt: new Date().toISOString(),
  };
}

// New password, new salt. Returns the session (key + kdf) and the record to store.
export async function createVault(password, data = emptyVaultData(), iterations = KDF_ITERATIONS) {
  checkNewPassword(password);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, iterations);
  const session = {
    key,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToBase64(salt) },
  };
  const record = await sealVault(session, data);
  return { session, record };
}

// Throws VaultError('wrong-password') when the password doesn't open it.
export async function openVault(record, password) {
  const { salt, iv, ciphertext, iterations } = checkRecord(record);
  const key = await deriveKey(password, salt, iterations);
  let plain;
  try {
    plain = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, ciphertext);
  } catch {
    throw new VaultError('wrong-password');
  }
  const data = readVaultData(dec.decode(plain));
  return { session: { key, kdf: { ...record.kdf } }, data };
}

// Decrypts a record with a session that's already open. Used to double-check
// every save before it replaces the stored copy.
export async function readWithSession(record, session) {
  const { iv, ciphertext } = checkRecord(record);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, session.key, ciphertext);
  return readVaultData(dec.decode(plain));
}

// Adds accounts from `incoming` that aren't already in `current`
// (same key + same name counts as the same account).
export function mergeAccounts(current, incoming) {
  const seen = new Set(current.map((a) => `${a.secret}|${a.issuer}|${a.label}`));
  const added = [];
  for (const a of incoming) {
    const k = `${a.secret}|${a.issuer}|${a.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    added.push({ ...a, id: globalThis.crypto.randomUUID() });
  }
  return { accounts: [...current, ...added], added: added.length };
}

// ----------------------------------------------------------- the clock

// Compares this device's clock with a server's Date header (1 s precision).
// Returns the offset in whole seconds (positive = this device is ahead),
// or null when the reading is too uncertain to say anything.
export function clockOffset(dateHeader, sentMs, receivedMs) {
  const server = Date.parse(dateHeader || '');
  if (!Number.isFinite(server)) return null;
  const roundTrip = receivedMs - sentMs;
  if (roundTrip < 0 || roundTrip > 5000) return null;
  const local = sentMs + roundTrip / 2;
  // The header is truncated to the second, so the true server time is in
  // [server, server + 1000). Only report what is certainly beyond that.
  const ahead = local - (server + 1000);
  const behind = server - local;
  if (ahead > 0) return Math.round(ahead / 1000);
  if (behind > 0) return -Math.round(behind / 1000);
  return 0;
}
