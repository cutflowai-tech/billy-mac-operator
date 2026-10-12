# Billy — Operator Runbook

Every command below is executed by `core/test/package/package.test.ts` against the installed artifact (T-REL-10).
`billyctl` lives inside the app bundle:

```bash
alias billyctl="$HOME/Applications/Billy.app/Contents/Resources/billyd/billyctl"
```

## 1. Install (personal use)
1. Open `Billy-<version>.dmg` or unzip `Billy-<version>.zip`, and drag **Billy.app** to `~/Applications`.
2. Check the published hash: `shasum -a 256 Billy-<version>.zip` must match `SHA256SUMS`.
3. The build is **ad-hoc signed**, not notarized: there is no Developer ID. On first launch macOS may block it. Allow it in **System Settings → Privacy & Security → Open Anyway**. This is expected for a personal-use build.

CuaDriver.app 0.26.1 must already be installed in `/Applications`. Billy checks its binary hash and Developer ID team and refuses any other version. This is a separate prerequisite; Billy does not install the driver.

The current [development preview 0.1.1](https://github.com/cutflowai-tech/billy-mac-operator/releases/tag/v0.1.1) is a prerelease. Native/provider/remote qualification and the release gate remain incomplete.

## 2. First launch and onboarding
Start the core first: use **Start Background Service** in the main window's service notice or **Settings → Diagnostics**. Approve it in System Settings → General → Login Items if required. Wait for the app to connect. Provider, budget and grant settings need that connection; onboarding appears once the connected doctor reports `policy.default_grant: fail`.

| Step | What you do | Doctor check |
|---|---|---|
| Provider (S1) | Save your key in Settings → Provider, or use `security add-generic-password -U -s com.billy.provider.anthropic -a default -w`. Press **Activate Anthropic and Check Models**. If validation fails, select an available, priced model using the model field and activate again. | `provider.credential`, `provider.models` |
| Budget (S2) | Settings → Budget, e.g. $40 total | `budget.provider` |
| Permissions (grant) | Review the proposed folders, apps and effects, then Save. For Finder/file-dialog control, explicitly enable **Allow file-panel input** after reviewing its broader app-level access warning. | `policy.default_grant` |
| Desktop control (S3) | `cua-driver permissions grant`; approve Accessibility and Screen Recording | `desktop.permissions`, `desktop.driver` |
| Phone (S4) | see `docs/remote-access.md` | `remote.telegram` |
| Background service | Settings → Diagnostics → **Start Background Service** (start before the settings above) | — |

## 3. Daily use
- **Give a goal:** type it in the window, press the mic for push-to-talk, message the Telegram bot, or run `billyctl task-add "…"`. All four use the same admission path, so a duplicate submission never creates a second task.
- **See progress:** the task list and detail view, or `billyctl tasks` / `billyctl status`.
- **Close the window:** Billy keeps working (menu bar).
- **Quit the app:** the background service keeps working.
- **Stop Billy (emergency):** the menu bar or window **Stop Billy** button (⌘⇧.), `billyctl stop`, or `/stop` on the phone. The stop is persistent: it survives restart and reboot until you resume (`billyctl resume`, or Resume in the app). A stop is not a rollback: actions already completed stay completed, and in-flight ones are checked and reported.
- **Stop background service:** Settings → Diagnostics, or the menu bar → Stop Background Service… No work runs until you start it again.
- **Log out or shut down:** nothing runs. After you log back in, Billy recovers interrupted work, checking uncertain effects before retrying anything.
- **Screen locked:** desktop (GUI) work waits, and background file work continues.
- **When you take the mouse or keyboard:** Billy yields at once and re-observes the screen before continuing.

## 4. Diagnostics
```bash
billyctl doctor
billyctl diagnostics-export ~/Desktop/billy-diagnostics.json
```
`doctor` is read-only. It exits 1 when any check fails and names the exact fix. The export is privacy-filtered: no goals, file contents, tokens or keys.

| Check | Meaning | Fix |
|---|---|---|
| `store.integrity` fail | database corrupt; dispatch stopped | §6 |
| `control.stop` warn | emergency stop active | `billyctl resume` when ready |
| `effects.uncertain` warn | an external effect could not be confirmed | open the task; Billy re-checks the destination before retrying |
| `cua.binary` fail | driver is not the pinned build | reinstall CuaDriver 0.26.1 |
| `desktop.permissions` fail/unknown | TCC not granted for CuaDriver | `cua-driver permissions grant`. A rebuilt or moved app may need re-granting. |

## 5. Backup and restore
```bash
billyctl backup-create before-upgrade
billyctl backup-list
billyctl backup-verify <id>
```
Backups are AES-256-GCM encrypted, with the key in the Keychain item `com.billy.backup-key`. They are stored in `~/Library/Application Support/Billy/backups`.

Restore always goes into a **new** directory, and the service must be stopped:
```bash
billyctl restore <id> --to "$HOME/Billy-restored"
```
To use the restored copy, keep the service stopped. Move the current data directory aside (do not delete it), move the restored directory into place, then start the service. Startup recovery reconciles any effect that happened after the backup instead of replaying it.

## 6. Database corruption
Billy never starts empty after corruption:
1. It moves the damaged files into `…/Billy/quarantine/<timestamp>/` with their hashes recorded.
2. It writes `RECOVERY_REQUIRED.json`.
3. It refuses to open until you restore from a verified backup (§5).

## 7. Uninstall
```bash
billyctl uninstall-plan        # shows exactly what is removed and kept; changes nothing
```
1. Billy → Settings → Diagnostics → **Stop Background Service…** (or from the menu bar).
2. Drag Billy.app to the Trash.
3. Optional: `billyctl data-trash --confirm` moves your Billy data to the Trash. It refuses while the service runs, and it is reversible.
4. Optional: delete the `com.billy.*` items in Keychain Access.

Your files in granted folders and CuaDriver.app are never touched.
