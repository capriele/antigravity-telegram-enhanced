// @ts-nocheck
const vscode = require('vscode');
const STRINGS = {
  en: {
    starting: 'Starting Telegram bot…', started: 'Telegram bot started.', stopped: 'Telegram bot stopped.', already: 'Telegram bot is already running.', notRunning: 'Telegram bot is not running.',
    missingToken: 'Configure antigravityWithTelegram.telegramToken first.', statusOn: 'TG Bot: On', statusOff: 'TG Bot: Off', tooltipOn: 'Telegram bot running — click to stop', tooltipOff: 'Telegram bot stopped — click to start',
    testSent: 'Test message sent to Telegram.', testFailed: 'Could not send test message.', settingsOpened: 'Settings opened.',
  },
  it: {
    starting: 'Avvio del bot Telegram…', started: 'Bot Telegram avviato.', stopped: 'Bot Telegram arrestato.', already: 'Il bot Telegram è già in esecuzione.', notRunning: 'Il bot Telegram non è in esecuzione.',
    missingToken: 'Configura prima antigravityWithTelegram.telegramToken.', statusOn: 'Bot TG: Attivo', statusOff: 'Bot TG: Fermo', tooltipOn: 'Bot Telegram in esecuzione — fai clic per arrestarlo', tooltipOff: 'Bot Telegram fermo — fai clic per avviarlo',
    testSent: 'Messaggio di test inviato su Telegram.', testFailed: 'Impossibile inviare il messaggio di test.', settingsOpened: 'Impostazioni aperte.',
  }
};
function language() {
  const raw = vscode.workspace.getConfiguration('antigravityWithTelegram').get('language', 'en');
  return raw === 'it' ? 'it' : 'en';
}
function t(key) { return STRINGS[language()][key] || STRINGS.en[key] || key; }
module.exports = { STRINGS, language, t };
