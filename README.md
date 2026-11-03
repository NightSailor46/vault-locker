# Vault Locker

Encrypt folders in your Obsidian vault, notes and attachments alike, with a password. When a folder is locked, its files on disk are unreadable without the password or the recovery key.

## Disclosures (required by Obsidian's developer policies)
- **Payment (optional):** Free protects one folder, with full-strength encryption. Pro ($5, lifetime use) adds unlimited folders, the whole vault, auto-lock, lock on quit, hidden file names and a password per folder. Encryption strength is the same in both. Pro is sold by Senior Enterprises LLC through Lemon Squeezy, which handles checkout and emails the license key.
- **In-plugin promotion:** Free shows a short "Get Pro" line in Vault Locker's own settings tab and a notice when you try to protect a second folder. Nothing is shown anywhere else in Obsidian. No ads are loaded from the internet.
- **Network use:** only for Pro license keys. Free never touches the network.
  - When you paste a key and press Activate, the plugin sends the key and a device label ("Obsidian") to Lemon Squeezy at `https://api.lemonsqueezy.com/v1/licenses/activate`. Lemon Squeezy returns an activation ID.
  - When Obsidian starts and the last check is more than a day old, it sends the key and that activation ID to `https://api.lemonsqueezy.com/v1/licenses/validate` to check the key is still active.
  - If those checks can't reach Lemon Squeezy, Pro keeps working for 30 days from the last good check.
  - Lemon Squeezy sees your IP address like any web request. Its privacy policy applies to those requests.
- **What never leaves your device:** your notes, attachments, file names, folder names, passwords, recovery keys and encryption keys. All encryption happens on your device.
- **No telemetry:** no usage stats, crash reports or tracking of any kind.
- **Account:** none for Free. Pro needs a purchase (you get the key by email). No Vault Locker account exists.
- **Files:** reads and writes only inside your vault. Each protected folder gets a hidden `.vaultlocker` file. A copy of each folder's key header (keys still encrypted) is kept in the plugin's own settings file.
- **Open source:** all of the code is in this repository, including the license check. See License below.

## Getting started
Everything works on a folder, so **pick the folder first**:
- **Right-click the folder** in the file list, then choose **Vault Locker: protect this folder**, **lock**, **unlock** or **change password**.
- Or click the **lock icon** in the left ribbon, or run a Vault Locker command (Command-P / Ctrl-P), and **click the folder** in the list that opens.

The first time you protect a folder, Vault Locker shows a **recovery key**. Save it somewhere safe, such as a password manager. It's the only way back in if you forget the password.

## How it works
- Each protected folder has its own random 256-bit key. Every file in it is encrypted separately with AES-256-GCM.
- Your password unlocks the folder key through PBKDF2-SHA-256 (600,000 rounds). A recovery key, shown once at setup, can unlock it too.
- Locking writes `name.md.vlock` (or a random name, with hidden names on), checks that it decrypts, and only then removes the original.
- Uses the Web Crypto API only, so it works on desktop, iPhone, iPad and Android.

## Limits (read before trusting it with real files)
- **While a folder is unlocked, its files are plain on disk**, because Obsidian's editor reads files from disk. Lock when you're done. Pro can auto-lock on idle and on quit.
- **Copies made before you locked are not erased.** Locking deletes the plain file, but it can't reach copies kept elsewhere: Obsidian Sync version history, iCloud or Dropbox file history, Time Machine and other backups, or deleted-file recovery on the disk itself. For files that were sensitive before you protected them, clear those histories too.
- If Obsidian closes while a folder is unlocked (crash, force quit), the folder stays unlocked. Vault Locker warns at the next start.
- **Lose both the password and the recovery key and the files are gone.** There is no back door.
- Notes at the very top of the vault (outside any folder) can't be protected. Put them in a folder.
- **File names stay visible in Free** (`Note.md` becomes `Note.md.vlock`), and so do folder names. The contents are encrypted. Pro can give locked files random names.
- **Obsidian hides file types it can't open** (for example `.m4v` or `.zip`), but they still get locked. Turn on Settings › Files and links › Detect all file extensions to see them.
- Sync tools see the `.vlock` files change, which is expected.
- **Warning: don't rename or move files in a protected folder while it is syncing.** A rename that hasn't reached every device yet, followed by a lock, can leave a duplicate copy. Rename only while the folder is unlocked and sync is finished, then wait a minute before locking.
- **Let sync finish before you lock or unlock.** iCloud, Obsidian Sync and Dropbox can take a minute or more, and big files (music, video) arrive last. Locking while files are still arriving, or right after renaming or moving them on another device, can leave a duplicate copy. If a file you expect is missing, wait for sync and reopen Obsidian before locking. Between devices, give it a minute after locking on one before unlocking on the other.
- **Obsidian Sync:** turn on "Sync all other types", or `.vlock` files stay on the device that locked them. Obsidian Sync also skips dot-files, so the folder's `.vaultlocker` key file does not travel; Vault Locker keeps a copy (keys still encrypted) in its own plugin settings and puts it back on the other device. That copy travels only if "Installed community plugins" sync is on. iCloud, Dropbox and Syncthing copy everything, so they need no setting.
- **Very large files:** files are encrypted in 1 MB pieces, but each file is still read into memory whole, so locking or unlocking needs about 2 times the file's size in free memory. Limits: 1 GB per file on a computer, 200 MB per file on a phone or tablet. When a bigger file lands in a protected folder, Vault Locker warns right away and offers to move it to a "Too big to lock" folder. If one is still there at lock time, Vault Locker locks everything else, leaves that file as it is, and names it in a warning that stays up long enough to read. Move the big file out of the folder, or lock it on a computer. Files locked by earlier versions still open.
- A note created inside a locked folder is kept on unlock. If it has the same name as a locked note, the locked one comes back as "Name (locked copy).md".

## License
Copyright (C) 2026 Senior Enterprises LLC. Released under the GNU General Public License v3.0 or later (see `LICENSE`).

The license covers the code. The "Vault Locker" name and Pro license keys are not part of it: please don't publish a copy under the same name, and don't share or resell keys. Buying Pro is how this plugin gets paid for and kept up.

## Development
No npm packages needed (Node 22.18+ runs the TypeScript directly).
- `npm test`: unit tests plus an end-to-end test of the built plugin.
- `npm run build`: writes `main.js` and copies it into `test-vault/` (a throwaway vault for hand testing, created if missing).
