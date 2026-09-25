import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { SYSTEM_PROMPT, SILVY_SYSTEM_PROMPT, buildUserPrompt, parseModelOutput } from "./prompts.js";
import { recordStat } from "./stats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.OPENROUTER_SITE_URL || `http://localhost:${PORT}`;
const SITE_NAME = process.env.OPENROUTER_SITE_NAME || "Aivlis";

const MODEL_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 60_000;
const IMAGE_MODEL = process.env.IMAGE_MODEL || "inclusionai/ming-image-0.1-design";
const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

// Ogni voce di MODELS/FALLBACK_MODELS è nel formato "provider:model-id", es.
// "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free" o "groq:llama-3.1-8b-instant".
// Il provider seleziona endpoint/chiave/euristica di rate-limit; il resto (dopo i due punti)
// è l'id modello passato così com'è all'API.
const PROVIDERS = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: process.env.OPENROUTER_API_KEY,
    extraHeaders: { "HTTP-Referer": SITE_URL, "X-Title": SITE_NAME },
    // Limite giornaliero dell'intero account (non del singolo modello): una volta esaurito,
    // ogni modello gratuito fallirà allo stesso modo finché non si resetta.
    isDailyLimit: (status, text) => status === 429 && /free-models-per-day/i.test(text),
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    apiKey: process.env.GROQ_API_KEY,
    extraHeaders: {},
    isDailyLimit: (status, text) => status === 429 && /per[_ -]?day|daily/i.test(text),
  },
};

function parseEntry(entry) {
  const idx = entry.indexOf(":");
  if (idx === -1) return null;
  const provider = entry.slice(0, idx);
  const modelId = entry.slice(idx + 1);
  if (!PROVIDERS[provider] || !modelId) return null;
  return { provider, modelId, raw: entry };
}

function parseModelList(envValue) {
  return (envValue || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .map(parseEntry)
    .filter(Boolean);
}

const MODELS = parseModelList(process.env.MODELS);
const FALLBACK_MODELS = parseModelList(process.env.FALLBACK_MODELS);
const SILVY_MODELS = parseModelList(process.env.SILVY_MODEL || "groq:openai/gpt-oss-120b");

for (const [name, provider] of Object.entries(PROVIDERS)) {
  const usesIt = [...MODELS, ...FALLBACK_MODELS, ...SILVY_MODELS].some((e) => e.provider === name);
  if (usesIt && !provider.apiKey) {
    console.warn(`[aivlis] ATTENZIONE: nessuna API key per "${name}" ma è usato in MODELS/FALLBACK_MODELS/SILVY_MODEL.`);
  }
}
if (MODELS.length === 0) {
  console.warn("[aivlis] ATTENZIONE: nessun modello valido configurato nella variabile MODELS.");
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Cache in-memory per query normalizzata: evita di rigenerare le pagine per ricerche ripetute.
// Vive solo finché il processo resta acceso (nessuna persistenza, nessun TTL: progetto locale).
const searchCache = new Map();
function cacheKey(query) {
  return query.trim().toLowerCase();
}

// Cache in-memory per prompt immagine (stesso principio, con un tetto per non far
// crescere la memoria all'infinito con i base64 delle immagini generate).
const imageCache = new Map();
const IMAGE_CACHE_MAX = 100;

async function generateImage(prompt) {
  const cached = imageCache.get(prompt);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_IMAGES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        ...PROVIDERS.openrouter.extraHeaders,
      },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const item = data?.data?.[0];
    if (!item?.b64_json) throw new Error("Risposta immagine non valida");
    const dataUrl = `data:${item.media_type || "image/png"};base64,${item.b64_json}`;

    imageCache.set(prompt, dataUrl);
    if (imageCache.size > IMAGE_CACHE_MAX) {
      imageCache.delete(imageCache.keys().next().value);
    }
    return dataUrl;
  } finally {
    clearTimeout(timeout);
  }
}

function fakeUrlFor(site, title, seed) {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  const domain = site
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
  return `www.${domain || "aivlis"}.it/${seed.slice(0, 6)}/${slug || "risultato"}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callProvider(entry, query) {
  const provider = PROVIDERS[entry.provider];
  if (!provider.apiKey) {
    const err = new Error(`Nessuna API key configurata per il provider "${entry.provider}"`);
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const res = await fetch(provider.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        ...provider.extraHeaders,
      },
      body: JSON.stringify({
        model: entry.modelId,
        temperature: 1.0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(query) },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      err.status = res.status;
      // Alcuni provider (es. OpenRouter free tier) hanno un limite giornaliero sull'intero
      // account: una volta esaurito ogni modello fallirà allo stesso modo finché non si
      // resetta, quindi è inutile ritentare o cercare un fallback in questo caso.
      err.dailyLimit = provider.isDailyLimit(res.status, errText);
      throw err;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    const parsed = parseModelOutput(raw);
    if (!parsed) throw new Error("Formato risposta non valido");
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function queryModel(entry, query) {
  const maxAttempts = 3;
  const startedAt = Date.now();
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const parsed = await callProvider(entry, query);
      const seed = crypto.randomUUID();
      recordStat(entry.raw, Date.now() - startedAt, true);
      return {
        ok: true,
        id: seed,
        model: entry.raw,
        title: parsed.title,
        site: parsed.site || "Aivlis",
        author: parsed.author || "Redazione",
        date: parsed.date || "",
        description: parsed.description || "",
        content: parsed.content,
        url: fakeUrlFor(parsed.site || "aivlis", parsed.title, seed),
      };
    } catch (err) {
      lastErr = err;
      if (err.dailyLimit) break;
      const retryable = err.status === 429 || err.status === 502 || err.status === 503;
      if (!retryable || attempt === maxAttempts) break;
      await sleep(1000 * attempt);
    }
  }

  recordStat(entry.raw, Date.now() - startedAt, false);
  throw lastErr;
}

app.get("/api/search-stream", async (req, res) => {
  const query = (req.query.q || "").toString().trim();
  if (!query) {
    res.status(400).end();
    return;
  }
  if (MODELS.length === 0) {
    res.status(500).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const key = cacheKey(query);
  const cached = searchCache.get(key);
  if (cached) {
    send("meta", { total: cached.length });
    for (const result of cached) send("result", { ...result, cached: true });
    send("done", { cached: true });
    res.end();
    return;
  }

  send("meta", { total: MODELS.length });

  // Coda condivisa di modelli di riserva: se un modello primario fallisce, ne viene
  // "pescato" uno da qui (al massimo una volta per pagina) per provare a salvare il risultato.
  const fallbackQueue = [...FALLBACK_MODELS];
  const freshResults = [];

  let quotaExhausted = false;

  // Il primo modello a rispondere con successo viene richiamato una seconda volta per
  // generare una pagina bonus, invece di lasciarlo semplicemente in attesa degli altri.
  let bonusTriggered = false;
  const bonusJobs = [];

  const jobs = MODELS.map(async (entry) => {
    try {
      const result = await queryModel(entry, query);
      freshResults.push(result);
      send("result", result);

      if (!bonusTriggered) {
        bonusTriggered = true;
        bonusJobs.push(
          queryModel(entry, query)
            .then((bonusResult) => {
              const tagged = { ...bonusResult, bonusFor: entry.raw };
              freshResults.push(tagged);
              send("result", tagged);
            })
            .catch(() => {
              // pagina bonus, non un risultato atteso: se fallisce non serve segnalarlo
            })
        );
      }
      return;
    } catch (primaryErr) {
      if (primaryErr.dailyLimit) quotaExhausted = true;

      // Salta il fallback solo se è sullo stesso provider esaurito: fallirebbe di sicuro
      // allo stesso modo. Un fallback su un provider diverso (es. Groq) vale comunque la pena.
      const skipFallback =
        primaryErr.dailyLimit && fallbackQueue[0]?.provider === entry.provider;
      const fallbackEntry = skipFallback ? null : fallbackQueue.shift();
      if (!fallbackEntry) {
        send("error", { model: entry.raw, message: primaryErr.message, dailyLimit: primaryErr.dailyLimit });
        return;
      }
      try {
        const result = await queryModel(fallbackEntry, query);
        const tagged = { ...result, fallbackFor: entry.raw };
        freshResults.push(tagged);
        send("result", tagged);
      } catch (fallbackErr) {
        if (fallbackErr.dailyLimit) quotaExhausted = true;
        send("error", {
          model: `${entry.raw} -> ${fallbackEntry.raw}`,
          message: fallbackErr.message,
          dailyLimit: fallbackErr.dailyLimit,
        });
      }
    }
  });

  await Promise.allSettled(jobs);
  await Promise.allSettled(bonusJobs);
  if (freshResults.length > 0) searchCache.set(key, freshResults);
  send("done", { quotaExhausted });
  res.end();
});

app.get("/api/images-stream", async (req, res) => {
  let items;
  try {
    items = JSON.parse((req.query.items || "[]").toString());
  } catch {
    res.status(400).end();
    return;
  }
  if (!Array.isArray(items) || items.length === 0 || !process.env.OPENROUTER_API_KEY) {
    res.status(400).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const IMAGE_CONCURRENCY = 3;
  const queue = items.filter((item) => item && item.id && item.prompt);

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        const dataUrl = await generateImage(item.prompt);
        send("image", { id: item.id, dataUrl });
      } catch (err) {
        send("error", { id: item.id, message: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(IMAGE_CONCURRENCY, queue.length) }, () => worker());
  await Promise.allSettled(workers);
  send("done", {});
  res.end();
});

async function callChatModel(entry, messages) {
  const provider = PROVIDERS[entry.provider];
  if (!provider.apiKey) throw new Error(`Nessuna API key configurata per il provider "${entry.provider}"`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        ...provider.extraHeaders,
      },
      body: JSON.stringify({ model: entry.modelId, temperature: 0.9, messages }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) throw new Error("Risposta chat vuota");
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

app.post("/api/chat", async (req, res) => {
  const message = (req.body?.message || "").toString().trim();
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  if (!message) {
    res.status(400).json({ error: "Messaggio mancante" });
    return;
  }
  if (SILVY_MODELS.length === 0) {
    res.status(500).json({ error: "Nessun modello configurato per Silvy" });
    return;
  }

  const messages = [
    { role: "system", content: SILVY_SYSTEM_PROMPT },
    ...history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20),
    { role: "user", content: message },
  ];

  let lastErr;
  for (const entry of SILVY_MODELS) {
    try {
      const reply = await callChatModel(entry, messages);
      res.json({ reply });
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[aivlis] Silvy: "${entry.provider}:${entry.modelId}" ha fallito — ${err.message}`);
    }
  }
  res.status(502).json({ error: lastErr?.message || "Silvy non è riuscita a rispondere" });
});

app.listen(PORT, () => {
  console.log(`[aivlis] server avviato su http://localhost:${PORT}`);
});
