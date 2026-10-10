// Auth: the screens and everything the person touches.
// The cryptography and code maths live in core.js.

import * as core from './core.js';

const VERSION = '1.1.0';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const displayName = (a) => a.issuer || a.label;

// ------------------------------------------------------------------ storage

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('auth', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbWrite(fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite', { durability: 'strict' });
    fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

const idbSet = (key, value) => idbWrite((s) => s.put(value, key));
const idbClear = () => idbWrite((s) => s.clear());

function localGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* only a convenience */
  }
}

// Other tabs or the installed app window share the same storage.
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('auth') : null;

// -------------------------------------------------------------------- state

const state = {
  record: null, // the encrypted vault, as stored
  session: null, // { key, kdf } while unlocked
  data: null, // decrypted vault while unlocked
  keys: new Map(), // account id -> HMAC CryptoKey
  codes: new Map(), // account id -> { counter, code }
  rows: new Map(), // account id -> DOM handles
  lastActivity: 0,
  timer: 0,
  installEvent: null,
  menuAccountId: null,
  visiting: false, // the online vault, opened on a device that isn't yours
};

// ------------------------------------------------------------------ helpers

function showScreen(name) {
  for (const s of $$('.screen')) s.hidden = s.id !== `screen-${name}`;
  document.body.dataset.screen = name;
}

function setError(form, message) {
  const el = $('.form-error', form);
  if (el) el.textContent = message || '';
}

let toastTimer = 0;
function toast(message, ms = 2800) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Runs `fn` with the button showing what's happening. Unexpected errors end
// up in a toast rather than leaving the button stuck.
async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    if (err instanceof core.InputError) toast(err.message, 4000);
    else if (err && err.name === 'QuotaExceededError') toast('This device is out of storage space, so Auth couldn’t save.', 5000);
    else toast('Something went wrong, so that didn’t finish. Try again.', 4000);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const t = h('textarea', { class: 'sr-only', 'aria-hidden': 'true' });
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch {
    return false;
  }
}

function closeDialogs() {
  for (const d of $$('dialog[open]')) d.close();
}

// ------------------------------------------------------------ the wheels

function buildLockBody(digits, fill = '–') {
  const first = digits === 8 ? 4 : 3;
  const body = h('span', { class: 'lockbody wheels' });
  for (let i = 0; i < digits; i++) {
    if (i === first) body.append(h('span', { class: 'wheel-gap' }));
    body.append(
      h(
        'span',
        { class: 'wheel' },
        h('span', { class: 'wheel-strip' }, h('span', { class: 'digit', text: fill }), h('span', { class: 'digit' }))
      )
    );
  }
  return body;
}

// Rolls each wheel whose digit changed, left to right, like a combination lock.
function setLockBody(body, code, animate) {
  const strips = $$('.wheel-strip', body);
  [...code].forEach((d, i) => {
    const strip = strips[i];
    if (!strip) return;
    if (strip._finish) strip._finish();
    const [cur, next] = strip.children;
    if (!animate || reduceMotion.matches || document.hidden || cur.textContent === d) {
      cur.textContent = d;
      return;
    }
    next.textContent = d;
    strip.style.setProperty('--delay', `${i * 45}ms`);
    strip.classList.add('roll');
    const finish = () => {
      if (strip._finish !== finish) return;
      strip._finish = null;
      clearTimeout(timer);
      cur.textContent = d;
      next.textContent = '';
      strip.classList.remove('roll');
    };
    const timer = setTimeout(finish, 750 + i * 45);
    strip._finish = finish;
    strip.addEventListener('transitionend', finish, { once: true });
  });
}

function resetEmblems() {
  for (const body of $$('.emblem .lockbody')) setLockBody(body, '–'.repeat(6), false);
}

function shake(el) {
  if (reduceMotion.matches) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function playUnlock() {
  if (reduceMotion.matches) return Promise.resolve();
  const body = $('#screen-locked .lockbody');
  const digits = Array.from({ length: 6 }, (_, i) => String((i * 7 + new Date().getSeconds()) % 10)).join('');
  setLockBody(body, digits, true);
  return new Promise((r) => setTimeout(r, 460));
}

// ------------------------------------------------------------- boot

async function boot() {
  $('#version-line').textContent = `Auth version ${VERSION}.`;
  for (const e of $$('.emblem')) e.append(buildLockBody(6));
  wire();

  if (!window.isSecureContext || !globalThis.crypto || !crypto.subtle) {
    return unsupported(
      'Auth has to be opened from its https:// address, or the browser won’t let it encrypt anything. Open it from your GitHub Pages link.'
    );
  }
  if (!('indexedDB' in window)) {
    return unsupported('This browser won’t let Auth save data. Open Auth in Chrome on your phone or computer.');
  }
  try {
    state.record = (await idbGet('vault')) || null;
  } catch {
    return unsupported(
      'This browser isn’t letting Auth save data. If you’re in an incognito or private window, open Auth in a normal one.'
    );
  }

  registerServiceWorker();
  if (state.record) showLocked();
  else showSetup();
}

function unsupported(reason) {
  $('#unsupported-reason').textContent = reason;
  showScreen('unsupported');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // An existing controller means this is an update, not the first install.
  const updating = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updating) return;
    if (state.session) {
      showBanner('update', 'Auth was updated. Reload to use the new version.', {
        actionLabel: 'Reload',
        onAction: () => location.reload(),
      });
    } else {
      location.reload();
    }
  });
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support is off:', err));
}

// ------------------------------------------------------------- setup

function showSetup() {
  showScreen('setup');
  resetEmblems();
  const f = $('#form-setup');
  f.reset();
  setError(f, '');
  updateStrength(f.password, $('#setup-strength'));
  f.password.focus();
}

async function onSetup(e) {
  e.preventDefault();
  const f = e.currentTarget;
  setError(f, '');
  try {
    core.checkNewPassword(f.password.value, f.confirm.value);
  } catch (err) {
    setError(f, err.message);
    return;
  }
  await busy($('[type=submit]', f), 'Setting up…', async () => {
    const { session, record } = await core.createVault(f.password.value, core.emptyVaultData());
    await persist(record, session);
    f.reset();
    await enterUnlocked(session, await core.readWithSession(record, session));
    requestPersistence();
  });
}

function updateStrength(input, out, mode = 'device') {
  const s = core.passwordStrength(input.value);
  out.dataset.score = String(s.score);
  const text = $('.strength-text', out);
  if (mode === 'online') {
    const tip = 'Six or more random words works well.';
    if (!s.score) text.textContent = `This one has to be strong, because anyone can download the file. ${tip}`;
    else if (s.score < 3 || input.value.length < core.ONLINE_MIN_LENGTH) text.textContent = `${s.label}. Not strong enough for a file anyone can download. ${tip}`;
    else text.textContent = `${s.label}. Strong enough for the online vault.`;
    return;
  }
  const tip = 'Try five or more random words, not names or dates.';
  if (!s.score) text.textContent = `Longer is stronger. ${tip}`;
  else if (s.score < 3) text.textContent = `${s.label}. ${tip}`;
  else text.textContent = `${s.label}.`;
}

// ------------------------------------------------------------- locked

function showLocked() {
  showScreen('locked');
  resetEmblems();
  const f = $('#form-unlock');
  f.reset();
  setError(f, '');
  f.password.focus();
}

async function lockoutLeft() {
  try {
    const meta = await idbGet('meta');
    return meta && meta.until > Date.now() ? Math.ceil((meta.until - Date.now()) / 1000) : 0;
  } catch {
    return 0;
  }
}

// After 5 wrong tries, wait 30 s, then 60 s, 120 s ... up to 5 minutes.
async function noteFailure() {
  const meta = (await idbGet('meta').catch(() => null)) || { failed: 0, until: 0 };
  meta.failed += 1;
  if (meta.failed >= 5) meta.until = Date.now() + Math.min(300, 30 * 2 ** (meta.failed - 5)) * 1000;
  await idbSet('meta', meta).catch(() => {});
  return meta;
}

let unlocking = false;

async function onUnlock(e) {
  e.preventDefault();
  const f = e.currentTarget;
  if (unlocking) return; // a double tap must not start a second attempt
  setError(f, '');
  const password = f.password.value;
  if (!password) {
    setError(f, 'Enter your password.');
    return;
  }
  unlocking = true;
  try {
    await busy($('[type=submit]', f), 'Unlocking…', () => tryUnlock(f, password));
  } finally {
    unlocking = false;
  }
}

async function tryUnlock(f, password) {
  const wait = await lockoutLeft();
  if (wait > 0) {
    setError(f, `Too many wrong tries. Try again in ${plural(wait, 'second')}.`);
    return;
  }
  const record = state.record;
  let opened;
  try {
    opened = await core.openVault(record, password);
  } catch (err) {
    if (!(err instanceof core.VaultError)) throw err;
    if (err.code === 'wrong-password') {
      const meta = await noteFailure();
      shake($('#screen-locked .emblem'));
      setError(
        f,
        meta.until > Date.now()
          ? `That password didn’t open Auth. Too many wrong tries, so wait ${plural(Math.ceil((meta.until - Date.now()) / 1000), 'second')}.`
          : 'That password didn’t open Auth. Check it and try again.'
      );
      f.password.select();
    } else {
      setError(
        f,
        'The data saved on this device is damaged, so Auth can’t open it. Erase Auth and restore a backup, or sign in with your other device or a backup code.'
      );
    }
    return;
  }
  await idbSet('meta', { failed: 0, until: 0 }).catch(() => {});
  f.reset();
  await playUnlock();
  if (state.record !== record) {
    // Another Auth window saved a change while this one was unlocking.
    resetEmblems();
    setError(f, 'Auth was changed in another window. Enter your password again.');
    return;
  }
  await enterUnlocked(opened.session, opened.data);
}

async function onForgot() {
  const ok = await confirmDialog({
    title: 'Forgot your password?',
    body: 'Your codes are encrypted with your password, so nobody can get them back without it. You can erase Auth on this device and start over. Until then, sign in with your other device or one of Instagram’s backup codes.',
    typed: 'erase',
    typedLabel: 'Type “erase” to delete everything Auth saved on this device',
    ok: 'Erase and start over',
  });
  if (ok) await eraseEverything();
}

// ------------------------------------------------------------- unlocked

// `visiting` is the online vault opened on a device that isn't yours:
// view only, nothing is saved here, and it locks sooner.
async function enterUnlocked(session, data, { visiting = false } = {}) {
  const keys = new Map();
  for (const a of data.accounts) {
    keys.set(a.id, await core.importTotpKey(core.base32Decode(a.secret), a.algorithm));
  }
  state.session = session;
  state.data = data;
  state.keys = keys;
  state.visiting = visiting;
  state.lastActivity = Date.now();
  setVisitingUi(visiting);
  showScreen('main');
  renderAccounts();
  startTicking();
  checkClock();
  if (visiting) {
    showBanner(
      'visiting',
      'You’re viewing your online vault. Nothing is saved on this device, and it locks after a minute without use. Tap the lock when you’re done.',
      state.record
        ? { dismissible: false }
        : { dismissible: false, actionLabel: 'Keep on this device', onAction: openKeepDialog }
    );
  } else {
    maybeOfferInstall();
  }
}

// Visiting mode hides everything that would change or reveal the vault.
function setVisitingUi(visiting) {
  $('#btn-add').hidden = visiting;
  $('#btn-settings').hidden = visiting;
  $('#btn-add-empty').hidden = visiting;
  document.body.classList.toggle('visiting', visiting);
}

function lock() {
  if (!state.session) return;
  const wasVisiting = state.visiting;
  stopTicking();
  stopScanner();
  closeDialogs();
  state.session = null;
  state.data = null;
  state.keys = new Map();
  state.visiting = false;
  state.codes.clear();
  state.rows.clear();
  state.menuAccountId = null;
  $('#accounts').replaceChildren();
  $('#banners').replaceChildren();
  clearReveal();
  wipeForms();
  setVisitingUi(false);
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
  if (state.record) {
    showLocked();
  } else {
    showSetup();
    if (wasVisiting) toast('Locked. Nothing from your vault was kept on this device.', 4000);
  }
}

// Closed dialogs keep whatever was typed into them. Clear anything that
// could hold a setup key or a password.
function wipeForms() {
  for (const id of ['#form-add', '#form-rename', '#form-change', '#form-password', '#form-confirm', '#form-online', '#form-keep']) {
    const f = $(id);
    f.reset();
    setError(f, '');
  }
  $('#add-from-qr').hidden = true;
}

// Encrypt-then-verify: a new record must open before it replaces the old one.
async function persist(record, session) {
  await core.readWithSession(record, session);
  await idbSet('vault', record);
  state.record = record;
  if (channel) channel.postMessage({ type: 'vault-changed' });
}

async function save() {
  // The online vault is view only: nothing it shows may be written here.
  if (state.visiting) throw new Error('The online vault is view only.');
  const session = state.session;
  const record = await core.sealVault(session, state.data);
  await persist(record, session);
}

// True while the same unlocked session is still open. Key derivation and
// saving take a moment, and Auth can lock in the meantime; after that it must
// not touch the data it just let go of.
function stillOpen(session) {
  return session !== null && state.session === session;
}

function findAccount(id) {
  return state.data ? state.data.accounts.find((a) => a.id === id) : null;
}

function renderAccounts() {
  const list = $('#accounts');
  list.replaceChildren();
  state.rows.clear();
  state.codes.clear();
  const accounts = state.data.accounts;
  $('#empty').hidden = accounts.length > 0;
  $('#copy-hint').hidden = accounts.length === 0;
  for (const a of accounts) {
    const row = buildRow(a);
    list.append(row.li);
    state.rows.set(a.id, row);
  }
  tick(true);
  checkOnlineCopy();
}

// Reminds you when the online vault no longer matches your accounts.
async function checkOnlineCopy() {
  const online = state.data && state.data.settings.onlineVault;
  if (!online || state.visiting) {
    removeBanner('online-stale');
    return;
  }
  const session = state.session;
  const fingerprint = await core.accountsFingerprint(state.data.accounts);
  if (!stillOpen(session)) return;
  if (fingerprint === online.fingerprint) {
    removeBanner('online-stale');
  } else if (!$('[data-banner="online-stale"]')) {
    showBanner('online-stale', 'Your online vault doesn’t have your latest account changes. Make a new vault.json and upload it to GitHub.', {
      actionLabel: 'Update',
      onAction: openOnlineDialog,
    });
  }
}

function buildRow(a) {
  const lockbody = buildLockBody(a.digits);
  const codeButton = h('button', { class: 'code', type: 'button', 'aria-label': `${displayName(a)} code` }, lockbody);
  const fill = h('span', { class: 'timebar-fill' });
  const secs = h('span', { class: 'secs', 'aria-hidden': 'true' });
  // No options menu when viewing the online vault: nothing to rename, delete
  // or reveal on a device that isn't yours.
  const more = state.visiting
    ? null
    : h(
        'button',
        { class: 'icon-btn acct-more', type: 'button', 'aria-label': `Options for ${displayName(a)}`, title: 'Options' },
        icon('i-more')
      );
  const li = h(
    'li',
    { class: 'acct' },
    h(
      'div',
      { class: 'acct-head' },
      h(
        'p',
        { class: 'acct-name' },
        h('span', { class: 'acct-issuer', text: displayName(a) }),
        a.issuer && a.label ? h('span', { class: 'acct-label', text: a.label }) : null
      ),
      more
    ),
    h(
      'div',
      { class: 'acct-body' },
      h('div', { class: 'dial' }, codeButton, h('span', { class: 'timebar', 'aria-hidden': 'true' }, fill)),
      secs
    )
  );
  codeButton.addEventListener('click', () => copyCode(a.id));
  if (more) more.addEventListener('click', () => openAccountSheet(a.id));
  return { li, lockbody, fill, secs, codeButton };
}

function startTicking() {
  stopTicking();
  state.timer = setInterval(() => tick(false), 250);
}

function stopTicking() {
  clearInterval(state.timer);
  state.timer = 0;
}

function idleLimitPassed(now = Date.now()) {
  // On someone else's device, never stay open longer than a minute.
  const seconds = state.visiting ? Math.min(60, state.data.settings.autoLockSeconds) : state.data.settings.autoLockSeconds;
  return now - state.lastActivity > seconds * 1000;
}

async function tick(initial) {
  if (!state.session) return;
  const now = Date.now();
  if (idleLimitPassed(now)) {
    lock();
    return;
  }
  const session = state.session;
  for (const a of state.data.accounts) {
    const row = state.rows.get(a.id);
    if (!row) continue;
    const left = core.secondsLeft(now, a.period);
    row.fill.style.transform = `scaleX(${(left / a.period).toFixed(4)})`;
    row.secs.textContent = String(Math.ceil(left));
    row.li.classList.toggle('is-low', left <= 5);

    const counter = core.totpCounter(now, a.period);
    const prev = state.codes.get(a.id);
    if (prev && prev.counter === counter) continue;
    state.codes.set(a.id, { counter, code: null });
    const code = await core.hotp(state.keys.get(a.id), counter, a.digits);
    if (state.session !== session || state.codes.get(a.id)?.counter !== counter) continue;
    state.codes.set(a.id, { counter, code });
    setLockBody(row.lockbody, code, !initial && Boolean(prev && prev.code));
    row.codeButton.setAttribute('aria-label', `${displayName(a)} code ${core.splitCode(code).join(' ')}. Copy`);
  }
}

async function copyCode(id) {
  const a = findAccount(id);
  const entry = state.codes.get(id);
  if (!a || !entry || !entry.code) return;
  const ok = await writeClipboard(entry.code);
  if (!ok) {
    toast('Couldn’t copy. Type the code in yourself.');
    return;
  }
  const row = state.rows.get(id);
  if (row) {
    row.li.classList.remove('copied');
    void row.li.offsetWidth;
    row.li.classList.add('copied');
  }
  const left = Math.ceil(core.secondsLeft(Date.now(), a.period));
  toast(left <= 5 ? `Copied. It changes in ${plural(left, 'second')}, so be quick.` : `Copied ${displayName(a)} code`);
}

// --------------------------------------------------------------- banners

function showBanner(id, text, { warn = false, actionLabel, onAction, onDismiss, dismissible = true } = {}) {
  removeBanner(id);
  const actions = h('div', { class: 'banner-actions' });
  if (actionLabel) {
    const b = h('button', { class: 'btn btn--primary', type: 'button', text: actionLabel });
    b.addEventListener('click', onAction);
    actions.append(b);
  }
  const el = h(
    'div',
    { class: `banner${warn ? ' banner--warn' : ''}`, 'data-banner': id, role: warn ? 'alert' : null },
    h('p', { class: 'banner-text', text }),
    actions
  );
  if (dismissible) {
    const dismiss = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss' }, icon('i-close'));
    dismiss.addEventListener('click', () => {
      el.remove();
      if (onDismiss) onDismiss();
    });
    actions.append(dismiss);
  }
  $('#banners').append(el);
}

function removeBanner(id) {
  const el = $(`[data-banner="${id}"]`);
  if (el) el.remove();
}

// A device clock that's off by more than a few seconds is the most common
// reason codes get rejected. The server's Date header is a good-enough check.
async function checkClock() {
  if (!navigator.onLine) return;
  try {
    const sent = Date.now();
    const res = await fetch(`./manifest.webmanifest?clock=${sent}`, { method: 'HEAD', cache: 'no-store' });
    const received = Date.now();
    const offset = core.clockOffset(res.headers.get('Date'), sent, received);
    if (offset !== null && Math.abs(offset) >= 20 && state.session) {
      showBanner(
        'clock',
        `This device’s clock is about ${plural(Math.abs(offset), 'second')} ${offset > 0 ? 'fast' : 'slow'}, so your codes may be rejected. Turn on automatic date and time in your device settings.`,
        { warn: true }
      );
    }
  } catch {
    /* offline or blocked; nothing to say */
  }
}

// ------------------------------------------------------------ install

function maybeOfferInstall() {
  if (!state.installEvent || !state.session || localGet('auth.installOffered')) return;
  showBanner('install', 'Install Auth so it opens like an app, works offline, and Chrome keeps its data.', {
    actionLabel: 'Install',
    onAction: promptInstall,
    onDismiss: () => localSet('auth.installOffered', '1'),
  });
}

async function promptInstall() {
  const ev = state.installEvent;
  if (!ev) return;
  state.installEvent = null;
  $('#group-install').hidden = true;
  removeBanner('install');
  localSet('auth.installOffered', '1');
  ev.prompt();
  try {
    await ev.userChoice;
  } catch {
    /* ignore */
  }
}

async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* best effort */
  }
}

async function describeStorage() {
  let persisted = false;
  try {
    persisted = Boolean(navigator.storage && (await navigator.storage.persisted()));
  } catch {
    /* unknown */
  }
  return persisted
    ? 'Chrome will keep Auth’s data on this device unless you clear Chrome’s data for this site or uninstall Auth.'
    : 'Chrome may clear Auth’s data if this device runs low on space. Installing Auth helps, and a backup protects you either way.';
}

// ------------------------------------------------------------ add account

function openAddSheet() {
  const f = $('#form-add');
  f.reset();
  f.issuer.value = 'Instagram';
  setError(f, '');
  $('#add-from-qr').hidden = true;
  $('.advanced', f).open = false;
  $('#scanner-status').textContent = 'Point your camera at the QR code.';
  $('#sheet-add').showModal();
  const phone = matchMedia('(pointer: coarse)').matches;
  selectTab(phone && navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'scan' : 'key');
}

function selectTab(name) {
  for (const t of ['key', 'scan']) {
    const tab = $(`#tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#panel-${t}`).hidden = !on;
  }
  if (name === 'scan') {
    startScanner();
  } else {
    stopScanner();
    if (!matchMedia('(pointer: coarse)').matches) $('#form-add').secret.focus();
  }
}

async function onAddAccount(e) {
  e.preventDefault();
  const f = e.currentTarget;
  setError(f, '');
  let account;
  try {
    account = core.newAccount({
      issuer: f.issuer.value,
      label: f.label.value,
      secret: f.secret.value,
      algorithm: f.algorithm.value,
      digits: f.digits.value,
      period: f.period.value,
    });
  } catch (err) {
    if (!(err instanceof core.InputError)) throw err;
    setError(f, err.message);
    return;
  }
  if (state.data.accounts.some((a) => a.secret === account.secret)) {
    setError(f, 'This setup key is already in Auth.');
    return;
  }
  await busy($('[type=submit]', f), 'Adding…', async () => {
    const session = state.session;
    const key = await core.importTotpKey(core.base32Decode(account.secret), account.algorithm);
    if (!stillOpen(session)) return;
    state.data.accounts.push(account);
    try {
      await save();
    } catch (err) {
      if (stillOpen(session)) state.data.accounts.pop();
      throw err;
    }
    if (!stillOpen(session)) return;
    state.keys.set(account.id, key);
    $('#sheet-add').close();
    renderAccounts();
    const row = state.rows.get(account.id);
    if (row) {
      row.li.classList.add('is-new');
      row.li.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }
    toast(`${displayName(account)} added. Type its code into ${account.issuer || 'the site'} to finish turning on two-factor.`, 6000);
  });
}

// Fills the form from a scanned or pasted QR code, so the person can check it.
function useQrText(text) {
  const f = $('#form-add');
  let fields;
  try {
    fields = core.parseOtpauth(text);
  } catch (err) {
    const message = err instanceof core.InputError ? err.message : 'That QR code couldn’t be read.';
    if (!$('#panel-scan').hidden) $('#scanner-status').textContent = message;
    else setError(f, message);
    return false;
  }
  stopScanner();
  f.issuer.value = fields.issuer;
  f.label.value = fields.label;
  f.secret.value = core.groupSecret(fields.secret);
  f.algorithm.value = fields.algorithm;
  f.digits.value = String(fields.digits);
  f.period.value = String(fields.period);
  $('.advanced', f).open = fields.algorithm !== 'SHA1' || fields.digits !== 6 || fields.period !== 30;
  $('#add-from-qr').hidden = false;
  setError(f, '');
  selectTab('key');
  $('[type=submit]', f).focus();
  return true;
}

// ------------------------------------------------------------ QR reading

const scan = { stream: null, timer: 0, detect: null, canvas: null, run: 0 };
let jsQRPromise = null;

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRPromise) {
    jsQRPromise = new Promise((resolve, reject) => {
      const s = h('script', { src: 'jsqr.js' });
      s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR missing')));
      s.onerror = () => reject(new Error('jsQR failed to load'));
      document.head.append(s);
    });
    jsQRPromise.catch(() => {
      jsQRPromise = null;
    });
  }
  return jsQRPromise;
}

function frameData(source, width, height) {
  const max = 1000;
  const scale = Math.min(1, max / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const hgt = Math.max(1, Math.round(height * scale));
  if (!scan.canvas) scan.canvas = document.createElement('canvas');
  const c = scan.canvas;
  c.width = w;
  c.height = hgt;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, hgt);
  return ctx.getImageData(0, 0, w, hgt);
}

// Uses Chrome's built-in barcode reader when there is one (Android), and the
// bundled jsQR library everywhere else.
async function getDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (source) => {
          const found = await detector.detect(source);
          return found.length ? found[0].rawValue : null;
        };
      }
    } catch {
      /* fall back to jsQR */
    }
  }
  const jsQR = await loadJsQR();
  return async (source, width, height) => {
    const img = frameData(source, width, height);
    const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    return found ? found.data : null;
  };
}

const NO_CAMERA_TIP = matchMedia('(pointer: coarse)').matches
  ? 'Use a picture of the QR code, or type the setup key.'
  : 'Paste a screenshot of the QR code with Ctrl+V, choose a picture of it, or type the setup key.';

async function startScanner() {
  const status = $('#scanner-status');
  const video = $('#scanner-video');
  // With no camera, hide the empty viewfinder and say what to do instead.
  const noCamera = (message) => {
    $('#scanner').hidden = true;
    status.textContent = message;
  };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    noCamera(`This browser can’t use the camera here. ${NO_CAMERA_TIP}`);
    return;
  }
  if (scan.stream) return;
  const run = ++scan.run;
  $('#scanner').hidden = false;
  status.textContent = 'Starting the camera…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (run !== scan.run || !$('#sheet-add').open || $('#panel-scan').hidden) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    scan.stream = stream;
    video.srcObject = stream;
    await video.play();
    scan.detect = scan.detect || (await getDetector());
    if (run !== scan.run) return;
    status.textContent = 'Point your camera at the QR code.';
    scanLoop(run);
  } catch (err) {
    if (run !== scan.run) return;
    stopScanner();
    const name = err && err.name;
    noCamera(
      name === 'NotAllowedError'
        ? `Auth isn’t allowed to use the camera. You can allow it in Chrome’s site settings. ${NO_CAMERA_TIP}`
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? `No camera found. ${NO_CAMERA_TIP}`
          : `The camera didn’t start. ${NO_CAMERA_TIP}`
    );
  }
}

function scanLoop(run) {
  const video = $('#scanner-video');
  const step = async () => {
    if (run !== scan.run || !scan.stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        const text = await scan.detect(video, video.videoWidth, video.videoHeight);
        if (run !== scan.run) return;
        if (text && useQrText(text)) return;
      } catch {
        /* keep trying */
      }
    }
    scan.timer = setTimeout(step, 180);
  };
  step();
}

function stopScanner() {
  scan.run++;
  clearTimeout(scan.timer);
  if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop());
  scan.stream = null;
  const video = $('#scanner-video');
  if (video) video.srcObject = null;
}

async function readQrImage(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('Choose a picture of the QR code.');
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const detect = scan.detect || (await getDetector());
    scan.detect = detect;
    const text = await detect(bitmap, bitmap.width, bitmap.height);
    bitmap.close && bitmap.close();
    if (!text) {
      const msg = 'No QR code found in that picture. Try a closer, sharper one, or type the setup key.';
      if (!$('#panel-scan').hidden) $('#scanner-status').textContent = msg;
      else setError($('#form-add'), msg);
      return;
    }
    useQrText(text);
  } catch (err) {
    console.error(err);
    toast('That picture couldn’t be read.');
  }
}

function onAddPaste(e) {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const image = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (image) {
    e.preventDefault();
    readQrImage(image.getAsFile());
    return;
  }
  const text = e.clipboardData ? e.clipboardData.getData('text') : '';
  if (/^\s*otpauth/i.test(text)) {
    e.preventDefault();
    useQrText(text.trim());
  }
}

// ------------------------------------------------------------ account sheet

function openAccountSheet(id) {
  const a = findAccount(id);
  if (!a) return;
  state.menuAccountId = id;
  $('#account-title').textContent = a.issuer && a.label ? `${a.issuer} (${a.label})` : displayName(a);
  $('#account-menu').hidden = false;
  $('#form-rename').hidden = true;
  clearReveal();
  $('#sheet-account').showModal();
}

async function onAccountAction(action) {
  const a = findAccount(state.menuAccountId);
  if (!a) return;
  if (action === 'rename') {
    const f = $('#form-rename');
    f.issuer.value = a.issuer;
    f.label.value = a.label;
    setError(f, '');
    $('#account-menu').hidden = true;
    f.hidden = false;
    f.issuer.focus();
  } else if (action === 'reveal') {
    const opened = await askPassword(state.record, `Enter your password to show the setup key for ${displayName(a)}.`, 'Show setup key');
    if (!opened || !state.session || !$('#sheet-account').open) return;
    await showReveal(a);
  } else if (action === 'delete') {
    $('#sheet-account').close();
    const ok = await confirmDialog({
      title: `Delete ${displayName(a)}?`,
      body: `If two-factor is still on for this account, you’ll need your other device or one of ${a.issuer || 'its'} backup codes to sign in.`,
      ok: 'Delete',
    });
    if (!ok || !state.session) return;
    const session = state.session;
    const index = state.data.accounts.findIndex((x) => x.id === a.id);
    if (index < 0) return;
    const [removed] = state.data.accounts.splice(index, 1);
    try {
      await save();
    } catch (err) {
      console.error(err);
      if (!stillOpen(session)) return;
      state.data.accounts.splice(index, 0, removed);
      toast('Something went wrong, so nothing was deleted.');
      return;
    }
    if (!stillOpen(session)) return;
    state.keys.delete(a.id);
    renderAccounts();
    toast(`${displayName(a)} deleted`);
  }
}

async function onRename(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const a = findAccount(state.menuAccountId);
  if (!a) return;
  const issuer = core.cleanText(f.issuer.value);
  const label = core.cleanText(f.label.value);
  if (!issuer && !label) {
    setError(f, 'Give this account a name, like “Instagram”.');
    return;
  }
  await busy($('[type=submit]', f), 'Saving…', async () => {
    const session = state.session;
    const before = { issuer: a.issuer, label: a.label };
    Object.assign(a, { issuer, label });
    try {
      await save();
    } catch (err) {
      Object.assign(a, before);
      if (!stillOpen(session)) return;
      throw err;
    }
    if (!stillOpen(session)) return;
    $('#sheet-account').close();
    renderAccounts();
    toast('Name saved');
  });
}

async function showReveal(a) {
  $('#account-menu').hidden = true;
  $('#form-rename').hidden = true;
  $('#panel-reveal').hidden = false;
  $('#reveal-key').textContent = core.groupSecret(a.secret);
  const canvas = $('#reveal-qr');
  try {
    const { qrcode } = await import('./qrcode.js');
    const qr = qrcode(0, 'M');
    qr.addData(core.buildOtpauth(a));
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const cssSize = 232;
    const ratio = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const cell = Math.max(1, Math.floor((cssSize * ratio) / (n + quiet * 2)));
    const size = cell * (n + quiet * 2);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
  } catch (err) {
    console.error(err);
    canvas.hidden = true;
  }
}

function clearReveal() {
  $('#panel-reveal').hidden = true;
  $('#reveal-key').textContent = '';
  const canvas = $('#reveal-qr');
  canvas.hidden = false;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ------------------------------------------------------------ dialogs

// Asks for the password of `record` and returns what it opens, or null.
// `shared` is for someone else's device: don't invite their browser to
// remember the password.
function askPassword(record, reason, submitLabel = 'Continue', { shared = false, title = 'Enter your password', busyLabel = 'Checking…' } = {}) {
  return new Promise((resolve) => {
    const d = $('#dialog-password');
    const f = $('#form-password');
    const button = $('#password-submit');
    f.reset();
    setError(f, '');
    $('#password-title').textContent = title;
    $('#password-reason').textContent = reason;
    button.textContent = submitLabel;
    f.password.autocomplete = shared ? 'off' : 'current-password';
    f.username.disabled = shared;
    let result = null;
    const onSubmit = async (e) => {
      e.preventDefault();
      setError(f, '');
      if (!f.password.value) {
        setError(f, 'Enter the password.');
        return;
      }
      await busy(button, busyLabel, async () => {
        try {
          result = await core.openVault(record, f.password.value);
          d.close();
        } catch (err) {
          if (err instanceof core.VaultError && err.code === 'wrong-password') {
            setError(f, 'That password didn’t work. Try again.');
            f.password.select();
          } else if (err instanceof core.VaultError) {
            setError(f, 'This data is damaged, so it can’t be opened.');
          } else {
            throw err;
          }
        }
      });
    };
    f.addEventListener('submit', onSubmit);
    d.addEventListener(
      'close',
      () => {
        f.removeEventListener('submit', onSubmit);
        f.reset();
        f.password.autocomplete = 'current-password';
        f.username.disabled = false;
        resolve(result);
      },
      { once: true }
    );
    d.showModal();
    f.password.focus();
  });
}

function confirmDialog({ title, body, ok, typed = null, typedLabel = '' }) {
  return new Promise((resolve) => {
    const d = $('#dialog-confirm');
    const f = $('#form-confirm');
    f.reset();
    setError(f, '');
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    $('#confirm-ok').textContent = ok;
    $('#confirm-typed').hidden = !typed;
    $('#confirm-typed-label').textContent = typedLabel;
    let confirmed = false;
    const onSubmit = (e) => {
      e.preventDefault();
      if (typed && f.typed.value.trim().toLowerCase() !== typed) {
        setError(f, `Type “${typed}” to confirm.`);
        f.typed.focus();
        return;
      }
      confirmed = true;
      d.close();
    };
    f.addEventListener('submit', onSubmit);
    d.addEventListener(
      'close',
      () => {
        f.removeEventListener('submit', onSubmit);
        resolve(confirmed);
      },
      { once: true }
    );
    d.showModal();
    if (typed) f.typed.focus();
    else $('[data-close]', f.querySelector('.btn-row')).focus();
  });
}

// ------------------------------------------------------------ settings

async function openSettings() {
  for (const r of $$('input[name=autolock]')) r.checked = Number(r.value) === state.data.settings.autoLockSeconds;
  $('#group-install').hidden = !state.installEvent;
  $('#storage-status').textContent = 'Checking storage…';
  const online = state.data.settings.onlineVault;
  if (online) {
    const made = new Date(online.savedAt);
    const when = Number.isNaN(made.getTime())
      ? 'earlier'
      : `on ${made.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
    const current = (await core.accountsFingerprint(state.data.accounts)) === online.fingerprint;
    $('#online-status').textContent = current
      ? `You made your online vault ${when}, and it has all your accounts.`
      : `You made your online vault ${when}, but it doesn’t have your latest account changes. Make a new one and upload it.`;
    $('#btn-online').textContent = 'Make a new vault.json';
  } else {
    $('#online-status').textContent =
      'Put a locked copy of your accounts online, so you can get a code on any phone with your link and a password.';
    $('#btn-online').textContent = 'Make online vault file';
  }
  $('#sheet-settings').showModal();
  $('#storage-status').textContent = await describeStorage();
}

// ------------------------------------------------------------ online vault

function openOnlineDialog() {
  const f = $('#form-online');
  f.reset();
  setError(f, '');
  updateStrength(f.password, $('#online-strength'), 'online');
  f.hidden = false;
  $('#online-done').hidden = true;
  $('#dialog-online').showModal();
  f.password.focus();
}

// Makes vault.json: the same accounts, locked with a separate, stronger
// password and a slower key derivation, for a file anyone can download.
async function onMakeOnline(e) {
  e.preventDefault();
  const f = e.currentTarget;
  setError(f, '');
  try {
    core.checkOnlinePassword(f.password.value, f.confirm.value);
  } catch (err) {
    setError(f, err.message);
    return;
  }
  await busy($('[type=submit]', f), 'Locking it up…', async () => {
    const session = state.session;
    // Both copies record what the online one contains, so either can tell
    // later whether it has fallen behind.
    const info = { savedAt: new Date().toISOString(), fingerprint: await core.accountsFingerprint(state.data.accounts) };
    const data = { ...state.data, settings: { ...state.data.settings, onlineVault: info } };
    const { session: online, record } = await core.createVault(f.password.value, data, core.ONLINE_ITERATIONS);
    if (!stillOpen(session)) return;
    await core.readWithSession(record, online); // it must open before anyone relies on it
    downloadJson(record, 'vault.json');
    state.data.settings.onlineVault = info;
    try {
      await save();
    } catch (err) {
      console.error(err); // only the reminder is lost; the file itself is fine
    }
    if (!stillOpen(session)) return;
    f.reset();
    f.hidden = true;
    $('#online-done').hidden = false;
    $('[data-close]', $('#online-done')).focus();
    removeBanner('online-stale');
  });
}

// On any device: fetch vault.json from the site and open it, view only.
async function openOnlineVault() {
  let record = null;
  await busy($('#btn-open-online'), 'Looking for it…', async () => {
    let res;
    try {
      res = await fetch('./vault.json', { cache: 'no-store' });
    } catch {
      toast('Couldn’t reach your online vault. Check the internet connection and try again.', 5000);
      return;
    }
    if (res.status === 404) {
      toast('There’s no online vault here yet. Make one in Settings on your PC, then upload vault.json to GitHub.', 6000);
      return;
    }
    if (!res.ok) {
      toast(`Couldn’t load your online vault (error ${res.status}). Try again in a minute.`, 5000);
      return;
    }
    try {
      const candidate = await res.json();
      core.checkRecord(candidate);
      record = candidate;
    } catch (err) {
      toast(
        err && err.code === 'unsupported'
          ? 'Your online vault was made by a newer version of Auth.'
          : 'The online vault file is damaged. Make a new one on your PC and upload it again.',
        6000
      );
    }
  });
  if (!record) return;
  const opened = await askPassword(
    record,
    'Type your online vault password. If this phone offers to save it, tap Never.',
    'Open',
    { shared: true, title: 'Open your online vault', busyLabel: 'Opening, this takes a few seconds…' }
  );
  if (!opened || state.session) return;
  await enterUnlocked(opened.session, opened.data, { visiting: true });
}

function openKeepDialog() {
  const f = $('#form-keep');
  f.reset();
  setError(f, '');
  updateStrength(f.password, $('#keep-strength'));
  $('#dialog-keep').showModal();
  f.password.focus();
}

// Turns the opened online vault into this device's own copy (for a new phone).
async function onKeep(e) {
  e.preventDefault();
  const f = e.currentTarget;
  setError(f, '');
  if (!state.visiting || state.record) {
    setError(f, 'Auth is already set up on this device.');
    return;
  }
  try {
    core.checkNewPassword(f.password.value, f.confirm.value);
  } catch (err) {
    setError(f, err.message);
    return;
  }
  await busy($('[type=submit]', f), 'Saving…', async () => {
    const visit = state.session;
    const { session, record } = await core.createVault(f.password.value, state.data);
    if (!stillOpen(visit)) return;
    await persist(record, session);
    if (!stillOpen(visit)) {
      // Saved, but Auth locked in the meantime: show the normal lock screen.
      if (document.body.dataset.screen === 'setup') showLocked();
      return;
    }
    state.session = session;
    state.visiting = false;
    setVisitingUi(false);
    removeBanner('visiting');
    $('#dialog-keep').close();
    renderAccounts();
    requestPersistence();
    toast('Saved on this device. Next time, unlock it with this password.', 5000);
  });
}

async function onAutoLockChange(e) {
  const seconds = Number(e.target.value);
  if (!core.AUTO_LOCK_CHOICES.includes(seconds) || !state.session) return;
  const session = state.session;
  const before = state.data.settings.autoLockSeconds;
  state.data.settings.autoLockSeconds = seconds;
  try {
    await save();
    if (stillOpen(session)) {
      toast(`Auth will lock after ${seconds < 60 ? plural(seconds, 'second') : plural(seconds / 60, 'minute')} without use.`);
    }
  } catch (err) {
    console.error(err);
    if (!stillOpen(session)) return;
    state.data.settings.autoLockSeconds = before;
    for (const r of $$('input[name=autolock]')) r.checked = Number(r.value) === before;
    toast('Something went wrong, so the setting didn’t change.');
  }
}

function openChangePassword() {
  const f = $('#form-change');
  f.reset();
  setError(f, '');
  updateStrength(f.password, $('#change-strength'));
  $('#dialog-change').showModal();
  f.current.focus();
}

async function onChangePassword(e) {
  e.preventDefault();
  const f = e.currentTarget;
  setError(f, '');
  if (!f.current.value) {
    setError(f, 'Enter your current password.');
    return;
  }
  try {
    core.checkNewPassword(f.password.value, f.confirm.value);
  } catch (err) {
    setError(f, err.message);
    return;
  }
  if (f.password.value === f.current.value) {
    setError(f, 'That’s the same as your current password.');
    return;
  }
  await busy($('[type=submit]', f), 'Changing…', async () => {
    const old = state.session;
    const newPassword = f.password.value;
    try {
      await core.openVault(state.record, f.current.value);
    } catch (err) {
      if (err instanceof core.VaultError && err.code === 'wrong-password') {
        setError(f, 'Your current password isn’t right.');
        f.current.select();
        return;
      }
      throw err;
    }
    if (!stillOpen(old)) return;
    const { session, record } = await core.createVault(newPassword, state.data);
    if (!stillOpen(old)) return;
    await persist(record, session);
    if (!stillOpen(old)) return; // saved, but Auth locked meanwhile: unlock with the new password
    state.session = session;
    $('#dialog-change').close();
    toast('Password changed');
  });
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadBackup() {
  downloadJson(state.record, `auth-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast('Backup downloaded. It opens with your current password.', 4000);
}

let restoreMode = 'merge';

function chooseBackup(mode) {
  restoreMode = mode;
  $('#file-backup').click();
}

async function onBackupFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 5000000) {
    toast('That file is too big to be an Auth backup.');
    return;
  }
  let record;
  try {
    record = JSON.parse(await file.text());
    core.checkRecord(record);
  } catch (err) {
    toast(err && err.code === 'unsupported' ? 'That backup is from a newer version of Auth.' : 'That file isn’t an Auth backup.', 4000);
    return;
  }
  const opened = await askPassword(record, 'Enter the password Auth had when this backup was made.', 'Restore');
  if (!opened) return;

  try {
    if (restoreMode === 'setup') {
      if (state.record) return;
      await persist(record, opened.session);
      await enterUnlocked(opened.session, opened.data);
      requestPersistence();
      toast(`Restored ${plural(opened.data.accounts.length, 'account')}. Your password is the one from the backup.`, 5000);
      return;
    }
    const session = state.session;
    if (!session) return;
    const { accounts, added } = core.mergeAccounts(state.data.accounts, opened.data.accounts);
    if (!added) {
      toast('Everything in that backup is already here.');
      return;
    }
    const keys = new Map(state.keys);
    for (const a of accounts) {
      if (!keys.has(a.id)) keys.set(a.id, await core.importTotpKey(core.base32Decode(a.secret), a.algorithm));
    }
    if (!stillOpen(session)) return;
    const before = state.data.accounts;
    state.data.accounts = accounts;
    try {
      await save();
    } catch (err) {
      if (!stillOpen(session)) return;
      state.data.accounts = before;
      throw err;
    }
    if (!stillOpen(session)) return;
    state.keys = keys;
    closeDialogs();
    renderAccounts();
    toast(`Added ${plural(added, 'account')} from the backup.`);
  } catch (err) {
    console.error(err);
    toast('Something went wrong, so the backup wasn’t restored.', 4000);
  }
}

async function onErase() {
  $('#sheet-settings').close();
  const ok = await confirmDialog({
    title: 'Erase Auth from this device?',
    body: 'This deletes your accounts and password from this device, and it can’t be undone. Make sure you can still sign in with your other device or Instagram’s backup codes.',
    typed: 'erase',
    typedLabel: 'Type “erase” to confirm',
    ok: 'Erase',
  });
  if (ok) await eraseEverything();
}

async function eraseEverything() {
  try {
    await idbClear();
  } catch (err) {
    console.error(err);
    toast('Auth couldn’t erase its data. Clear this site’s data in Chrome’s settings instead.', 5000);
    return;
  }
  stopTicking();
  stopScanner();
  closeDialogs();
  state.record = null;
  state.session = null;
  state.data = null;
  state.keys = new Map();
  state.codes.clear();
  state.rows.clear();
  $('#accounts').replaceChildren();
  $('#banners').replaceChildren();
  clearReveal();
  if (channel) channel.postMessage({ type: 'vault-changed' });
  showSetup();
  toast('Auth was erased from this device.');
}

// ------------------------------------------------------------ wiring

function wire() {
  $('#form-setup').addEventListener('submit', onSetup);
  $('#form-setup').password.addEventListener('input', (e) => updateStrength(e.target, $('#setup-strength')));
  $('#btn-setup-restore').addEventListener('click', () => chooseBackup('setup'));
  $('#btn-open-online').addEventListener('click', openOnlineVault);

  $('#form-unlock').addEventListener('submit', onUnlock);
  $('#btn-forgot').addEventListener('click', onForgot);

  $('#btn-add').addEventListener('click', openAddSheet);
  $('#btn-add-empty').addEventListener('click', openAddSheet);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-lock').addEventListener('click', lock);

  $('#form-add').addEventListener('submit', onAddAccount);
  $('#tab-key').addEventListener('click', () => selectTab('key'));
  $('#tab-scan').addEventListener('click', () => selectTab('scan'));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = $('#tab-key').getAttribute('aria-selected') === 'true' ? 'scan' : 'key';
    selectTab(next);
    $(`#tab-${next}`).focus();
  });
  $('#scan-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    readQrImage(file);
  });
  $('#sheet-add').addEventListener('paste', onAddPaste);
  $('#sheet-add').addEventListener('close', () => {
    stopScanner();
    // Don't leave a setup key sitting in the closed form.
    $('#form-add').reset();
    setError($('#form-add'), '');
    $('#add-from-qr').hidden = true;
  });

  $('#account-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b) onAccountAction(b.dataset.action);
  });
  $('#form-rename').addEventListener('submit', onRename);
  $('#btn-copy-key').addEventListener('click', async () => {
    const a = findAccount(state.menuAccountId);
    if (a && (await writeClipboard(a.secret))) toast('Setup key copied');
  });
  $('#sheet-account').addEventListener('close', () => {
    clearReveal();
    $('#form-rename').reset();
  });

  $('#autolock-choices').addEventListener('change', onAutoLockChange);
  $('#btn-change-password').addEventListener('click', openChangePassword);
  $('#form-change').addEventListener('submit', onChangePassword);
  $('#form-change').password.addEventListener('input', (e) => updateStrength(e.target, $('#change-strength')));
  $('#btn-backup').addEventListener('click', downloadBackup);
  $('#btn-restore').addEventListener('click', () => chooseBackup('merge'));
  $('#file-backup').addEventListener('change', onBackupFile);
  $('#btn-erase').addEventListener('click', onErase);
  $('#btn-online').addEventListener('click', () => {
    $('#sheet-settings').close();
    openOnlineDialog();
  });
  $('#form-online').addEventListener('submit', onMakeOnline);
  $('#form-online').password.addEventListener('input', (e) => updateStrength(e.target, $('#online-strength'), 'online'));
  $('#form-keep').addEventListener('submit', onKeep);
  $('#form-keep').password.addEventListener('input', (e) => updateStrength(e.target, $('#keep-strength')));
  $('#btn-install').addEventListener('click', promptInstall);

  // Close buttons, and taps on the dimmed area around a sheet.
  for (const d of $$('dialog')) {
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
      else if (e.target.closest('[data-close]')) d.close();
    });
  }

  // Anything the person does counts as activity for the auto-lock.
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input']) {
    addEventListener(type, () => {
      state.lastActivity = Date.now();
    }, { capture: true, passive: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      document.body.classList.add('veiled');
      stopScanner();
      stopTicking();
      return;
    }
    if (state.session) {
      if (idleLimitPassed()) {
        lock();
      } else {
        tick(false);
        startTicking();
        if ($('#sheet-add').open && !$('#panel-scan').hidden) startScanner();
      }
    }
    document.body.classList.remove('veiled');
  });

  // Leaving the page (or Chrome freezing it) always locks.
  addEventListener('pagehide', lock);

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    $('#group-install').hidden = false;
    maybeOfferInstall();
  });
  addEventListener('appinstalled', () => {
    state.installEvent = null;
    $('#group-install').hidden = true;
    removeBanner('install');
  });

  if (channel) {
    channel.addEventListener('message', async (e) => {
      if (!e.data || e.data.type !== 'vault-changed') return;
      // Another window changed the vault. Lock, so this one can't overwrite it.
      if (state.session) lock();
      try {
        state.record = (await idbGet('vault')) || null;
      } catch {
        /* keep what we have */
      }
      if (!state.record) showSetup();
      else if (document.body.dataset.screen === 'setup') showLocked();
    });
  }
}

boot();
