// @ts-nocheck
const vscode = require('vscode');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { log } = require('../core/logger');
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

module.exports = { sendPromptToConversation, sendPromptToIDE, tryCommand, switchConversation, getDiagnosticsData, getActiveCascadeId, discoverLsConnections, getAllTrajectories, getCascadeTrajectory, cancelCascadeInvocation, extractResponseText, stepDescription };
