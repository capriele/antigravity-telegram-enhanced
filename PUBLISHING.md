# Publishing Antigravity Telegram Enhanced

Marketplace identity: `capriele.antigravity-telegram-enhanced`

## First release: manual upload

1. Create or select publisher `capriele` in Visual Studio Marketplace.
2. Open the publisher management page.
3. Choose **New extension > Visual Studio Code**.
4. Upload `antigravity-telegram-enhanced-1.4.0.vsix`.
5. Review the Marketplace preview and publish.

## Future releases

Increment `version` in `package.json`, update `CHANGELOG.md`, then package with the current `@vscode/vsce`:

```bash
npm install -g @vscode/vsce
vsce package
```

For automated publishing, prefer Microsoft Entra ID / `vsce publish --azure-credential`. Global Azure DevOps PATs are scheduled for retirement on December 1, 2026.
