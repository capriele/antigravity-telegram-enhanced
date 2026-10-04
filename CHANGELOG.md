# Changelog

All notable changes to Antigravity Telegram Enhanced are documented here.

## 1.4.0

- Prepared the project as an independent Marketplace extension under publisher `capriele`.
- Changed the Marketplace extension ID to `capriele.antigravity-telegram-enhanced`.
- Updated repository, homepage, issues, Marketplace description, keywords, and attribution.
- Added Marketplace-focused documentation and security guidance.
- Fixed VSIX/package version metadata so all manifests consistently report 1.4.0.

## 1.3.0

- Added a persistent Telegram conversation target.
- Added `/select`, `/current`, and `/unselect`.
- Normal Telegram messages can be injected directly into the selected Antigravity conversation through `SendUserCascadeMessage`.
- Distinguished the Telegram target (`🎯`) from the conversation active in the IDE (`🟢`).
- Updated `/stop` and status handling to respect the selected Telegram target.

## 1.2.1

- Fixed recent-conversation discovery across multiple Antigravity language-server processes/windows.
- Merged and deduplicated `GetAllCascadeTrajectories` results from reachable servers.
- Added diagnostics-based recent-conversation fallback.
- Routed conversation selection to the language server that owns the target conversation.

## 1.2.0

- Added optional allowlisted `/run <command>` terminal execution.
- Added non-interactive, allowlisted `sudo -n` support without password handling.
- Added command timeout and output limits.

## 1.1.1

- Fixed the `/reload` replay/restart loop by persisting the Telegram update offset before command execution.
- Fixed conversation parsing for `trajectorySummaries` returned as an object keyed by conversation ID.
- Improved recent-conversation sorting and selection fallbacks.

## 1.1.0

- Added English as the default language and Italian localization.
- Added Telegram language switching and additional utility commands.
- Reworked Telegram integration for cross-platform portability.
