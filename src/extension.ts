// @ts-nocheck
'use strict';
const vscode = require('vscode');
const { TelegramBotClient } = require('./telegram/bot');
const { t } = require('./i18n');
const { setOutputChannel, log } = require('./core/logger');
const { getActiveCascadeId } = require('./antigravity');

const VERSION = '1.4.1';
let bot = null;
let statusBar = null;

async function startBot(context) {
  if (bot) return vscode.window.showInformationMessage(t('already'));
  const c = vscode.workspace.getConfiguration('antigravityWithTelegram');
  const token = String(process.env.TELEGRAM_TOKEN || c.get('telegramToken','')).trim();
  if (!token) return vscode.window.showErrorMessage(t('missingToken'));
  const chatId = String(c.get('telegramChatId','')).trim();
  const username = String(c.get('telegramAllowedUsername','')).trim();
  bot = new TelegramBotClient(token, chatId || '', username, context);
  try {
    await bot.start(); updateStatus(true); vscode.window.showInformationMessage(t('started')); log('Telegram bot started');
  } catch (e) { bot = null; updateStatus(false); vscode.window.showErrorMessage(`Telegram: ${e.message}`); }
}
async function stopBot() {
  if (!bot) return vscode.window.showInformationMessage(t('notRunning'));
  bot.stop(); bot = null; updateStatus(false); vscode.window.showInformationMessage(t('stopped')); log('Telegram bot stopped');
}
function updateStatus(on) {
  if (!statusBar) return;
  statusBar.text = `$(comment-discussion) ${on ? t('statusOn') : t('statusOff')}`;
  statusBar.tooltip = on ? t('tooltipOn') : t('tooltipOff');
  statusBar.command = on ? 'antigravity-with-telegram.stop' : 'antigravity-with-telegram.start';
  statusBar.show();
}
async function activate(context) {
  const output = vscode.window.createOutputChannel('Antigravity Telegram');
  setOutputChannel(output);
  context.subscriptions.push(output);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-with-telegram.start', () => startBot(context)),
    vscode.commands.registerCommand('antigravity-with-telegram.stop', () => stopBot()),
    vscode.commands.registerCommand('antigravity-with-telegram.status', async () => {
      const active = await getActiveCascadeId();
      vscode.window.showInformationMessage(`Telegram: ${bot ? 'ON' : 'OFF'} · Antigravity: ${active ? `conversation ${active.slice(0,8)}` : 'not detected'}`);
    }),
    vscode.commands.registerCommand('antigravity-with-telegram.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:capriele.antigravity-telegram-enhanced')),
    vscode.commands.registerCommand('antigravity-with-telegram.testMessage', async () => {
      const id = bot?.allowedChatId;
      if (!bot || !id) return vscode.window.showWarningMessage(t('testFailed'));
      try { await bot.send(id, `🧪 Antigravity With Telegram Enhanced v${VERSION}`); vscode.window.showInformationMessage(t('testSent')); }
      catch { vscode.window.showErrorMessage(t('testFailed')); }
    })
  );
  updateStatus(false);
  if (vscode.workspace.getConfiguration('antigravityWithTelegram').get('autoStart', false)) setTimeout(() => startBot(context), 1500);
}
function deactivate(){ try { bot?.stop(); } catch {} }
module.exports = { activate, deactivate };
