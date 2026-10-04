// @ts-nocheck
let output = null;
function setOutputChannel(channel) { output = channel; }
function log(message) { output?.appendLine(`[${new Date().toISOString()}] ${message}`); }
module.exports = { setOutputChannel, log };
