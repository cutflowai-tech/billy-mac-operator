# Billy — Consolidated Setup Packet (issued once, 2026-10-11)

Only genuinely human-only items are listed. All other engineering continues while these are pending.
**Never paste a secret into the chat.** Secrets go into the macOS Keychain from your own Terminal.

## Required for release gates

### S1 — AI provider credential for Billy  ·  blocks REQ-16, REQ-17 · T-AI-01, T-AI-06, T-AI-07 (PROVIDER_LIVE)
Billy has no provider credential of its own. I will not borrow Claude Code's session login.
Store an Anthropic API key. In your own Terminal run:
  `security add-generic-password -U -s com.billy.provider.anthropic -a default -w`
  It prompts for the key without echoing it.
Option (b), using the local Claude Code CLI under your subscription, was considered but is **not implemented**, so only (a) is available.

### S2 — Spending ceiling  ·  blocks every billed call (REQ-18, T-BOOT-05)
Reply with a number, e.g. "Billy budget: $40 total, $10/day".
Until you do, Billy dispatches **zero** billed calls. Qualification needs roughly 300–600 model calls.

### S3 — macOS permissions for the control driver  ·  ✅ ALREADY SATISFIED (verified live 2026-10-11)
CuaDriver's own daemon reports Accessibility and Screen Recording as granted (`check_permissions`, attribution `driver-daemon`).
Nothing to do unless macOS revokes them. Original instructions, kept for reference:
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
3. Send any message to your new bot from your phone. Billy then pairs it with a one-time code shown in the Mac app.
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
1. Open `artifacts/release/0.1.0/Billy-0.1.0.dmg`, drag Billy to Applications, and open it.
2. In onboarding, press **Start background service** and approve it in System Settings ▸ Login Items if macOS asks.
3. Tell me "installed". Uninstall later with Control ▸ Stop Background Service…, then delete the app.

Note on keyboard layout: your active input source is Arabic PC. Billy never changes it, and its native actions avoid keyboard shortcuts for that reason (synthetic chords follow your layout). You don't need to do anything.

## Non-blocking, later
- **N1:** The workspace volume `/Volumes/Zeno` is 95% full (~51 GB free). This is fine for the build. Runtime data lives on the internal disk.
- **N2:** No Apple Developer ID exists. The deliverable is an ad-hoc-signed personal-use build, not notarized for distribution. macOS may require Gatekeeper approval on first launch. Grants are tied to the build signature, so rebuilds may need re-granting.
- **N3:** The GitHub connector failed to authenticate. Only local git is used; nothing is published.

## What does not need you
Architecture, code, tests, packaging, fault/security suites, docs — all proceeding now.
