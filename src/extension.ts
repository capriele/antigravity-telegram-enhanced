// @ts-nocheck

'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const VERSION = '1.4.0';
let bot = null;
let statusBar = null;
let output = null;
let extContext = null;

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
function log(msg) { output?.appendLine(`[${new Date().toISOString()}] ${msg}`); }

class TelegramBotClient {
  constructor(token, allowedChatId, allowedUsername, ctx) {
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
    this.allowedChatId = allowedChatId;
    this.allowedUsername = allowedUsername ? allowedUsername.replace(/^@/, '') : '';
    this.ctx = ctx;
    this.running = false;
    this.offset = Number(this.ctx.globalState.get('telegramUpdateOffset', 0)) || 0;
    this.tracking = null;
    this.pollAbort = null;
  }

  async api(method, payload = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || `${method} failed`);
    return data.result;
  }
  async send(chatId, text, extra = {}) { return this.api('sendMessage', { chat_id: chatId, text, ...extra }); }
  async edit(chatId, messageId, text, extra = {}) {
    try { return await this.api('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }); }
    catch (e) { log(`editMessageText: ${e.message}`); }
  }
  async answerCallback(id, text) { try { await this.api('answerCallbackQuery', { callback_query_id: id, text }); } catch {} }

  locale(chatId) {
    const key = `chatLanguage:${chatId}`;
    return this.ctx.globalState.get(key, language()) === 'it' ? 'it' : 'en';
  }
  async setLocale(chatId, lang) {
    const v = lang === 'it' ? 'it' : 'en';
    await this.ctx.globalState.update(`chatLanguage:${chatId}`, v);
    return v;
  }
  m(chatId, en, it) { return this.locale(chatId) === 'it' ? it : en; }

  async start() {
    this.running = true;
    await this.registerCommands();
    this.loop();
  }
  stop() {
    this.running = false;
    try { this.pollAbort?.abort(); } catch {}
    this.pollAbort = null;
    this.tracking = null;
  }

  isAllowed(msg) {
    const chatId = msg.chat?.id;
    const username = msg.from?.username || msg.chat?.username || '';
    if (this.allowedChatId && String(chatId) === String(this.allowedChatId)) return true;
    if (this.allowedUsername && username.toLowerCase() === this.allowedUsername.toLowerCase()) return true;
    return false;
  }

  async registerCommands() {
    const commands = [
      ['start','Show help'], ['status','Bot and IDE status'], ['ping','Connectivity check'], ['new','Start a new AI conversation'],
      ['list','Recent conversations / select target'], ['select','Select Telegram conversation'], ['current','Show Telegram target'], ['unselect','Clear Telegram target'], ['workspace','Workspace information'], ['plan','Send latest implementation plan'], ['task','Send latest task file'],
      ['walkthrough','Send latest walkthrough'], ['stop','Stop the active AI task'], ['reload','Reload the IDE window'], ['language','Set language: en or it'],
      ['run','Run an allowed terminal command'], ['whoami','Show Telegram identity'], ['version','Extension version']
    ].map(([command, description]) => ({ command, description }));
    try { await this.api('setMyCommands', { commands }); } catch (e) { log(`setMyCommands failed: ${e.message}`); }
  }

  async loop() {
    while (this.running) {
      try {
        this.pollAbort = new AbortController();
        const res = await fetch(`${this.base}/getUpdates`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offset: this.offset, timeout: 25, allowed_updates: ['message','callback_query'] }),
          signal: this.pollAbort.signal
        });
        const data = await res.json();
        if (data.ok) {
          for (const update of data.result || []) {
            this.offset = Math.max(this.offset, update.update_id + 1);
            // Persist before handling the update. Commands such as /reload can terminate
            // the extension host immediately; persisting first prevents replay loops.
            await this.ctx.globalState.update('telegramUpdateOffset', this.offset);
            await this.handleUpdate(update);
          }
        }
      } catch (e) {
        if (this.running && e.name !== 'AbortError') { log(`Telegram polling error: ${e.message}`); await sleep(1500); }
      }
    }
  }

  async handleUpdate(update) {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const msg = update.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!this.isAllowed(msg)) {
      if (text.startsWith('/whoami')) {
        await this.send(chatId, `Chat ID: ${chatId}\nUsername: @${msg.from?.username || msg.chat?.username || '-'}`);
      }
      return;
    }
    if (msg.document || msg.photo) return this.handleFile(msg);
    if (!text) return;
    if (text.startsWith('/')) return this.handleCommand(msg, text);
    return this.forwardPrompt(chatId, text);
  }

  async handleCommand(msg, text) {
    const chatId = msg.chat.id;
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();
    if (cmd === '/start' || cmd === '/help') return this.help(chatId);
    if (cmd === '/whoami') return this.send(chatId, `Chat ID: ${chatId}\nUsername: @${msg.from?.username || msg.chat?.username || '-'}`);
    if (cmd === '/ping') return this.send(chatId, this.m(chatId, '🏓 Pong — bot is online.', '🏓 Pong — il bot è online.'));
    if (cmd === '/version') return this.send(chatId, `Antigravity With Telegram Enhanced v${VERSION}`);
    if (cmd === '/language' || cmd === '/lang') {
      const requested = (args[0] || '').toLowerCase();
      if (!['en','it'].includes(requested)) {
        return this.send(chatId, this.m(chatId, 'Usage: /language en|it', 'Uso: /language en|it'));
      }
      await this.setLocale(chatId, requested);
      return this.send(chatId, requested === 'it' ? '🇮🇹 Lingua impostata su Italiano.' : '🇬🇧 Language set to English.');
    }
    if (cmd === '/status') return this.sendStatus(chatId);
    if (cmd === '/workspace') return this.sendWorkspace(chatId);
    if (cmd === '/new') return this.newConversation(chatId);
    if (cmd === '/list' || cmd === '/conversations' || cmd === '/select') return this.sendConversationList(chatId);
    if (cmd === '/current') return this.sendSelectedConversation(chatId);
    if (cmd === '/unselect' || cmd === '/clearselection') return this.clearSelectedConversation(chatId);
    if (cmd === '/stop') return this.stopAI(chatId);
    if (cmd === '/reload') return this.reloadIDE(chatId);
    if (cmd === '/plan') return this.sendBrainFile(chatId, ['implementation_plan.md.resolved','implementation_plan.md'], 'Implementation Plan');
    if (cmd === '/task') return this.sendBrainFile(chatId, ['task.md.resolved','task.md'], 'Task');
    if (cmd === '/walkthrough') return this.sendBrainFile(chatId, ['walkthrough.md.resolved','walkthrough.md'], 'Walkthrough');
    if (cmd === '/run' || cmd === '/terminal' || cmd === '/term') {
      const commandText = text.replace(/^\S+\s*/, '').trim();
      return this.runTerminal(chatId, commandText);
    }
    if (cmd === '/approve' || cmd === '/yes' || cmd === '/ok') return this.forwardPrompt(chatId, 'Approved. Go ahead and implement the plan.');
    return this.send(chatId, this.m(chatId, 'Unknown command. Use /help.', 'Comando sconosciuto. Usa /help.'));
  }

  async help(chatId) {
    const en = `👋 *Antigravity With Telegram*\n\nSelect a conversation with /select. Then every normal Telegram message becomes a user prompt in that exact Antigravity conversation.\n\n*Commands*\n/status — bot + IDE status\n/new — new conversation\n/list or /select — choose Telegram conversation\n/current — show Telegram target\n/unselect — clear Telegram target\n/workspace — workspace info\n/plan — latest implementation plan\n/task — latest task\n/walkthrough — latest walkthrough\n/run <command> — run an explicitly allowed terminal command\n/stop — stop active AI task\n/reload — reload IDE window\n/language en|it — choose language\n/whoami — Telegram identity\n/version — extension version`;
    const it = `👋 *Antigravity con Telegram*\n\nSeleziona una conversazione con /select. Poi ogni normale messaggio Telegram diventa un prompt utente in quella specifica conversazione Antigravity.\n\n*Comandi*\n/status — stato bot + IDE\n/new — nuova conversazione\n/list o /select — scegli conversazione Telegram\n/current — mostra il target Telegram\n/unselect — rimuove il target Telegram\n/workspace — info workspace\n/plan — ultimo piano di implementazione\n/task — ultimo task\n/walkthrough — ultimo walkthrough\n/run <comando> — esegue un comando terminale esplicitamente autorizzato\n/stop — ferma l'attività AI\n/reload — ricarica la finestra IDE\n/language en|it — scegli la lingua\n/whoami — identità Telegram\n/version — versione estensione`;
    await this.send(chatId, this.m(chatId, en, it), { parse_mode: 'Markdown' });
  }

  async runTerminal(chatId, commandText) {
    const cfg = vscode.workspace.getConfiguration('antigravityWithTelegram');
    if (!cfg.get('terminalCommandsEnabled', false)) {
      return this.send(chatId, this.m(chatId,
        '🔒 Terminal commands are disabled. Enable antigravityWithTelegram.terminalCommandsEnabled in Settings.',
        '🔒 I comandi terminale sono disabilitati. Abilita antigravityWithTelegram.terminalCommandsEnabled nelle Impostazioni.'));
    }

    const allowed = cfg.get('terminalAllowedCommands', []);
    const allowedSudo = cfg.get('terminalAllowedSudoCommands', []);
    if (!commandText) {
      const normal = Array.isArray(allowed) && allowed.length ? allowed.join('\n• ') : this.m(chatId, '(none)', '(nessuno)');
      const privileged = Array.isArray(allowedSudo) && allowedSudo.length ? allowedSudo.join('\n• ') : this.m(chatId, '(none)', '(nessuno)');
      return this.send(chatId, this.m(chatId,
        `Usage: /run <command>\n\nAllowed:\n• ${normal}\n\nAllowed with sudo -n:\n• ${privileged}`,
        `Uso: /run <comando>\n\nAutorizzati:\n• ${normal}\n\nAutorizzati con sudo -n:\n• ${privileged}`));
    }

    let argv;
    try { argv = parseCommandLine(commandText); }
    catch (e) { return this.send(chatId, `❌ ${e.message}`); }
    if (!argv.length) return;

    const denied = new Set(['sh','bash','zsh','fish','dash','ksh','cmd','cmd.exe','powershell','powershell.exe','pwsh','pwsh.exe','node','node.exe','python','python3','python.exe','perl','ruby','php','osascript']);
    const base = path.basename(argv[0]).toLowerCase();
    const isSudo = base === 'sudo';
    let targetArgv = argv;
    let patterns = allowed;

    if (isSudo) {
      if (process.platform === 'win32') return this.send(chatId, this.m(chatId, '❌ sudo is not available on Windows.', '❌ sudo non è disponibile su Windows.'));
      targetArgv = argv.slice(1);
      if (!targetArgv.length) return this.send(chatId, this.m(chatId, 'Usage: /run sudo <allowed command>', 'Uso: /run sudo <comando autorizzato>'));
      patterns = allowedSudo;
    }

    const targetBase = path.basename(targetArgv[0] || '').toLowerCase();
    if (denied.has(targetBase)) {
      return this.send(chatId, this.m(chatId,
        '❌ Shells and general-purpose interpreters cannot be executed remotely.',
        '❌ Shell e interpreti generici non possono essere eseguiti da remoto.'));
    }
    if (!isAllowedCommand(targetArgv, patterns)) {
      return this.send(chatId, this.m(chatId,
        '⛔ Command not allowed. Send /run without arguments to see configured command prefixes.',
        '⛔ Comando non autorizzato. Invia /run senza argomenti per vedere i prefissi configurati.'));
    }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || os.homedir();
    const timeoutSec = Math.max(1, Math.min(300, Number(cfg.get('terminalTimeoutSeconds', 30)) || 30));
    const maxChars = Math.max(1000, Math.min(30000, Number(cfg.get('terminalMaxOutputChars', 12000)) || 12000));
    const shown = `${isSudo ? 'sudo -n ' : ''}${targetArgv.map(quoteForDisplay).join(' ')}`;
    const pending = await this.send(chatId, this.m(chatId, `🖥 Running:\n${shown}`, `🖥 Esecuzione:\n${shown}`));

    try {
      const result = await spawnCaptured(isSudo ? 'sudo' : targetArgv[0], isSudo ? ['-n', ...targetArgv] : targetArgv.slice(1), {
        cwd, timeoutMs: timeoutSec * 1000, maxChars,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      });
      const header = this.m(chatId,
        `✅ Exit ${result.code}${result.timedOut ? ' (timeout)' : ''} · ${result.ms} ms`,
        `✅ Uscita ${result.code}${result.timedOut ? ' (timeout)' : ''} · ${result.ms} ms`);
      const body = (result.stdout + (result.stderr ? `${result.stdout ? '\n' : ''}[stderr]\n${result.stderr}` : '')).trim() || this.m(chatId, '(no output)', '(nessun output)');
      const chunks = splitText(`${header}\n\n${body}`, 3900);
      await this.edit(chatId, pending.message_id, chunks.shift());
      for (const chunk of chunks) await this.send(chatId, chunk);
    } catch (e) {
      await this.edit(chatId, pending.message_id, this.m(chatId, `❌ Command failed: ${e.message}`, `❌ Comando non riuscito: ${e.message}`));
    }
  }

  async sendStatus(chatId) {
    let diag = null;
    try {
      const raw = await vscode.commands.executeCommand('antigravity.getDiagnostics');
      diag = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}
    const active = await getActiveCascadeId();
    const selected = this.selectedConversation(chatId);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.name || '-';
    const lines = this.locale(chatId) === 'it'
      ? ['🟢 Bot Telegram: attivo', `📁 Workspace: ${workspace}`, `🤖 Conversazione attiva IDE: ${active ? active.slice(0,8) : 'non rilevata'}`, `🎯 Target Telegram: ${selected ? `${selected.title || 'Senza titolo'} (${selected.id.slice(0,8)})` : 'segue quella attiva nell’IDE'}`, `🧭 Diagnostica IDE: ${diag ? 'disponibile' : 'non disponibile'}`]
      : ['🟢 Telegram bot: online', `📁 Workspace: ${workspace}`, `🤖 IDE active conversation: ${active ? active.slice(0,8) : 'not detected'}`, `🎯 Telegram target: ${selected ? `${selected.title || 'Untitled'} (${selected.id.slice(0,8)})` : 'follows the IDE active conversation'}`, `🧭 IDE diagnostics: ${diag ? 'available' : 'unavailable'}`];
    await this.send(chatId, lines.join('\n'));
  }

  async sendWorkspace(chatId) {
    const folders = vscode.workspace.workspaceFolders || [];
    const active = vscode.window.activeTextEditor?.document?.uri?.fsPath;
    const lines = [this.m(chatId, '📁 *Workspace*', '📁 *Workspace*')];
    for (const f of folders) lines.push(`• ${f.name}: \`${escapeMd(f.uri.fsPath)}\``);
    if (active) lines.push(this.m(chatId, `\nActive file: \`${escapeMd(active)}\``, `\nFile attivo: \`${escapeMd(active)}\``));
    await this.send(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  async newConversation(chatId) {
    const ok = await tryCommand(['antigravity.startNewConversation']);
    await this.send(chatId, ok ? this.m(chatId, '🆕 New conversation started.', '🆕 Nuova conversazione avviata.') : this.m(chatId, '❌ Could not start a new conversation.', '❌ Impossibile avviare una nuova conversazione.'));
  }

  async reloadIDE(chatId) {
    await this.send(chatId, this.m(chatId, '🔄 Reloading IDE window…', '🔄 Ricaricamento della finestra IDE…'));
    await sleep(400);
    try { await vscode.commands.executeCommand('workbench.action.reloadWindow'); } catch {}
  }

  async stopAI(chatId) {
    let ok = false;
    const id = this.selectedConversation(chatId)?.id || await getActiveCascadeId();
    if (id) ok = await cancelCascadeInvocation(id);
    if (!ok) ok = await tryCommand(['antigravity.stopGeneration','antigravity.stop','workbench.action.chat.stopListening']);
    await this.send(chatId, ok ? this.m(chatId, '🛑 Stop requested.', '🛑 Arresto richiesto.') : this.m(chatId, '⚠️ Could not confirm the stop request.', '⚠️ Impossibile confermare la richiesta di arresto.'));
  }

  selectedConversation(chatId) {
    const raw = this.ctx.globalState.get(`selectedConversation:${chatId}`, null);
    if (!raw) return null;
    if (typeof raw === 'string') return { id: raw, title: '' };
    return raw?.id ? raw : null;
  }

  async setSelectedConversation(chatId, item) {
    await this.ctx.globalState.update(`selectedConversation:${chatId}`, { id: String(item.id), title: String(item.title || 'Untitled') });
  }

  async clearSelectedConversation(chatId) {
    await this.ctx.globalState.update(`selectedConversation:${chatId}`, undefined);
    return this.send(chatId, this.m(chatId, '✅ Telegram target cleared. Normal messages will use the conversation active in the IDE.', '✅ Target Telegram rimosso. I messaggi normali useranno la conversazione attiva nell’IDE.'));
  }

  async sendSelectedConversation(chatId) {
    const selected = this.selectedConversation(chatId);
    if (!selected) return this.send(chatId, this.m(chatId, 'No Telegram conversation is selected. Use /select.', 'Nessuna conversazione Telegram selezionata. Usa /select.'));
    return this.send(chatId, this.m(chatId, `🎯 Telegram target: ${selected.title || 'Untitled'}\nID: ${selected.id}`, `🎯 Target Telegram: ${selected.title || 'Senza titolo'}\nID: ${selected.id}`));
  }

  async sendConversationList(chatId, editMessageId) {
    const list = await getAllTrajectories();
    if (!list.length) return this.send(chatId, this.m(chatId, 'No recent conversations found.', 'Nessuna conversazione recente trovata.'));
    const active = await getActiveCascadeId();
    const selected = this.selectedConversation(chatId)?.id || '';
    const rows = list.slice(0,12).map(t => {
      const marker = `${t.id === selected ? '🎯 ' : ''}${t.id === active ? '🟢 ' : ''}`;
      return [{ text: `${marker}${truncate(t.title || 'Untitled', 30)}`, callback_data: `select_${t.id}` }];
    });
    const text = this.m(chatId, '📋 Choose the conversation that will receive normal Telegram messages\n🎯 Telegram target · 🟢 IDE active', '📋 Scegli la conversazione che riceverà i normali messaggi Telegram\n🎯 Target Telegram · 🟢 Attiva nell’IDE');
    if (editMessageId) return this.edit(chatId, editMessageId, text, { reply_markup: { inline_keyboard: rows } });
    return this.send(chatId, text, { reply_markup: { inline_keyboard: rows } });
  }

  async handleCallback(q) {
    const msg = q.message;
    if (!msg || !this.isAllowed({ chat: msg.chat, from: q.from })) return;
    const chatId = msg.chat.id;
    const data = q.data || '';
    if (data.startsWith('select_') || data.startsWith('switch_')) {
      const id = data.startsWith('select_') ? data.slice(7) : data.slice(7);
      await this.answerCallback(q.id, this.m(chatId, 'Selecting…', 'Selezione…'));
      const list = await getAllTrajectories();
      const item = list.find(x => x.id === id) || { id, title: 'Untitled' };
      await this.setSelectedConversation(chatId, item);
      // Focusing the IDE is best-effort only: Telegram routing no longer depends on UI focus.
      switchConversation(id).catch(e => log(`focus selected conversation: ${e.message}`));
      await this.sendConversationList(chatId, msg.message_id);
      await this.send(chatId, this.m(chatId, `✅ Telegram will now send prompts to: ${item.title || item.id}`, `✅ Da ora Telegram invierà i prompt a: ${item.title || item.id}`));
      return;
    }
    if (data === 'approve_plan') {
      await this.answerCallback(q.id, this.m(chatId, 'Approved', 'Approvato'));
      return this.forwardPrompt(chatId, 'Approved. Go ahead and implement the plan.');
    }
  }

  async forwardPrompt(chatId, prompt) {
    const selected = this.selectedConversation(chatId);
    const targetLabel = selected?.title ? ` "${selected.title}"` : '';
    const status = await this.send(chatId, selected
      ? this.m(chatId, `⏳ Sending to selected conversation${targetLabel}…`, `⏳ Invio alla conversazione selezionata${targetLabel}…`)
      : this.m(chatId, '⏳ Sending to the conversation active in the IDE…', '⏳ Invio alla conversazione attiva nell’IDE…'));

    let targetId = selected?.id || '';
    let ok = false;
    if (targetId) {
      ok = await sendPromptToConversation(targetId, prompt);
      if (!ok) {
        // Refresh ownership and retry once; LS processes can restart independently.
        await getAllTrajectories();
        ok = await sendPromptToConversation(targetId, prompt);
      }
    } else {
      targetId = await getActiveCascadeId();
      if (targetId) ok = await sendPromptToConversation(targetId, prompt);
      if (!ok) ok = await sendPromptToIDE(prompt);
    }

    if (!ok) return this.edit(chatId, status.message_id, this.m(chatId, '❌ Could not send the message to Antigravity. Try /select again.', '❌ Impossibile inviare il messaggio ad Antigravity. Prova di nuovo /select.'));
    this.trackResponse(chatId, status.message_id, prompt, targetId).catch(e => log(`trackResponse: ${e.message}`));
  }

  async trackResponse(chatId, messageId, prompt, targetCascadeId = '') {
    const started = Date.now();
    let seenActive = false;
    let lastText = '';
    let lastStatus = '';
    while (this.running && Date.now() - started < 10 * 60 * 1000) {
      const id = targetCascadeId || await getActiveCascadeId();
      if (id) {
        const trajectory = await getCascadeTrajectory(id);
        if (trajectory) {
          const status = String(trajectory.status || '').toUpperCase();
          const active = !/(COMPLETED|FAILED|CANCELLED|IDLE|DONE|FINISHED)/.test(status) && status !== '';
          if (active) seenActive = true;
          const extracted = extractResponseText(trajectory);
          if (extracted && extracted !== prompt) lastText = extracted;
          const friendly = stepDescription(trajectory, this.locale(chatId));
          if (active && friendly && friendly !== lastStatus) {
            lastStatus = friendly;
            await this.edit(chatId, messageId, `🤖 AI: ${friendly}`);
          }
          if (seenActive && !active) break;
        }
      }
      await sleep(1200);
    }
    await this.edit(chatId, messageId, this.m(chatId, '✅ AI: finished', '✅ AI: completato'));
    if (lastText) {
      for (const chunk of splitText(lastText, 3900)) await this.send(chatId, chunk);
    } else {
      await this.send(chatId, this.m(chatId, 'AI finished, but no text response was extracted.', 'AI ha terminato, ma non è stato possibile estrarre una risposta testuale.'));
    }
  }

  async handleFile(msg) {
    const chatId = msg.chat.id;
    let fileId, fileName;
    if (msg.document) { fileId = msg.document.file_id; fileName = msg.document.file_name || `file_${Date.now()}`; }
    else { const p = msg.photo?.[msg.photo.length-1]; fileId = p?.file_id; fileName = `photo_${Date.now()}.jpg`; }
    if (!fileId) return;
    const st = await this.send(chatId, this.m(chatId, '⏳ Downloading file…', '⏳ Download del file…'));
    try {
      const info = await this.api('getFile', { file_id: fileId });
      const dir = path.join(os.homedir(), '.ag-link', 'uploads'); fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${Date.now()}_${fileName}`);
      const res = await fetch(`${this.fileBase}/${info.file_path}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      await this.edit(chatId, st.message_id, this.m(chatId, `✅ Downloaded: ${fileName}`, `✅ Scaricato: ${fileName}`));
      const caption = msg.caption ? `\n\n${msg.caption}` : '';
      await this.forwardPrompt(chatId, `[Attached file: ${dest}]${caption}`);
    } catch (e) { await this.edit(chatId, st.message_id, `❌ ${e.message}`); }
  }

  async sendBrainFile(chatId, names, label) {
    const file = findLatestBrainFile(names);
    if (!file) return this.send(chatId, this.m(chatId, `❌ No ${label} found.`, `❌ Nessun ${label} trovato.`));
    const content = fs.readFileSync(file, 'utf8');
    const preview = content.length > 3800 ? content.slice(0,3700) + '\n\n…' : content;
    await this.send(chatId, `📄 ${label}\n\n${preview}`);
    if (label === 'Implementation Plan') {
      await this.send(chatId, this.m(chatId, 'Approve this plan?', 'Approvare questo piano?'), { reply_markup: { inline_keyboard: [[{ text: this.m(chatId,'✅ Approve','✅ Approva'), callback_data: 'approve_plan' }]] } });
    }
  }
}

async function sendPromptToConversation(cascadeId, message) {
  if (!cascadeId) return false;
  // Current Antigravity builds accept real user turns through SendUserCascadeMessage.
  // The items[] shape mirrors the native client/ConnectRPC payload.
  let r = await lsRpc('SendUserCascadeMessage', { cascadeId, items: [{ text: String(message) }] }, cascadeId);
  if (r !== null) return true;

  // Some builds only accept messages after the conversation has been loaded/focused.
  await switchConversation(cascadeId);
  r = await lsRpc('SendUserCascadeMessage', { cascadeId, items: [{ text: String(message) }] }, cascadeId);
  if (r !== null) return true;

  // Compatibility fallback observed in older reverse-engineered builds.
  r = await lsRpc('SendUserCascadeMessage', { cascadeId, text: String(message) }, cascadeId);
  return r !== null;
}

async function sendPromptToIDE(message) {
  for (const command of ['antigravity.sendTextToChat','antigravity.sendPromptToAgentPanel']) {
    try { await vscode.commands.executeCommand(command, message); return true; } catch {}
  }
  return false;
}
async function tryCommand(commands) {
  for (const c of commands) { try { await vscode.commands.executeCommand(c); return true; } catch {} }
  return false;
}
async function switchConversation(id) {
  // Route the focus request to the language server that actually owns this
  // conversation. GetAllCascadeTrajectories is server-local in current builds.
  const owner = trajectoryOwners.get(String(id));
  if (owner) {
    const rpc = await lsRpcOn(owner, 'SmartFocusConversation', { cascadeId: id });
    if (rpc !== null) return true;
    const loaded = await lsRpcOn(owner, 'LoadTrajectory', { cascadeId: id });
    if (loaded !== null) {
      const focused = await lsRpcOn(owner, 'SmartFocusConversation', { cascadeId: id });
      if (focused !== null) return true;
    }
  }

  // If the owner map is stale, try every reachable server before falling back
  // to internal VS Code commands.
  for (const c of await discoverLsConnections()) {
    const rpc = await lsRpcOn(c, 'SmartFocusConversation', { cascadeId: id });
    if (rpc !== null) return true;
  }
  for (const c of ['antigravity.smartFocusConversation','workbench.action.smartFocusConversation','workbench.action.forceFocusManager']) {
    try { await vscode.commands.executeCommand(c, id); return true; } catch {}
  }
  return false;
}

async function getDiagnosticsData() {
  try {
    const raw = await vscode.commands.executeCommand('antigravity.getDiagnostics');
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  } catch { return {}; }
}

function diagnosticsTrajectories(d) {
  const raw = d?.recentTrajectories || d?.trajectorySummaries || d?.recentConversations || [];
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  return arr.map((value) => {
    const x = value?.summary || value?.trajectorySummary || value || {};
    const id = x.cascadeId || x.googleAgentId || x.id || x.trajectoryId || '';
    const title = x.title || x.name || x.description || x.userVisibleTitle || x.initialPrompt || 'Untitled';
    const updated = toTimestamp(x.lastModifiedTime || x.lastUpdatedTime || x.updateTime || x.updatedAt || x.timestamp || x.lastModified || 0);
    return { id:String(id || ''), title:String(title || 'Untitled'), status:x.status || '', updated, workspaceUris:x.workspaceUris || [], source:'diagnostics' };
  }).filter(x => x.id);
}

async function getActiveCascadeId() {
  const d = await getDiagnosticsData();
  const direct = d?.activeCascadeId || d?.currentCascadeId || d?.activeConversationId || d?.currentConversationId || d?.cascadeId;
  if (direct) return String(direct);
  const recent = diagnosticsTrajectories(d);
  const running = recent.find(x => String(x.status).toUpperCase() === 'RUNNING');
  if (running) return running.id;
  if (recent[0]?.id) return recent[0].id;
  const list = await getAllTrajectories({ includeDiagnostics:false });
  const live = list.find(x => String(x.status).toUpperCase() === 'RUNNING');
  return live?.id || list[0]?.id || '';
}

let lsConnectionsCache = { at:0, items:[] };
const trajectoryOwners = new Map();

async function discoverLsConnections(force = false) {
  if (!force && lsConnectionsCache.items.length && Date.now() - lsConnectionsCache.at < 15000) return lsConnectionsCache.items;
  const found = [];
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -match 'language_server'} | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`, { timeout:5000, windowsHide:true });
      let rows = [];
      try { const parsed = JSON.parse(stdout || '[]'); rows = Array.isArray(parsed) ? parsed : [parsed]; } catch {}
      for (const r of rows) {
        const conns = await probeProcessAll(Number(r.ProcessId), String(r.CommandLine || ''));
        found.push(...conns);
      }
    } else {
      const { stdout } = await execAsync('ps -axo pid=,command=', { timeout:5000 });
      for (const line of stdout.split('\n').filter(x => /language_server/i.test(x))) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/); if (!m) continue;
        found.push(...await probeProcessAll(Number(m[1]), m[2]));
      }
    }
  } catch (e) { log(`LS discovery failed: ${e.message}`); }

  const dedup = new Map();
  for (const c of found) dedup.set(`${c.protocol}:${c.port}:${c.csrf}`, c);
  const items = [...dedup.values()];
  lsConnectionsCache = { at:Date.now(), items };
  log(`LS discovery: ${items.length} reachable conversation server(s)`);
  return items;
}

async function probeProcessAll(pid, command) {
  const csrf = command.match(/--csrf_token(?:=|\s+)([^\s"']+)/)?.[1];
  const extPort = Number(command.match(/--extension_server_port(?:=|\s+)(\d+)/)?.[1] || 0);
  if (!csrf || !pid) return [];
  const ports = new Set();
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('netstat -ano -p tcp', { timeout:5000, windowsHide:true });
      const re = /^\s*TCP\s+[^:]+:(\d+)\s+[^\s]+\s+LISTENING\s+(\d+)\s*$/gmi;
      let m; while ((m = re.exec(stdout))) if (Number(m[2]) === pid) ports.add(Number(m[1]));
    } else {
      try {
        const { stdout } = await execAsync(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN`, { timeout:5000 });
        for (const m of stdout.matchAll(/TCP\s+[^:]+:(\d+)\s+\(LISTEN\)/g)) ports.add(Number(m[1]));
      } catch {
        try {
          const { stdout } = await execAsync('ss -ltnp', { timeout:5000 });
          for (const line of stdout.split('\n')) if (line.includes(`pid=${pid},`)) { const m = line.match(/:(\d+)\s+/); if (m) ports.add(Number(m[1])); }
        } catch {}
      }
    }
  } catch {}

  const results = [];
  for (const port of [...ports].filter(p => p && p !== extPort)) {
    for (const protocol of ['http','https']) {
      const c = { pid, port, csrf, protocol };
      const data = await lsRpcOn(c, 'GetAllCascadeTrajectories', {}, 1400, false);
      if (data !== null) { results.push(c); break; }
    }
  }
  return results;
}

async function lsRpcOn(c, method, body, timeoutMs = 4000, clearCacheOnFailure = true) {
  if (!c) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.protocol}://127.0.0.1:${c.port}/exa.language_server_pb.LanguageServerService/${method}`, {
      method:'POST', headers:{'content-type':'application/json','x-codeium-csrf-token':c.csrf}, body:JSON.stringify(body || {}), signal:controller.signal
    });
    if (!res.ok) { if (clearCacheOnFailure) lsConnectionsCache = { at:0, items:[] }; return null; }
    return await res.json();
  } catch {
    if (clearCacheOnFailure) lsConnectionsCache = { at:0, items:[] };
    return null;
  } finally { clearTimeout(timer); }
}

async function lsRpc(method, body, cascadeId = '') {
  const id = String(cascadeId || body?.cascadeId || '');
  const owner = id && trajectoryOwners.get(id);
  if (owner) {
    const r = await lsRpcOn(owner, method, body);
    if (r !== null) return r;
  }
  for (const c of await discoverLsConnections()) {
    const r = await lsRpcOn(c, method, body);
    if (r !== null) return r;
  }
  return null;
}

function parseTrajectorySource(data, owner, sourceName = 'language-server') {
  const source = data?.trajectorySummaries ?? data?.trajectories ?? data?.cascadeTrajectories ?? data?.items ?? [];
  let entries = [];
  if (Array.isArray(source)) entries = source.map((value, index) => [String(index), value]);
  else if (source && typeof source === 'object') entries = Object.entries(source);

  return entries.map(([key, value]) => {
    const x = value?.summary || value?.trajectorySummary || value || {};
    const id = x.cascadeId || x.id || x.googleAgentId || x.trajectoryId || (looksLikeId(key) ? key : '');
    const title = x.title || x.name || x.description || x.userVisibleTitle || x.initialPrompt || 'Untitled';
    const updated = toTimestamp(x.lastModifiedTime || x.lastUpdatedTime || x.updateTime || x.updatedAt || x.timestamp || x.lastModified || 0);
    const item = { id:String(id || ''), title:String(title || 'Untitled'), status:x.status || '', updated, workspaceUris:x.workspaceUris || [], source:sourceName };
    if (item.id && owner) trajectoryOwners.set(item.id, owner);
    return item;
  }).filter(x => x.id);
}

function toTimestamp(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const n = Number(v); if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const d = Date.parse(v); return Number.isNaN(d) ? 0 : d;
  }
  if (typeof v === 'object') {
    const sec = Number(v.seconds ?? v.sec ?? 0); const ns = Number(v.nanos ?? v.nanoseconds ?? 0);
    if (sec) return sec * 1000 + Math.floor(ns / 1e6);
  }
  return 0;
}

async function getAllTrajectories(options = {}) {
  const includeDiagnostics = options.includeDiagnostics !== false;
  const merged = new Map();
  const conns = await discoverLsConnections();
  await Promise.all(conns.map(async c => {
    const data = await lsRpcOn(c, 'GetAllCascadeTrajectories', {});
    for (const item of parseTrajectorySource(data, c)) {
      const prev = merged.get(item.id);
      if (!prev || item.updated >= prev.updated || String(item.status).toUpperCase() === 'RUNNING') merged.set(item.id, item);
    }
  }));

  let diagnostics = [];
  if (includeDiagnostics) {
    const d = await getDiagnosticsData();
    diagnostics = diagnosticsTrajectories(d);
    for (const item of diagnostics) {
      const prev = merged.get(item.id);
      if (!prev) merged.set(item.id, item);
      else {
        if ((!prev.title || prev.title === 'Untitled') && item.title) prev.title = item.title;
        if (!prev.status && item.status) prev.status = item.status;
        if (!prev.updated && item.updated) prev.updated = item.updated;
      }
    }
  }

  const active = includeDiagnostics ? await getActiveCascadeIdFromKnown(diagnostics, merged) : '';
  const list = [...merged.values()];
  if (active && !merged.has(active)) list.unshift({ id:active, title:'Current conversation', status:'RUNNING', updated:Date.now(), workspaceUris:[], source:'active' });
  list.sort((a, b) => {
    if (active && a.id === active && b.id !== active) return -1;
    if (active && b.id === active && a.id !== active) return 1;
    const ar = String(a.status).toUpperCase() === 'RUNNING' ? 1 : 0;
    const br = String(b.status).toUpperCase() === 'RUNNING' ? 1 : 0;
    if (ar !== br) return br - ar;
    return (b.updated || 0) - (a.updated || 0);
  });
  log(`Conversations: ${list.length} merged from ${conns.length} LS server(s)${includeDiagnostics ? ' + diagnostics' : ''}`);
  return list;
}

async function getActiveCascadeIdFromKnown(diagnostics, merged) {
  const d = await getDiagnosticsData();
  const direct = d?.activeCascadeId || d?.currentCascadeId || d?.activeConversationId || d?.currentConversationId || d?.cascadeId;
  if (direct) return String(direct);
  const runningDiag = diagnostics.find(x => String(x.status).toUpperCase() === 'RUNNING');
  if (runningDiag) return runningDiag.id;
  const runningLs = [...merged.values()].find(x => String(x.status).toUpperCase() === 'RUNNING');
  return runningLs?.id || diagnostics[0]?.id || '';
}

function looksLikeId(value) {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(value || '')) || /^[A-Za-z0-9_-]{16,}$/.test(String(value || ''));
}
async function getCascadeTrajectory(id) {
  let data = await lsRpc('GetCascadeTrajectory', { cascadeId: id }, id);
  if (data !== null) return data?.trajectory || data?.cascadeTrajectory || data || null;
  data = await lsRpc('GetCascadeTrajectorySteps', { cascadeId: id }, id);
  if (data === null) return null;
  return data?.trajectory || data?.cascadeTrajectory || data || null;
}
async function cancelCascadeInvocation(id) {
  const r = await lsRpc('CancelCascadeInvocation', { cascadeId:id }, id);
  return !!r;
}
function extractResponseText(traj) {
  const steps = traj?.steps || traj?.trajectory?.steps || [];
  const candidates = [...steps].reverse();
  for (const s of candidates) {
    let c = s?.plannerResponse?.response ?? s?.chatResponse?.message ?? s?.chatResponse?.text ?? s?.assistantResponse?.response ?? s?.message?.text ?? s?.message;
    if (typeof c === 'string' && c.trim()) {
      if (c.trim().startsWith('{')) { try { const j = JSON.parse(c); c = j.response || j.text || c; } catch {} }
      return String(c).trim();
    }
  }
  return '';
}
function stepDescription(traj, lang) {
  const steps = traj?.steps || traj?.trajectory?.steps || [];
  const s = steps[steps.length-1]; if (!s) return lang === 'it' ? 'inizializzazione' : 'initializing';
  const tc = s?.plannerResponse?.toolCalls?.[0]; const tool = tc?.name || '';
  const en = { view_file:'reading file', run_command:'running terminal command', write_to_file:'creating file', replace_file_content:'editing file', multi_replace_file_content:'editing files', grep_search:'searching codebase', list_dir:'listing directory', ask_question:'waiting for your answer', ask_permission:'waiting for permission' };
  const it = { view_file:'lettura file', run_command:'esecuzione comando terminale', write_to_file:'creazione file', replace_file_content:'modifica file', multi_replace_file_content:'modifica file', grep_search:'ricerca nel codice', list_dir:'lettura cartella', ask_question:'in attesa della tua risposta', ask_permission:'in attesa di autorizzazione' };
  if (tool) return (lang === 'it' ? it : en)[tool] || (lang === 'it' ? `esecuzione ${tool}` : `running ${tool}`);
  const type = String(s.type || '').replace('CORTEX_STEP_TYPE_','').replaceAll('_',' ').toLowerCase();
  return type || (lang === 'it' ? 'elaborazione' : 'processing');
}

function findLatestBrainFile(names) {
  const brain = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
  if (!fs.existsSync(brain)) return null;
  let best = null, bestTime = 0;
  for (const dir of safeReadDirs(brain)) {
    for (const name of names) {
      const p = path.join(brain, dir, name);
      try { const st = fs.statSync(p); if (st.isFile() && st.mtimeMs > bestTime) { best = p; bestTime = st.mtimeMs; } } catch {}
    }
  }
  return best;
}
function parseCommandLine(input) {
  const args = [];
  let cur = '', quote = null, escaped = false;
  for (const ch of String(input)) {
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { args.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (escaped) cur += '\\';
  if (quote) throw new Error('Unclosed quote in command.');
  if (cur) args.push(cur);
  return args;
}
function isAllowedCommand(argv, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some(p => {
    let wanted;
    try { wanted = parseCommandLine(String(p)); } catch { return false; }
    return wanted.length && wanted.every((part, i) => argv[i] === part);
  });
}
function quoteForDisplay(s) { return /\s/.test(s) ? JSON.stringify(s) : s; }
function spawnCaptured(command, args, opts) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = '', stderr = '', done = false, timedOut = false;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    const append = (which, chunk) => {
      const text = chunk.toString('utf8');
      if (which === 'out') stdout = (stdout + text).slice(-opts.maxChars);
      else stderr = (stderr + text).slice(-opts.maxChars);
    };
    child.stdout.on('data', c => append('out', c));
    child.stderr.on('data', c => append('err', c));
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code, signal) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? (signal ? -1 : 0), signal, stdout, stderr, timedOut, ms: Date.now() - started }); } });
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, opts.timeoutMs);
  });
}
function safeReadDirs(p) { try { return fs.readdirSync(p).filter(n => { try { return fs.statSync(path.join(p,n)).isDirectory(); } catch { return false; } }); } catch { return []; } }
function splitText(text, max) { const out=[]; let r=text; while(r.length>max){ let i=r.lastIndexOf('\n',max); if(i<max/2)i=max; out.push(r.slice(0,i)); r=r.slice(i).trimStart(); } if(r)out.push(r); return out; }
function truncate(s,n){ return s.length>n ? s.slice(0,n-1)+'…' : s; }
function escapeMd(s){ return String(s).replace(/([_*`\[\]()])/g,'\\$1'); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

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
  extContext = context;
  output = vscode.window.createOutputChannel('Antigravity Telegram'); context.subscriptions.push(output);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100); context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-with-telegram.start', () => startBot(context)),
    vscode.commands.registerCommand('antigravity-with-telegram.stop', () => stopBot()),
    vscode.commands.registerCommand('antigravity-with-telegram.status', async () => {
      const active = await getActiveCascadeId();
      vscode.window.showInformationMessage(`Telegram: ${bot ? 'ON' : 'OFF'} · Antigravity: ${active ? `conversation ${active.slice(0,8)}` : 'not detected'}`);
    }),
    vscode.commands.registerCommand('antigravity-with-telegram.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:capriele.antigravity-telegram-enhanced')),
    vscode.commands.registerCommand('antigravity-with-telegram.testMessage', async () => {
      const id = bot?.allowedChatId; if (!bot || !id) return vscode.window.showWarningMessage(t('testFailed'));
      try { await bot.send(id, `🧪 Antigravity With Telegram Enhanced v${VERSION}`); vscode.window.showInformationMessage(t('testSent')); } catch { vscode.window.showErrorMessage(t('testFailed')); }
    })
  );
  updateStatus(false);
  if (vscode.workspace.getConfiguration('antigravityWithTelegram').get('autoStart', false)) setTimeout(() => startBot(context), 1500);
}
function deactivate(){ try { bot?.stop(); } catch {} }
module.exports = { activate, deactivate };
