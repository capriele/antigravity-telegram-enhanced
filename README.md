# Antigravity Telegram Enhanced

Control Antigravity from Telegram, including the ability to select a specific Antigravity conversation and send Telegram messages directly into that conversation as user prompts.

> **Independent community fork.** This extension is based on [`hieuvt1414/antigravity-telegram`](https://github.com/hieuvt1414/antigravity-telegram) and is not affiliated with or endorsed by the original author, Google, VS Code, or the Antigravity project. The upstream MIT license and attribution are preserved.

## Highlights

- English by default, with full Italian support.
- Telegram bot control for Antigravity.
- Select a target conversation from Telegram with `/select` or `/list`.
- Send normal Telegram messages directly into the selected conversation as real user prompts.
- Multi-language-server conversation discovery and deduplication.
- Conversation target persists across reloads.
- Workspace/status/identity commands.
- Optional allowlisted terminal commands with `/run`.
- Portable VSIX for macOS, Linux, and Windows.
- Dependency-free Telegram Bot API client.

## Requirements

- VS Code-compatible Antigravity installation.
- A Telegram bot token from `@BotFather`.
- A Telegram Chat ID or allowed Telegram username.

Antigravity internal commands and Language Server RPCs are not a stable public API, so compatibility may vary between Antigravity releases.

## Setup

1. Install the extension from the VS Code Marketplace or from a VSIX.
2. Open **Settings** and search for **Antigravity Telegram Enhanced**.
3. Set `antigravityWithTelegram.telegramToken`.
4. Set either `antigravityWithTelegram.telegramChatId` or `antigravityWithTelegram.telegramAllowedUsername`.
5. Run **Antigravity Telegram Enhanced: Start Telegram Bot** from the Command Palette.

If you do not know your Telegram Chat ID, send `/whoami` to the bot. That command only returns the sender's own Telegram identity and does not authorize IDE access.

## Conversation targeting

Use:

- `/select` or `/list` — show recent conversations and choose the Telegram target.
- `/current` — show the currently selected Telegram target.
- `/unselect` — clear the fixed target and fall back to the conversation active in the IDE.
- `/stop` — stop the selected target conversation when possible.

In the Telegram conversation picker:

- `🎯` = conversation selected as the Telegram target.
- `🟢` = conversation currently active in the IDE.

Once a conversation is selected, a normal Telegram message such as:

```text
check why the OAuth login returns 401 and fix it
```

is injected into that exact Antigravity conversation as a user turn, even if another conversation is visible in the IDE.

## Telegram commands

`/start`, `/help`, `/status`, `/ping`, `/new`, `/list`, `/select`, `/current`, `/unselect`, `/workspace`, `/plan`, `/task`, `/walkthrough`, `/run <command>`, `/stop`, `/reload`, `/language en|it`, `/whoami`, `/version`.

## English / Italian

English is the default extension and Telegram language. Each Telegram chat can override it with:

```text
/language en
/language it
```

Italian VS Code labels are also provided through VS Code localization files.

## Remote terminal commands

`/run <command>` is **disabled by default** and must be explicitly enabled with:

```text
antigravityWithTelegram.terminalCommandsEnabled
```

Only commands matching `terminalAllowedCommands` are accepted. Commands are spawned with `shell: false`, so shell operators such as `;`, `|`, redirects, and command substitution are not interpreted. General-purpose shells and interpreters are blocked from remote execution.

### Privileged commands

The extension does **not** accept, transmit, store, or prompt for sudo passwords over Telegram.

`/run sudo <command>` always uses non-interactive `sudo -n`. The command must also match `terminalAllowedSudoCommands` and be pre-authorized by a narrowly scoped `sudoers` `NOPASSWD` rule.

Do not configure unrestricted `NOPASSWD: ALL` for this extension.

## Security notes

A Telegram bot that can control an IDE is a remote-control surface. Recommended configuration:

- restrict access to a specific Chat ID;
- keep the bot token secret;
- keep remote terminal execution disabled unless needed;
- use narrow command allowlists;
- use narrowly scoped `sudoers` rules only when required;
- revoke/regenerate the bot token immediately if it is exposed.

## Portability

The extension uses Node.js APIs available in the VS Code extension host and does not bundle native binaries. The same VSIX is intended for macOS, Linux, and Windows.

## Source and issues

Source: <https://github.com/capriele/antigravity-telegram-enhanced>

Issues: <https://github.com/capriele/antigravity-telegram-enhanced/issues>

## License and attribution

MIT License. Copyright for the upstream project remains with TrungHieu1414 and contributors. See `LICENSE` for the complete license text.
