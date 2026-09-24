# Aivlis

Un browser/motore di ricerca satirico: qualunque cosa cerchi, la risposta è convincente, scritta come
un vero articolo/voce enciclopedica... e completamente inventata.

## Come funziona

- Il backend (`server.js`) riceve la query e interroga **in parallelo** più modelli gratuiti, uno per
  ogni "pagina" di risultato. Supporta due provider intercambiabili: [OpenRouter](https://openrouter.ai/)
  (pool primario, `MODELS`) e [Groq](https://console.groq.com/) (fallback: scatta solo se un modello
  OpenRouter fallisce, sia per recuperare quella pagina sia perché più veloce). Ogni voce in
  `MODELS`/`FALLBACK_MODELS` è nel formato `provider:model-id`.
- Ogni modello genera titolo, sito/fonte finti, autore, data e un articolo in Markdown con una risposta
  falsa ma scritta in tono autorevole (vedi il prompt in `prompts.js`).
- I risultati arrivano al frontend via Server-Sent Events man mano che ogni modello finisce, così la
  lista si popola gradualmente come in un vero motore di ricerca.
- Quando apri una pagina, il frontend le assegna **uno stile casuale** tra 7 template CSS predefiniti
  (wiki, blog anni 2000, tabloid, portale istituzionale, forum, documento governativo, blog tech dark
  mode) — lo stile non è generato dall'AI, è scelto a caso lato client. Ogni tema imita un genere di
  sito reale: l'umorismo deve venire dal contenuto assurdo dentro un contenitore credibile, non dallo
  stile stesso.
- La lista risultati ha un **pannello informazioni** laterale (stile Google Knowledge Panel), costruito
  riusando i dati dei risultati già arrivati (nessuna chiamata AI aggiuntiva): riempie lo spazio su
  schermi larghi e rinforza la sensazione di motore di ricerca vero.
- Se un modello primario (`MODELS`) fallisce (rate limit, timeout, formato non rispettato), il server
  pesca automaticamente un modello dalla lista `FALLBACK_MODELS` (al massimo un tentativo di riserva
  per pagina) per provare comunque a produrre quel risultato.
- Il **primo modello a rispondere con successo** viene richiamato una seconda volta per generare una
  pagina bonus, invece di restare inutilizzato mentre gli altri sono ancora in corso: così i modelli
  più veloci vengono sfruttati di più. Il bonus è uno solo per ricerca (non a catena) e se fallisce
  viene scartato silenziosamente (non è un risultato "atteso").
- Il server tiene un **log di velocità per modello** in `model-stats.json` (creato/aggiornato
  automaticamente, non tracciato in git, non esposto nell'interfaccia): tempo medio/minimo/massimo di
  risposta e conteggio successi/fallimenti per ciascun modello, utile per capire quali sono i più lenti
  ed eventualmente sostituirli o duplicare quelli più veloci in `MODELS`.
- Il server tiene una **cache in memoria** per query normalizzata (minuscolo, trim): una ricerca già
  fatta restituisce le stesse pagine all'istante, senza richiamare i modelli. La cache vive solo finché
  il processo resta acceso (si svuota al riavvio del server).
- Il browser tiene una **cronologia locale** (localStorage, max 15 voci) delle ricerche fatte. Cliccando
  sulla barra di ricerca appare un menu a tendina con le ricerche recenti (filtrabili mentre scrivi); la
  home mostra le ricerche recenti e una riga di ricerche di esempio cliccabili.
- Tab **"Immagini"** (come Google): genera un'immagine per ogni pagina di risultato, usando il titolo
  già generato come prompt (nessuna chiamata AI aggiuntiva per il testo). Passa dall'endpoint dedicato
  di OpenRouter `/api/v1/images` (diverso da `/chat/completions`) con il modello `IMAGE_MODEL`
  (default `inclusionai/ming-image-0.1-design`, costo reale $0/immagine). Parte solo quando la ricerca
  testuale è finita E l'utente apre davvero la tab, e genera un'immagine alla volta lato server
  (~20-40s ciascuna): niente Pollinations/altri servizi anonimi, si era rivelato troppo rate-limitato
  per un uso affidabile (max 1 richiesta in coda per IP).
- **"Ask Silvy"**: chat persistente (bottone flottante, sempre visibile) con una persona AI a parte,
  "Silvy" (prompt in `prompts.js`, endpoint `POST /api/chat`, modello `SILVY_MODEL`). Non è collegata
  alla ricerca: se le parli di te, ti risponde davvero come un'amica/mentore (calore vero se percepisce
  stress, pungente e competitiva se percepisce sicurezza/arroganza); solo se le fai una domanda "da
  motore di ricerca" risponde nello stesso stile satirico del resto di Aivlis, ma con la sua voce.
  **Eccezione di sicurezza**: su salute/medicina, violenza, autolesionismo, minori o gruppi protetti non
  inventa mai una risposta falsa (nemmeno come battuta) — lì risponde con informazioni vere o consiglia
  di sentire un professionista. Questa eccezione vale solo per Silvy: la ricerca principale può ancora
  toccare temi come la salute in chiave satirica/assurda (è il concept dell'app, es. "cos'è un
  meganoma"), l'eccezione serve perché in una chat conversazionale che a tratti dà consigli reali il
  confine tra "vero" e "battuta" è più labile che in una pagina di risultato chiaramente satirica.

## Setup

1. Crea una API key gratuita su https://openrouter.ai/keys e una su https://console.groq.com/keys
   (nessuna carta richiesta per nessuna delle due). Puoi usarne anche solo una: basta lasciare vuota
   l'altra e non elencare modelli di quel provider in `MODELS`/`FALLBACK_MODELS`.
2. Copia `.env.example` in `.env` e inserisci `OPENROUTER_API_KEY` e/o `GROQ_API_KEY`
3. Controlla/aggiorna le liste `MODELS` e `FALLBACK_MODELS` in `.env` (formato `provider:model-id`):
   i modelli gratuiti disponibili cambiano nel tempo, verifica su
   https://openrouter.ai/models?max_price=0 e https://console.groq.com/docs/models
4. Installa le dipendenze:

   ```
   npm install
   ```

5. Avvia il server:

   ```
   npm start
   ```

6. Apri http://localhost:3000

## Deploy (Render)

Il progetto include un `render.yaml` per un deploy senza troppi passaggi manuali. Serve un host con un
processo Node persistente (non serverless): le ricerche e soprattutto le immagini restano aperte per
minuti (SSE), i tempi di esecuzione dei serverless (Vercel/Netlify Functions) sono troppo brevi per
questo caso d'uso.

1. Vai su https://render.com, registrati (gratis) e collega il tuo account GitHub.
2. "New" → "Blueprint", seleziona questa repo: Render legge `render.yaml` e pre-compila build command
   (`npm install`), start command (`npm start`) e le variabili di configurazione non sensibili.
3. Ti chiederà di inserire manualmente `OPENROUTER_API_KEY`, `GROQ_API_KEY` e `OPENROUTER_SITE_URL`
   (quest'ultima puoi lasciarla vuota al primo deploy e aggiornarla dopo con l'URL che Render ti assegna,
   tipo `https://aivlis.onrender.com` — serve solo per l'header di attribuzione verso OpenRouter, non è
   critica).
4. Deploy. Il piano free di Render mette il servizio "in sleep" dopo un periodo di inattività: la prima
   richiesta dopo lo sleep impiega qualche secondo in più a svegliarsi.

**Attenzione se condividi il link**: chi usa l'app consuma le tue chiavi/quota (limite giornaliero
OpenRouter/Groq condiviso tra tutti, e la tab Immagini costa centesimi reali sul tuo saldo OpenRouter).
Il progetto non ha autenticazione: chiunque abbia il link può usarlo.

## Note

- Progetto pensato per uso locale/personale, non per produzione: niente autenticazione, niente rate
  limiting, cache/cronologia volatili (in memoria/localStorage, senza persistenza server-side).
- Se un modello (e il suo eventuale fallback) fallisce o va in timeout (60s), il risultato corrispondente
  viene semplicemente scartato dalla lista invece di bloccare gli altri.
- Il numero di "pagine" per ricerca corrisponde al numero di modelli elencati in `MODELS`.
- **Limite giornaliero OpenRouter**: con una API key a credito $0, l'account è limitato a **50 richieste
  al giorno** su tutti i modelli gratuiti combinati (non per singolo modello). Una volta esaurito, ogni
  modello (e ogni fallback) fallirà con lo stesso errore `429 free-models-per-day` finché non si
  resetta (o finché non aggiungi credito su OpenRouter). Il server riconosce questo caso specifico, non
  ritenta né cerca un fallback (sarebbe inutile), e mostra un messaggio dedicato nell'interfaccia.
- **Groq** ha limiti gratuiti molto più generosi (es. i modelli `openai/gpt-oss-*`: 1.000 richieste/
  giorno) e un'inferenza tra le più veloci in assoluto, oltre a un rate limit per-minuto (non solo
  giornaliero): un 429 di Groq viene quindi ritentato normalmente (a differenza del limite giornaliero
  di OpenRouter, quasi certamente transitorio). I limiti sono per account, non per singola chiave.
  Il catalogo modelli di Groq cambia spesso (alcuni vengono deprecati) — verifica quali sono
  disponibili sulla tua chiave con `curl https://api.groq.com/openai/v1/models -H "Authorization:
  Bearer $GROQ_API_KEY"` prima di aggiornare `MODELS`/`FALLBACK_MODELS`.
- **Tab Immagini e limite di spesa**: l'endpoint `/api/v1/images` di OpenRouter è bloccato per
  qualunque modello (anche a costo $0 come `IMAGE_MODEL`) se la tua chiave ha un limite di spesa
  mensile pari a $0 (default per chiavi nuove) — è un cancello di sicurezza a livello di categoria
  "modelli a pagamento", non legato al costo reale della singola chiamata. Per sbloccarlo: vai su
  https://openrouter.ai/settings/keys, apri la chiave in uso e alza il limite mensile anche solo a
  $1. Restando su un modello a costo $0 quel limite non verrà mai eroso. Verifica lo stato con
  `curl https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"` (campo
  `limit`). Il catalogo di `/api/v1/images/models` cambia spesso quanto quello chat: verificalo con
  `curl https://openrouter.ai/api/v1/images/models -H "Authorization: Bearer $OPENROUTER_API_KEY"`
  prima di cambiare `IMAGE_MODEL` — non tutti i modelli elencati sono text-to-image puri (alcuni,
  come le varianti "-layer", richiedono un'immagine di partenza da modificare, non generano da zero).
