# Billy — Consolidated Setup Packet (issued 2026-10-11; preview instructions updated 2026-10-12)

Only genuinely human-only items are listed. All other engineering continues while these are pending.
**Never paste a secret into the chat.** Secrets go into the macOS Keychain from your own Terminal.

The [0.1.1 development preview](https://github.com/cutflowai-tech/billy-mac-operator/releases/tag/v0.1.1) is published as a prerelease; it has not passed the frozen release gate. For a new installation, complete S8 first so the app connects to its background service, then configure provider, budget and grant. Prior host observations below apply to the original test Mac, not to another user's installation.

## Required for release gates

### S1 — AI provider credential for Billy  ·  blocks REQ-16, REQ-17 · T-AI-01, T-AI-06, T-AI-07 (PROVIDER_LIVE)
Billy has no provider credential of its own. I will not borrow Claude Code's session login.
Store an Anthropic API key in **Settings → Provider**, or in your own Terminal run:
  `security add-generic-password -U -s com.billy.provider.anthropic -a default -w`
  It prompts for the key without echoing it.
Then press **Activate Anthropic and Check Models** in Settings → Provider. If the configured model is unavailable or unpriced, enter a validated available model ID and activate again. Storing the key alone does not activate the provider.
Option (b), using the local Claude Code CLI under your subscription, was considered but is **not implemented**, so only (a) is available.

### S2 — Spending ceiling  ·  blocks every billed call (REQ-18, T-BOOT-05)
Set your own ceiling in **Settings → Budget**, choosing Total or Daily. No billed call is admitted without an explicit applicable ceiling and provider egress grant. The UI's default number is a proposal, not spending authorization. Qualification needs roughly 300–600 model calls.

In **Settings → Permissions**, review and save the folders, apps, effects and expiry. Finder and Open/Save panel input additionally need the explicit **Allow file-panel input** option. It permits granted apps to use their own file dialogs, which can access files outside the listed folders; review the warning before enabling it.

### S3 — macOS permissions for the control driver  ·  satisfied on the original test Mac (verified live 2026-10-11)
CuaDriver's own daemon reports Accessibility and Screen Recording as granted (`check_permissions`, attribution `driver-daemon`).
For a new installation, install the pinned **CuaDriver.app 0.26.1** separately in `/Applications`; Billy does not bundle it. Grant permissions for your account. On the original test Mac, nothing is needed unless macOS revokes them. Instructions:
1. Run `cua-driver permissions grant` in your Terminal.
2. Approve **Accessibility** and **Screen Recording** for *CuaDriver* in the system dialogs.

I cannot click OS permission dialogs for you.

### S3b — Cua telemetry (privacy decision)  ·  REQ-15
CuaDriver sends usage telemetry to PostHog EU by default; it already sent an install event in September.
Billy disables it for the daemons it starts. To also disable it globally, run `cua-driver telemetry disable`.
This is your choice, not a blocker.

### S4 — Phone path (Telegram)  ·  blocks 5 REMOTE_LIVE scenarios (REQ-23, REQ-24)
1. In Telegram, message **@BotFather** → `/newbot` → get the bot token.
2. Store the token in your own Terminal: `security add-generic-password -U -s com.billy.remote.telegram -a bot -w`
3. In Settings → Remote, enable Telegram, press **Pair a phone**, and send `/pair <code>` to the bot from your phone before the displayed code expires.
4. For the live test, the phone must be on **cellular** (a network separate from the Mac).

Messages transit Telegram's servers. Say if that is unacceptable; the alternative is Tailscale, which needs a system install on both devices.

### S5 — Microphone / Speech recognition  ·  blocks T-UX-06 (REQ-25)
Approve the macOS prompt the first time you press Billy's push-to-talk button.

### S7 — Browser for the form scenario  ·  blocks T-MAC-04
CuaDriver only launches its isolated, driver-owned browser profile from a **root-owned, vendor-signed** Chrome.
This is a deliberate driver security rule. Your `/Applications/Google Chrome.app` is owned by `ahri:admin`, so the driver refuses it ("no vendor-signed system Chromium executable is available for isolated launch").

Choose one:
- **(a)** Reinstall Chrome with Google's official `.pkg` installer. It installs root-owned.
- **(b)** In your own Terminal: `sudo chown -R root:wheel "/Applications/Google Chrome.app"`.

Billy never attaches to your logged-in Chrome profile for tests.

### S6 — Idle time and short supervised sessions  ·  native live scenarios
**Native suite (about 20 minutes):** Billy refuses to touch the desktop while you are using the Mac (REQ-12).
Your Mac currently reports continuous input, so the native live runs (Calculator, TextEdit, Finder, Chrome form, save dialog) need about 20 minutes with no keyboard or mouse use.
- Leave the Mac unlocked and idle, then tell me "go native". Or just step away; I re-check idle state before each run.
- These runs use only harmless fixture apps and files under a test folder.

**Supervised session (5–10 minutes with you):** needed for T-MAC-09, T-MAC-10, T-MAC-11 and T-REMOTE-06:
- Lock/unlock the screen.
- Revoke and re-grant one permission.
- Take over the mouse during a GUI task.
- Toggle your phone's airplane mode.

### S8 — Install Billy for your account  ·  blocks T-DUR-06, T-UX-01
These two scenarios test the installed product. Billy's tests never install software or register a background service in your account on their own.
1. Download **Billy-0.1.1.dmg** from the [published development preview](https://github.com/cutflowai-tech/billy-mac-operator/releases/tag/v0.1.1), drag Billy to `~/Applications`, and open it. Verify the artifact hash against the release's `SHA256SUMS`; the build is ad-hoc signed, not notarized.
2. Press **Start Background Service** in the main window's service notice or **Settings → Diagnostics**, and approve it in System Settings ▸ General ▸ Login Items if macOS asks. Wait for connection before configuring provider, budget and grant.
3. Tell me "installed". Uninstall later with Control ▸ Stop Background Service…, then delete the app.

Note on keyboard layout: your active input source is Arabic PC. Billy never changes it, and its native actions avoid keyboard shortcuts for that reason (synthetic chords follow your layout). You don't need to do anything.

## Non-blocking, later
- **N1:** The workspace volume `/Volumes/Zeno` is 95% full (~51 GB free). This is fine for the build. Runtime data lives on the internal disk.
- **N2:** No Apple Developer ID exists. The deliverable is an ad-hoc-signed personal-use build, not notarized for distribution. macOS may require Gatekeeper approval on first launch. Grants are tied to the build signature, so rebuilds may need re-granting.
- **N3:** Source and development preview artifacts are now published at [cutflowai-tech/billy-mac-operator](https://github.com/cutflowai-tech/billy-mac-operator). Publishing a prerelease does not certify live qualification.

## What does not need you
Architecture, code, tests, packaging, fault/security suites, docs — all proceeding now.
