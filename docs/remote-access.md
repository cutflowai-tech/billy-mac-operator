# Billy — Remote Access (Telegram)

## Design
- **Outbound only:** Billy long-polls the Telegram Bot API. No port on your Mac is opened.
- **Identity:** a device is your immutable numeric Telegram user ID, paired once with a code shown on the Mac. Display names, forwarded messages, groups and bots are never accepted as you.
- **Command handling:** every message is admitted through Billy's inbox with its Telegram message identity. A message redelivered after a reconnect never creates a second task.
- **Privacy:** messages transit Telegram's servers. Do not send secrets, and Billy never sends secrets back (all replies are redacted).

## Setup (setup packet S4)
1. In Telegram, message **@BotFather** → `/newbot`, and copy the token.
2. On the Mac, in your own Terminal: `security add-generic-password -U -s com.billy.remote.telegram -a bot -w` (paste the token at the hidden prompt).
3. Billy → Settings → Remote → enable Telegram. This restarts the remote channel.
4. Billy → Settings → Remote → **Pair a phone**, which shows an 8-digit code valid for 10 minutes.
5. From your phone, send `/pair <code>` to your bot. Only the first valid use of a code pairs a device. Replays, expired codes and non-private chats are rejected.

## Commands from the phone
| Message | Effect |
|---|---|
| any text | new goal, through the same admission and policy as the app |
| `/status` | current state of recent tasks |
| `/stop`, `توقف` | emergency stop; acknowledged only after the Mac commits the stop latch |
| `/resume` | clear the stop and resume paused tasks |

## Offline and reconnect behavior
- A message sent while the Mac is offline or asleep is delivered when Billy polls again. **A stop takes effect only when it reaches the Mac.** The bot replies "Stopped on the Mac" only after that has actually happened.
- If the phone resends the same message, it is recognized as a duplicate.
- Progress and completion notifications are queued durably and retried. A notification that cannot be confirmed is never resent blindly.

## Revocation
Revoke a device in Billy → Settings → Remote, or with `POST /v1/remote/devices/<telegram-user-id>/revoke` (local API). Messages from a revoked device are refused before admission, including `/stop`. You can still see the revocation in the app. To pair again, create a new code.
