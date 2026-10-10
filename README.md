# Auth

Your own two-factor code app. It shows Instagram's 6-digit login codes on your Android phone and your PC, and it's locked with a password. Your setup key is encrypted on each device. It only goes online if you choose to make an online vault, and then only in locked form.

---

## 1. Put it online with GitHub Pages (about 5 minutes)

Your phone can't open files that sit on your PC, so the app needs a web address. GitHub Pages hosts it for free.

1. Sign in at [github.com](https://github.com), click **+** (top right), then **New repository**.
2. Name it `auth`, choose **Public**, and click **Create repository**. Free GitHub Pages needs a public repository. That's fine: the code holds no secrets.
3. On the new repository's page, click **uploading an existing file**.
4. Open `D:\Auth` in File Explorer, select every file (Ctrl+A), drag them all into the browser, and click **Commit changes**.
5. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick **main** and **/ (root)**, and click **Save**.
6. Wait a minute or two and refresh the page. Your address shows at the top: `https://YOUR-USERNAME.github.io/auth/`

Only the app files from `D:\Auth` go in this repository. Never upload a backup file or a setup key to it.

## 2. Install it on both devices

- **Android:** open your address in Chrome, tap **⋮**, then **Install app** (or **Add to Home screen**).
- **PC:** open your address in Chrome and click the install icon at the right end of the address bar. If you don't see it, look for **Install** in Chrome's **⋮** menu.

Each device keeps its own copy. Open Auth on each one and choose a password. Using the same password on both is fine.

**Picking the password:** this password is the lock, so make it a good one. Five or more random words works. Or let Chrome's password manager suggest a long random one and save it. Then unlocking is just a tap. That's a good trade as long as your Google account itself is well protected, and your K50 key is ideal for that.

## 3. Turn on Instagram two-factor (do this on your PC)

Setting it up on the PC lets both devices get the key at the same time, so nothing needs syncing later.

1. Open Auth on your PC and your phone and unlock both.
2. On your PC, go to instagram.com, then **More** (bottom left) → **Settings** → **Accounts Center** → **Password and security** → **Two-factor authentication**. Pick your account, then **Authentication app**. Instagram shows a QR code and a setup key. Instagram moves these menus around now and then. If something's missing, look for Accounts Center.
3. **PC:** in Auth, click **+**. Copy Instagram's setup key into the **Setup key** box, add your username if you like, and click **Add account**. Or take a screenshot of the QR code (Win+Shift+S) and press Ctrl+V in Auth's add window.
4. **Phone:** in Auth, tap **+** and point the camera at the QR code on your PC screen. Check the details and tap **Add account**.
5. Both devices now show the same code. Type it into Instagram to finish.
6. **Save Instagram's backup codes.** In Instagram's **Two-factor authentication** settings, open **Additional methods → Backup codes**. Write them on paper or save them somewhere that isn't your phone or PC. They're your way back in if you lose both devices or forget Auth's password.

## Everyday use

- Unlock, then tap a code to copy it. The bar under the code shows how long it has left. When it turns red, wait for the next one.
- Auth locks itself after a minute without use. You can change that in **Settings**. It also locks when you leave it for longer than that.
- New phone later? Tap **⋮** next to the account, then **Show setup key and QR code**, and scan it with the new phone.

## Open it from anywhere (optional)

This is for when you need a code and have neither your phone nor your PC, like on a friend's phone. You put a locked copy of your accounts, `vault.json`, on GitHub next to the app. Then any browser can open it with your link and a separate online password.

**Read this first.** Anyone who finds your link can download `vault.json` and try to guess its password offline, for as long as they like. Auth makes each guess slow (2,000,000 rounds instead of 600,000) and refuses weak passwords. Even so, the password is all that stands between a stranger and your Instagram key. If it were guessed, they'd still need your Instagram password, but your two-factor would be gone. So:

- Use six or more random words you know by heart. You'll have no device to look it up on when you need it.
- Never use your Instagram password, or any password you use somewhere else.
- Don't save it in a password manager.

**Make it (on your PC):**

1. Open Auth, then **Settings → Open from anywhere → Make online vault file**.
2. Choose the online password and click **Download vault.json**.
3. On GitHub, open your `auth` repository, click **Add file → Upload files**, drop in `vault.json`, and click **Commit changes**. Give it a minute or two to go live.

**Use it on someone else's phone:**

1. Open your link and tap **Not your device? Open your online vault**.
2. Type the online password. It takes a few seconds. If the phone offers to save the password, tap **Never**.
3. Tap the code to copy it. When you're done, tap the lock. It also locks itself after a minute. Nothing is saved on that phone.

**On a new phone of your own,** open the online vault the same way and tap **Keep on this device**. That turns it into a normal install with its own device password.

**Keep it current.** The online copy doesn't update itself. Whenever you add, rename or delete an account, make a new `vault.json` and upload it again. GitHub replaces the old one. Auth reminds you when it's out of date.

**Turn it off** by deleting `vault.json` from the repository. On GitHub, click the file, then **⋯ → Delete file**, then **Commit changes**. Anyone who already downloaded a copy keeps it. If you ever think the online password got out, turn Instagram's two-factor off and on again so you get a new setup key, then add the new key to Auth.

## Backups

**Settings → Download backup** saves a file that's locked with your current password. Keep it somewhere other than that device, like Google Drive or a USB stick.

To restore, choose **Restore from a backup file** on a fresh install. Or use **Settings → Restore a backup** to add a backup's accounts to an existing Auth.

## If something goes wrong

- **Instagram says the code is wrong.** Make sure your device sets its date and time automatically. Auth shows a warning if your clock looks off. Also check you're typing the current code, not one that just ran out.
- **Forgot the password.** It can't be recovered. That's what the encryption is for. Sign in with your other device or a backup code. Then on Auth's lock screen, tap **Forgot your password?** to erase it and start over.
- **Cleared Chrome's data, or uninstalled the app.** That deletes Auth's data on that device. Set it up again from your other device (**Show setup key and QR code**), from a backup file, or with **Keep on this device** from your online vault.
- **"There's no online vault here yet."** Upload `vault.json` to the repository, wait a minute or two, and try again.

## What protects you, honestly

- Your setup key is encrypted with AES-256-GCM. The key for that is made from your password with PBKDF2-SHA256 at 600,000 rounds, which makes guessing slow. The app only ever loads its own files. Nothing is sent to GitHub, Google or anyone else unless you upload `vault.json` yourself.
- **The online vault is a trade.** It's 2,000,000 rounds and needs a strong password, but anyone can download it and guess offline. Skip it if you don't need it. If you do use it, the online password matters more than anything else in this list.
- **The password is the lock.** If someone copies your browser's data, a weak password can be guessed offline. A long one can't, in any useful amount of time.
- While Auth is unlocked, anything running on that device could read the codes, like malware or a bad browser extension. That's true of every authenticator app.
- **Codes can still be phished.** If a fake Instagram page asks for your code and you type it in, they have it. Check the address bar before you type a code anywhere.
- **Whoever controls your GitHub account controls this app's code.** Turn on two-factor for GitHub too. Your K50 security key works there.

## Changing the app

To update the app on GitHub, upload the changed files the same way you did the first time. Drag them in again, and files with the same name get replaced.

If you edit any file yourself, also raise `VERSION` at the top of `sw.js`, for example to `1.1.1`. Installed copies only fetch new files when that number changes. When they do, Auth offers to reload.

## What's in here

| File | What it does |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The app itself |
| `core.js` | Code generation (RFC 6238) and encryption |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | Offline support and install details |
| `barlow-sc-500.woff2`, `barlow-sc-600.woff2` | The number font, Barlow Semi Condensed |
| `jsqr.js` | Reads QR codes: jsQR 1.4.0, unmodified |
| `qrcode.js` | Draws QR codes: qrcode-generator 2.0.4 (`dist/qrcode.mjs`), unmodified |
| `THIRD-PARTY-LICENSES.txt` | Licences for the font and the two QR libraries |
| `vault.json` (only if you make one) | Your locked online vault. Auth makes it; it isn't in this folder. |
