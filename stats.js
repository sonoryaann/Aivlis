import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.join(__dirname, "model-stats.json");

let stats = {};
try {
  stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
} catch {
  stats = {};
}

function save() {
  fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), () => {});
}

// Traccia, per ogni modello, quanto ci mette a rispondere (solo sulle risposte riuscite,
// per non far sembrare "lento" un modello che ha solo fallito) e quante volte fallisce.
// File puramente informativo per noi: non è letto da nessuna parte dell'app.
function recordStat(modelRaw, ms, success) {
  const s = stats[modelRaw] || {
    count: 0,
    successCount: 0,
    failCount: 0,
    avgMs: 0,
    minMs: null,
    maxMs: null,
    lastMs: null,
    lastAt: null,
  };
  s.count += 1;
  if (success) {
    s.successCount += 1;
    s.avgMs = Math.round((s.avgMs * (s.successCount - 1) + ms) / s.successCount);
    s.minMs = s.minMs === null ? ms : Math.min(s.minMs, ms);
    s.maxMs = s.maxMs === null ? ms : Math.max(s.maxMs, ms);
    s.lastMs = ms;
    s.lastAt = new Date().toISOString();
  } else {
    s.failCount += 1;
  }
  stats[modelRaw] = s;
  save();
}

export { recordStat };
