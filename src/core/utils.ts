// @ts-nocheck
const fs = require('fs');
const path = require('path');
const os = require('os');
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
function safeReadDirs(p) { try { return fs.readdirSync(p).filter(n => { try { return fs.statSync(path.join(p,n)).isDirectory(); } catch { return false; } }); } catch { return []; } }
function splitText(text, max) { const out=[]; let r=text; while(r.length>max){ let i=r.lastIndexOf('\n',max); if(i<max/2)i=max; out.push(r.slice(0,i)); r=r.slice(i).trimStart(); } if(r)out.push(r); return out; }
function truncate(s,n){ return s.length>n ? s.slice(0,n-1)+'…' : s; }
function escapeMd(s){ return String(s).replace(/([_*`\[\]()])/g,'\\$1'); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
module.exports = { findLatestBrainFile, safeReadDirs, splitText, truncate, escapeMd, sleep };
