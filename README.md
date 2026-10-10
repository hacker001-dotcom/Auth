# Auth

Your own two-factor code app. It shows Instagram's 6-digit login codes on your Android phone and your PC, and it's locked with a password. Your setup key is encrypted on each device and never sent anywhere.

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

## Backups

**Settings → Download backup** saves a file that's locked with your current password. Keep it somewhere other than that device, like Google Drive or a USB stick.

To restore, choose **Restore from a backup file** on a fresh install. Or use **Settings → Restore a backup** to add a backup's accounts to an existing Auth.

## If something goes wrong

- **Instagram says the code is wrong.** Make sure your device sets its date and time automatically. Auth shows a warning if your clock looks off. Also check you're typing the current code, not one that just ran out.
- **Forgot the password.** It can't be recovered. That's what the encryption is for. Sign in with your other device or a backup code. Then on Auth's lock screen, tap **Forgot your password?** to erase it and start over.
- **Cleared Chrome's data, or uninstalled the app.** That deletes Auth's data on that device. Set it up again from your other device (**Show setup key and QR code**) or from a backup file.

## What protects you, honestly

- Your setup key is encrypted with AES-256-GCM. The key for that is made from your password with PBKDF2-SHA256 at 600,000 rounds, which makes guessing slow. Nothing is ever sent to GitHub, Google or anyone else. The app only loads its own files.
- **The password is the lock.** If someone copies your browser's data, a weak password can be guessed offline. A long one can't, in any useful amount of time.
- While Auth is unlocked, anything running on that device could read the codes, like malware or a bad browser extension. That's true of every authenticator app.
- **Codes can still be phished.** If a fake Instagram page asks for your code and you type it in, they have it. Check the address bar before you type a code anywhere.
- **Whoever controls your GitHub account controls this app's code.** Turn on two-factor for GitHub too. Your K50 security key works there.

## Changing the app

If you edit any file, also change `VERSION` at the top of `sw.js`, for example to `1.0.1`. Installed copies only fetch new files when that number changes.

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
