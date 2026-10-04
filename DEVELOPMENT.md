# Development

## Requirements

- Node.js 20 or newer
- npm
- VS Code / Antigravity compatible with VS Code 1.90+

## Install

```bash
npm install
```

## Compile

```bash
npm run compile
```

The TypeScript entry point is `src/extension.ts`. Compilation writes `out/extension.js`, which is the entry point declared by `package.json`.

## Package a VSIX

```bash
npm run package
```

or:

```bash
npx @vscode/vsce package
```

## Run in Extension Development Host

Open the repository in VS Code and press `F5`. If VS Code asks for a launch configuration, choose `Run Extension`.

## Security notes

Telegram terminal execution is disabled by default. Keep command allowlists narrow and never place bot tokens, chat IDs, or credentials in source control.
