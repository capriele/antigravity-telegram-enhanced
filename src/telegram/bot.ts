// @ts-nocheck
const vscode = require('vscode');
const VERSION = '1.4.1';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('../core/logger');
const { language } = require('../i18n');
const { parseCommandLine, isAllowedCommand, quoteForDisplay, spawnCaptured } = require('../terminal');
const { findLatestBrainFile, splitText, truncate, escapeMd, sleep } = require('../core/utils');
const { sendPromptToConversation, sendPromptToIDE, tryCommand, switchConversation, getDiagnosticsData, getActiveCascadeId, getAllTrajectories, getCascadeTrajectory, cancelCascadeInvocation, extractResponseText, stepDescription } = require('../antigravity');
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

module.exports = { TelegramBotClient };
