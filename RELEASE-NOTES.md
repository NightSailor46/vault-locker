# Vault Locker release notes

## 1.0.1
- Password prompt redesigned: the password boxes are the same width, stacked on the left; one tall OK button runs down the right side, clear of a phone keyboard.
- An eye button beside each box shows or hides what you typed (both boxes at once), so you can catch a typo.
- When setting a new password, the prompt says plainly to type it twice.

## 1.0.0 (first release)
Password-protect folders in your Obsidian vault. Notes and attachments are encrypted on disk with AES-256 and can't be read without the password or the recovery key.

**Before you start: pick the folder first.** Every action works on a folder.
- Right-click the folder in the file list and choose **Vault Locker: protect this folder**, **lock**, **unlock** or **change password**.
- Or use the lock icon in the left ribbon or a Vault Locker command, then click the folder in the list.
- **On a phone or tablet,** there is no right-click: **press and hold the folder name** until the menu with lock, unlock and change password appears. On iPhone this can take several seconds, so keep holding and keep your finger still; if it slides, iOS treats it as a drag or rename and you start over. The quicker way is the lock icon in Obsidian's left side menu: one tap opens the folder list.

**What's in it**
- Protect a folder: every file inside, including PDFs, images, music and video, is encrypted on disk when locked.
- Lock and unlock with a password, or with the recovery key shown once at setup. Save that key; there is no back door.
- Change a folder's password without re-encrypting its files.
- Notes you had open when you locked come back when you unlock.
- A warning when a file over the size limit lands in a protected folder (1 GB on a computer, 200 MB on a phone or tablet), with a button to move it out. Everything else in the folder still locks.
- A reminder at startup if a protected folder was left unlocked.
- Works on Mac, Windows, Linux, iPhone, iPad and Android.

**Free and Pro**
Free protects one folder, with the same full-strength encryption. Pro ($5, lifetime) adds unlimited folders, the whole vault, auto-lock on idle and on quit, hidden file names and a password per folder. Pro goes on sale soon.

**Good to know**
- While a folder is unlocked, its files are normal files on disk. Lock it when you're done.
- In Free, file and folder names stay visible; the contents are encrypted.
- Copies made before you locked (Obsidian Sync history, iCloud, Time Machine and other backups) are not erased.
- **Warning: don't rename or move files in a protected folder while it is syncing.** A rename that hasn't reached every device yet, followed by a lock, can leave a duplicate copy. Rename only while the folder is unlocked and sync is finished, then wait a minute before locking.
- **Let sync finish before you lock or unlock.** iCloud, Obsidian Sync and Dropbox can take a minute or more, and big files (music, video) arrive last. Locking while files are still arriving, or right after renaming or moving them on another device, can leave a duplicate copy. If a file you expect is missing, wait for sync and reopen Obsidian before locking. Between devices, give it a minute after locking on one before unlocking on the other.

**Syncing between devices**
Vault Locker works with any sync method. Locked files are ordinary files, so they travel like any other. Pick one method per vault:
- **iCloud (iPhone, iPad and Mac):** nothing to set up, and you don't touch anything in Obsidian; it syncs in the background. Ignore Obsidian's "Sync" screen, which is only for Obsidian's paid service. Big files can take a few minutes. To check that a file has arrived on a phone, open the Files app › iCloud Drive › Obsidian › your vault; a cloud icon means it hasn't downloaded yet (tap it). Best choice if all your devices are Apple.
- **Obsidian Sync (paid, any device):** in Obsidian's Sync settings, turn on **Sync all other types** (or locked files stay on the device that locked them) and **Installed community plugins**. Obsidian Sync skips the folder's hidden key file; Vault Locker keeps a copy (still encrypted) in its settings and puts it back on each device. Check your plan's file size limit, since bigger files won't sync. Best choice for a mix of Apple, Windows and Android.
- **Syncthing, Dropbox and others:** they copy every file, including the key file, so no settings are needed.
- **Locking and unlocking travel with sync.** Unlocking turns the locked files back into readable notes on disk, and your sync service copies them to every device. So a folder unlocked on your phone is readable on your computer too (and in the sync service) until it's locked again, and the same goes the other way. The password itself never travels. Lock when you're done, on whichever device you used.
- **Use one sync method per vault, never two at once** (for example, iCloud and Obsidian Sync on the same vault). Two services fighting over the same files is the most common cause of duplicate files.

