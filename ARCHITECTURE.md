# Architecture

The extension runtime is split into small CommonJS-compatible TypeScript modules so the compiled output remains simple and dependency-free at runtime.

- `src/extension.ts` — VS Code activation lifecycle, commands and status bar.
- `src/telegram/bot.ts` — Telegram Bot API polling, authorization, commands, callbacks and prompt routing.
- `src/antigravity/index.ts` — Antigravity diagnostics, language-server discovery/RPC, conversation listing/selection and response tracking helpers.
- `src/terminal/index.ts` — safe command-line parsing, allow-list matching and non-shell process execution.
- `src/i18n/index.ts` — extension UI language strings and language selection.
- `src/core/logger.ts` — output-channel logging.
- `src/core/utils.ts` — shared formatting, brain-file lookup and timing helpers.

The refactor intentionally preserves the behavior of the working 1.4.0 runtime while making future changes easier to review and test.
