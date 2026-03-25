/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  VORT — Volumetric Opening Range Tracker                        ║
 * ║  Frontend Logic  |  Modulo C                                    ║
 * ║                                                                  ║
 * ║  Responsabilità:                                                 ║
 * ║    1. Gestione token EODHD via localStorage (primo accesso)     ║
 * ║    2. Cache-busting fetch baseline via manifest.json            ║
 * ║    3. WebSocket EODHD con riconnessione automatica              ║
 * ║    4. Aggregazione volume tick-by-tick + Delta Volume            ║
 * ║    5. Calcolo RVOL% in tempo reale                              ║
 * ║    6. Aggiornamento DOM throttled (1.5s) — evita reflow eccessivi║
 * ║    7. Ordinamento tabella per RVOL% decrescente                 ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

// ============================================================
// [01] CONFIGURAZIONE
// ============================================================

const CONFIG = {
  // Chiave localStorage per il token EODHD
  TOKEN_STORAGE_KEY: 'vort_eodhd_token',

  // WebSocket EODHD (US equities)
  WS_URL: 'wss://ws.eodhistoricaldata.com/ws/us',

  // Intervalli
  DOM_UPDATE_INTERVAL_MS: 1500,    // Throttle aggiornamento tabella (1.5s)
  TICK_ACTIVITY_TTL_MS:  3000,    // Indicatore "tick attivo" si spegne dopo 3s
  RECONNECT_DELAY_MS:    3000,    // Attesa prima di riconnessione WebSocket
  RECONNECT_MAX_ATTEMPTS: 10,     // Tentativi max riconnessione

  // Opening Range window
  OR_START_HOUR:   9,
  OR_START_MIN:   30,
  OR_END_HOUR:   10,
  OR_END_MIN:     0,

  // Soglie RVOL per color coding
  RVOL_EXTREME:  200,   // > 200%: verde brillante
  RVOL_HIGH:     150,   // > 150%: verde
  RVOL_NORMAL:   100,   // > 100%: bianco

  // Ticker con attività recente (ms): dopo questo tempo il dot si spegne
  ACTIVITY_TIMEOUT_MS: 4000,
};

// ============================================================
// [02] STATO DELL'APPLICAZIONE
// ============================================================

const STATE = {
  // Dati baseline caricati dal JSON
  baseline: {},          // { AAPL: { avg_open_vol: 15000000, prev_close: 175.50 }, ... }
  baselineDate: null,    // Data generazione baseline (da manifest.json)

  // Stato live per ogni ticker
  // live[ticker] = { cumVol, buyVol, sellVol, lastPrice, lastUpdate, openPrice }
  live: {},

  // Contatori globali
  totalTicks: 0,

  // WebSocket
  ws: null,
  wsReconnectAttempts: 0,
  wsConnected: false,

  // Timer DOM update (throttle)
  domUpdateTimer: null,

  // Flag finestra Opening Range
  orbActive: false,
  orbClosed: false,    // Diventa true dopo le 10:00 — congela la display

  // Orario apertura (per Δ% dal prev_close)
  sessionOpenTime: null,
};

// ============================================================
// [03] TOKEN MANAGEMENT — localStorage
// ============================================================

/**
 * Recupera il token EODHD dal localStorage.
 * @returns {string|null} Token o null se non impostato.
 */
function getToken() {
  return localStorage.getItem(CONFIG.TOKEN_STORAGE_KEY);
}

/**
 * Salva il token nel localStorage dopo validazione minima.
 * @param {string} token
 * @returns {boolean} true se salvato correttamente.
 */
function saveToken(token) {
  const clean = (token || '').trim();
  if (clean.length < 8) return false;
  localStorage.setItem(CONFIG.TOKEN_STORAGE_KEY, clean);
  return true;
}

/**
 * Rimuove il token e ricarica la pagina per reset completo.
 */
function resetToken() {
  if (confirm('Rimuovere il token EODHD salvato?\nLa pagina verrà ricaricata.')) {
    localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
    window.location.reload();
  }
}

/**
 * Mostra il modal di inserimento token (primo accesso).
 */
function showTokenModal() {
  const modal = document.getElementById('token-modal');
  modal.style.removeProperty('display');   // rimuove l'!important inline
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('token-input').focus(), 100);
}

/**
 * Nasconde il modal token.
 */
function hideTokenModal() {
  const modal = document.getElementById('token-modal');
  modal.style.setProperty('display', 'none', 'important');
}

// ============================================================
// [04] BOOT — Punto di avvio post-DOM
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // --- Bind bottone reset token (header) ---
  document.getElementById('reset-token-btn').addEventListener('click', resetToken);

  // --- Bind modal token ---
  const saveBtn  = document.getElementById('token-save-btn');
  const tokenIn  = document.getElementById('token-input');
  const showChk  = document.getElementById('token-show');
  const tokenErr = document.getElementById('token-error');

  // Toggle visibilità password
  showChk.addEventListener('change', () => {
    tokenIn.type = showChk.checked ? 'text' : 'password';
  });

  // Enter nel campo input salva il token
  tokenIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
  });

  // Bottone salva
  saveBtn.addEventListener('click', () => {
    const val = tokenIn.value.trim();
    tokenErr.classList.add('hidden');

    if (!saveToken(val)) {
      tokenErr.classList.remove('hidden');
      tokenIn.focus();
      return;
    }
    hideTokenModal();
    initVORT(val);
  });

  // --- Check token esistente ---
  const existingToken = getToken();
  if (existingToken) {
    // Token già presente: avvio diretto
    initVORT(existingToken);
  } else {
    // Primo accesso: mostra modal
    showTokenModal();
  }
});

// ============================================================
// [05] INIT — Caricamento baseline e avvio WebSocket
// ============================================================

/**
 * Inizializza VORT: carica la baseline e avvia la connessione WS.
 * @param {string} token  Token EODHD
 */
async function initVORT(token) {
  updateWsBadge('LOADING', 'loading');
  startClockTicker();

  try {
    await loadBaseline();
    startDomUpdateLoop();
    connectWebSocket(token);
  } catch (err) {
    showBanner(
      `❌ Errore caricamento baseline: ${err.message}. ` +
      `Verifica che il workflow GitHub Actions sia stato eseguito oggi.`,
      'error'
    );
    updateWsBadge('ERR BASELINE', 'error');
  }
}

// ============================================================
// [06] CACHE-BUSTING BASELINE — manifest.json → baseline.json
// ============================================================

/**
 * Carica la baseline in due step per evitare il caching CDN di GitHub Pages:
 *
 *   Step A: fetch manifest.json?t=<now>
 *            Verifica che la data corrisponda a oggi e ottiene il version string.
 *
 *   Step B: fetch baseline.json?v=<version>
 *            Il query param `v` forza il CDN a servire il file aggiornato.
 *
 * @throws {Error} Se manifest o baseline non sono disponibili / date errate.
 */
async function loadBaseline() {
  const now       = Date.now();
  const todayUTC  = new Date().toISOString().slice(0, 10);  // 'YYYY-MM-DD'

  // ── Step A: manifest ──
  const manifestResp = await fetch(`manifest.json?t=${now}`);
  if (!manifestResp.ok) {
    throw new Error(`manifest.json non trovato (HTTP ${manifestResp.status}). Il workflow Actions è stato eseguito?`);
  }

  const manifest = await manifestResp.json();

  // Warning se la baseline è di un giorno diverso da oggi
  // (es. workflow fallito, festività, weekend)
  if (manifest.trading_date !== todayUTC) {
    showBanner(
      `⚠️ Baseline generata il <strong>${manifest.trading_date}</strong> (attesa oggi: ${todayUTC}). ` +
      `Il workflow potrebbe non essersi eseguito. I dati RVOL potrebbero non essere aggiornati.`,
      'warning'
    );
  }

  STATE.baselineDate = manifest.generated_at;
  updateEl('stat-baseline-date', manifest.trading_date || '—');

  // ── Step B: baseline con version string ──
  const version      = manifest.version || now;
  const baselineResp = await fetch(`baseline.json?v=${version}`);
  if (!baselineResp.ok) {
    throw new Error(`baseline.json non trovato (HTTP ${baselineResp.status}).`);
  }

  STATE.baseline = await baselineResp.json();
  const tickers  = Object.keys(STATE.baseline);

  if (tickers.length === 0) {
    throw new Error('baseline.json è vuoto. Il pre-market scanner ha completato correttamente?');
  }

  // Inizializza lo stato live per ogni ticker
  tickers.forEach(ticker => {
    STATE.live[ticker] = {
      cumVol:      0,
      buyVol:      0,
      sellVol:     0,
      lastPrice:   STATE.baseline[ticker].prev_close || 0,
      openPrice:   STATE.baseline[ticker].prev_close || 0,  // aggiornato al primo tick
      lastTick:    0,   // timestamp ultimo tick (ms)
      orbCumVol:   0,   // volume accumulato solo nella finestra OR
    };
  });

  updateEl('ticker-count', tickers.length);
  console.log(`[VORT] Baseline caricata: ${tickers.length} ticker`);
}

// ============================================================
// [07] WEBSOCKET — Connessione e riconnessione automatica
// ============================================================

/**
 * Apre la connessione WebSocket EODHD e registra tutti gli handler.
 * In caso di chiusura inattesa, riconnette automaticamente con
 * backoff lineare fino a RECONNECT_MAX_ATTEMPTS tentativi.
 *
 * IMPORTANTE: il volume cumulato (STATE.live[t].cumVol) NON viene
 * resettato al reconnect — questo preserva i dati già accumulati
 * dall'apertura della sessione anche in caso di disconnessioni temporanee.
 *
 * @param {string} token  Token EODHD
 */
function connectWebSocket(token) {
  const url = `${CONFIG.WS_URL}?api_token=${encodeURIComponent(token)}`;

  console.log('[VORT] WebSocket: connessione in corso...');
  updateWsBadge('CONNECTING', 'loading');

  const ws = new WebSocket(url);
  STATE.ws = ws;

  // ── onopen ──
  ws.addEventListener('open', () => {
    console.log('[VORT] WebSocket: connesso ✅');
    STATE.wsConnected          = true;
    STATE.wsReconnectAttempts  = 0;
    updateWsBadge('LIVE', 'live');

    // Sottoscrivi tutti i ticker della baseline (max 50 per limite EODHD)
    const symbols = Object.keys(STATE.baseline).slice(0, 50).join(',');
    ws.send(JSON.stringify({
      action:  'subscribe',
      symbols: symbols,
    }));

    console.log(`[VORT] Sottoscritti ${symbols.split(',').length} ticker`);
  });

  // ── onmessage ──
  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);

      // EODHD invia messaggi di status (es. auth_ok, subscribe_ok)
      if (data.status_code || data.message) {
        console.log('[VORT] WS message:', data.message || data.status_code);
        return;
      }

      // Tick di prezzo: { s: 'AAPL', p: 175.50, v: 200, t: 1710000000000 }
      if (data.s && data.p !== undefined) {
        onTick(data);
      }
    } catch (err) {
      // Ignora messaggi malformati senza bloccare il loop
      console.warn('[VORT] Messaggio WS non parsabile:', event.data);
    }
  });

  // ── onerror ──
  ws.addEventListener('error', (err) => {
    console.error('[VORT] WebSocket errore:', err);
    updateWsBadge('ERROR', 'error');
    STATE.wsConnected = false;
  });

  // ── onclose ──
  ws.addEventListener('close', (event) => {
    STATE.wsConnected = false;
    console.warn(`[VORT] WebSocket chiuso (code: ${event.code})`);

    // Non riconnettere se la chiusura è intenzionale (code 1000/1001)
    // o se la finestra ORB è chiusa e non ha senso continuare
    if (event.code === 1000 || STATE.orbClosed) {
      updateWsBadge('CLOSED', 'closed');
      return;
    }

    // Riconnessione con backoff lineare
    if (STATE.wsReconnectAttempts < CONFIG.RECONNECT_MAX_ATTEMPTS) {
      STATE.wsReconnectAttempts++;
      const delay = CONFIG.RECONNECT_DELAY_MS * STATE.wsReconnectAttempts;
      updateWsBadge(`RETRY ${STATE.wsReconnectAttempts}/${CONFIG.RECONNECT_MAX_ATTEMPTS}`, 'warning');
      console.log(`[VORT] Riconnessione tra ${delay / 1000}s...`);
      setTimeout(() => connectWebSocket(token), delay);
    } else {
      updateWsBadge('DISCONNECTED', 'error');
      showBanner(
        `⚠️ WebSocket disconnesso dopo ${CONFIG.RECONNECT_MAX_ATTEMPTS} tentativi. ` +
        `Ricarica la pagina per riprovare.`,
        'warning'
      );
    }
  });
}

// ============================================================
// [08] PROCESSAMENTO TICK — Aggregazione + Delta Volume
// ============================================================

/**
 * Processa un singolo tick ricevuto dal WebSocket EODHD.
 *
 * Delta Volume (Tick Rule):
 *   - tick.price > lastPrice  → Buy Volume  (acquirente aggressivo)
 *   - tick.price < lastPrice  → Sell Volume (venditore aggressivo)
 *   - tick.price === lastPrice → volume neutro, suddiviso 50/50
 *     (convenzione comune quando il classificatore è ambiguo)
 *
 * Nota metodologica: la Tick Rule è una semplificazione rispetto
 * al vero order flow. Non distingue market orders da limit orders.
 * Usare come proxy direzionale, non come misura assoluta.
 *
 * @param {{ s: string, p: number, v: number, t: number }} tick
 */
function onTick(tick) {
  const ticker = tick.s;

  // Ignora ticker non nella baseline (arrivi sporadici fuori lista)
  if (!STATE.live[ticker]) return;

  const price  = parseFloat(tick.p) || 0;
  const vol    = parseInt(tick.v,  10) || 0;
  const lv     = STATE.live[ticker];

  // ── Aggiorna open price se è il primo tick della sessione ──
  if (lv.cumVol === 0 && price > 0) {
    lv.openPrice = price;
  }

  // ── Accumula volume totale (NON resettare su reconnect) ──
  lv.cumVol  += vol;
  STATE.totalTicks++;

  // ── Delta Volume: Tick Rule ──
  if (price > lv.lastPrice && lv.lastPrice > 0) {
    // Tick rialzista: acquirente aggressivo
    lv.buyVol += vol;
  } else if (price < lv.lastPrice && lv.lastPrice > 0) {
    // Tick ribassista: venditore aggressivo
    lv.sellVol += vol;
  } else {
    // Neutro: suddivisione 50/50 (tick invariato o primo tick)
    lv.buyVol  += Math.floor(vol / 2);
    lv.sellVol += vol - Math.floor(vol / 2);
  }

  // ── Aggiorna stato ──
  lv.lastPrice  = price;
  lv.lastTick   = Date.now();

  // ── Accumulo OR window (solo 09:30–10:00) ──
  const { orbActive } = checkORBWindow();
  if (orbActive) {
    lv.orbCumVol += vol;
  }
}

// ============================================================
// [09] CALCOLI — RVOL, Δ%, finestra ORB
// ============================================================

/**
 * Calcola il RVOL% per un ticker: volume live cumulato / baseline mediana.
 * Restituisce il valore "assoluto" (% della baseline 30min raggiunta finora).
 *
 * @param {string} ticker
 * @returns {number} RVOL in percentuale (es. 75.3 = 75.3%)
 */
function calcRVOL(ticker) {
  const bsl     = STATE.baseline[ticker];
  const lv      = STATE.live[ticker];
  if (!bsl || !lv || bsl.avg_open_vol === 0) return 0;
  return (lv.cumVol / bsl.avg_open_vol) * 100;
}

/**
 * Calcola la percentuale Buy vs Sell del delta volume.
 * @param {string} ticker
 * @returns {{ buyPct: number, sellPct: number }}
 */
function calcDeltaPct(ticker) {
  const lv = STATE.live[ticker];
  if (!lv) return { buyPct: 0, sellPct: 0 };
  const total = lv.buyVol + lv.sellVol;
  if (total === 0) return { buyPct: 50, sellPct: 50 };
  return {
    buyPct:  (lv.buyVol  / total) * 100,
    sellPct: (lv.sellVol / total) * 100,
  };
}

/**
 * Verifica lo stato della finestra Opening Range in base all'ora EST/EDT.
 * Usa Intl.DateTimeFormat per la conversione timezone senza librerie esterne.
 *
 * @returns {{ orbActive: boolean, minutesLeft: number, phase: string }}
 */
function checkORBWindow() {
  const now      = new Date();
  const estParts = new Intl.DateTimeFormat('en-US', {
    timeZone:    'America/New_York',
    hour:        'numeric',
    minute:      'numeric',
    hour12:      false,
  }).formatToParts(now);

  const h = parseInt(estParts.find(p => p.type === 'hour').value,   10);
  const m = parseInt(estParts.find(p => p.type === 'minute').value, 10);
  const totalMin = h * 60 + m;

  const ORB_START = CONFIG.OR_START_HOUR * 60 + CONFIG.OR_START_MIN;   // 570 = 09:30
  const ORB_END   = CONFIG.OR_END_HOUR   * 60 + CONFIG.OR_END_MIN;     // 600 = 10:00

  const orbActive  = totalMin >= ORB_START && totalMin < ORB_END;
  const minutesLeft = orbActive ? ORB_END - totalMin : 0;

  let phase;
  if (totalMin < ORB_START)      phase = 'pre-market';
  else if (orbActive)            phase = 'active';
  else                           phase = 'closed';

  return { orbActive, minutesLeft, phase, h, m };
}

// ============================================================
// [10] DOM UPDATE — Throttled (ogni 1.5s)
// ============================================================

/**
 * Avvia il loop di aggiornamento DOM con intervallo throttled.
 * Questo evita di ricalcolare e ridisegnare la tabella ad ogni tick
 * (che su 50 ticker può arrivare a centinaia di eventi/secondo).
 */
function startDomUpdateLoop() {
  STATE.domUpdateTimer = setInterval(renderTable, CONFIG.DOM_UPDATE_INTERVAL_MS);
}

/**
 * Renderizza la tabella completa: calcola RVOL% per ogni ticker,
 * ordina per RVOL% decrescente, aggiorna celle e indicatori visivi.
 */
function renderTable() {
  const tbody      = document.getElementById('table-body');
  const emptyRow   = document.getElementById('empty-row');
  const tickers    = Object.keys(STATE.baseline);

  if (tickers.length === 0) return;

  // Nascondi riga placeholder
  if (emptyRow) emptyRow.style.display = 'none';

  // ── Calcola metriche per ogni ticker ──
  const rows = tickers.map(ticker => {
    const bsl   = STATE.baseline[ticker];
    const lv    = STATE.live[ticker] || {};
    const rvol  = calcRVOL(ticker);
    const delta = calcDeltaPct(ticker);
    const prevC = bsl.prev_close || 0;
    const price = lv.lastPrice   || prevC;
    const pctChange = prevC > 0 ? ((price - prevC) / prevC) * 100 : 0;
    const isActive  = (Date.now() - (lv.lastTick || 0)) < CONFIG.ACTIVITY_TIMEOUT_MS;

    return { ticker, bsl, lv, rvol, delta, price, prevC, pctChange, isActive };
  });

  // ── Ordina per RVOL% decrescente ──
  rows.sort((a, b) => b.rvol - a.rvol);

  // ── Aggiorna stats bar ──
  const { phase, minutesLeft } = checkORBWindow();
  const anomalies = rows.filter(r => r.rvol > 150).length;

  updateEl('stat-anomalies', anomalies);
  renderORBStatus(phase, minutesLeft);
  updateEl('stat-ticks', STATE.totalTicks.toLocaleString());

  // ── Render righe ──
  rows.forEach((row, idx) => {
    const rowId = `row-${row.ticker}`;
    let tr = document.getElementById(rowId);

    // Crea riga se non esiste ancora
    if (!tr) {
      tr = document.createElement('tr');
      tr.id = rowId;
      tr.className = 'text-right';
      tbody.appendChild(tr);
    }

    const rvolClass = getRvolClass(row.rvol);
    const pctColor  = row.pctChange >= 0 ? 'text-emerald-400' : 'text-red-400';
    const pctSign   = row.pctChange >= 0 ? '+' : '';

    // ── Delta Volume bar ──
    const buyW  = row.delta.buyPct.toFixed(1);
    const sellW = row.delta.sellPct.toFixed(1);
    const deltaColor = row.delta.buyPct > 55
      ? 'text-emerald-400'
      : row.delta.sellPct > 55
        ? 'text-red-400'
        : 'text-gray-400';

    // ── Stato attività tick ──
    const dotClass = row.isActive ? 'tick-active bg-emerald-400' : 'bg-gray-700';

    tr.innerHTML = `
      <td class="px-3 py-2.5 text-left text-muted">${idx + 1}</td>

      <td class="px-3 py-2.5 text-left">
        <span class="text-white font-semibold tracking-wide">${row.ticker}</span>
      </td>

      <td class="px-3 py-2.5">
        <span class="text-gray-200">$${row.price.toFixed(2)}</span>
      </td>

      <td class="px-3 py-2.5">
        <span class="${pctColor}">${pctSign}${row.pctChange.toFixed(2)}%</span>
      </td>

      <td class="px-3 py-2.5 text-gray-300">
        ${formatVolume(row.lv.cumVol || 0)}
      </td>

      <td class="px-3 py-2.5 text-muted">
        ${formatVolume(row.bsl.avg_open_vol || 0)}
      </td>

      <td class="px-3 py-2.5 text-center">
        <span class="px-2 py-0.5 rounded text-xs ${rvolClass}">
          ${row.rvol.toFixed(1)}%
        </span>
      </td>

      <td class="px-3 py-2.5">
        <div class="flex items-center gap-1.5">
          <span class="text-xs ${deltaColor} w-12 text-right">
            B ${row.delta.buyPct.toFixed(0)}%
          </span>
          <div class="delta-bar flex-1">
            <div class="delta-bar-fill-buy" style="width:${buyW}%"></div>
          </div>
          <div class="delta-bar flex-1">
            <div class="delta-bar-fill-sell" style="width:${sellW}%"></div>
          </div>
          <span class="text-xs ${deltaColor} w-12 text-left">
            S ${row.delta.sellPct.toFixed(0)}%
          </span>
        </div>
      </td>

      <td class="px-3 py-2.5 text-center">
        <span class="w-2 h-2 rounded-full inline-block ${dotClass}"></span>
      </td>
    `;
  });
}

// ============================================================
// [11] CLOCK E STATO MERCATO
// ============================================================

/**
 * Avvia il clock EST in tempo reale visibile nell'header.
 * Aggiorna anche lo stato del mercato (Pre-Market / ORB Active / ORB Closed).
 */
function startClockTicker() {
  function tick() {
    const now     = new Date();
    const estStr  = now.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    updateEl('header-clock', `${estStr} EST`);

    const { phase, minutesLeft } = checkORBWindow();
    renderMarketStatus(phase);

    // Segna finestra chiusa per stop riconnessione WS dopo le 10:00
    if (phase === 'closed') STATE.orbClosed = true;
  }

  tick();
  setInterval(tick, 1000);
}

/**
 * Aggiorna il badge stato mercato nell'header.
 * @param {'pre-market'|'active'|'closed'} phase
 */
function renderMarketStatus(phase) {
  const dot    = document.getElementById('market-dot');
  const status = document.getElementById('market-status');

  if (phase === 'active') {
    dot.className    = 'w-2 h-2 rounded-full bg-emerald-400 tick-active';
    status.textContent  = 'ORB ACTIVE';
    status.className    = 'text-emerald-400 font-semibold';
  } else if (phase === 'pre-market') {
    dot.className    = 'w-2 h-2 rounded-full bg-yellow-400';
    status.textContent  = 'PRE-MARKET';
    status.className    = 'text-yellow-400';
  } else {
    dot.className    = 'w-2 h-2 rounded-full bg-gray-500';
    status.textContent  = 'ORB CLOSED';
    status.className    = 'text-muted';
  }
}

/**
 * Aggiorna la stats bar con lo stato della finestra ORB.
 * @param {'pre-market'|'active'|'closed'} phase
 * @param {number} minutesLeft
 */
function renderORBStatus(phase, minutesLeft) {
  const el = document.getElementById('stat-orb-status');
  if (!el) return;

  if (phase === 'active') {
    el.textContent = `ATTIVA — ${minutesLeft}min rimasti`;
    el.className   = `text-sm font-semibold text-emerald-400 ${minutesLeft <= 5 ? 'blink' : ''}`;
  } else if (phase === 'pre-market') {
    el.textContent = 'In attesa (09:30 EST)';
    el.className   = 'text-sm font-semibold text-yellow-400';
  } else {
    el.textContent = 'Chiusa (10:00 EST)';
    el.className   = 'text-sm font-semibold text-muted';
  }
}

// ============================================================
// [12] HELPERS UI
// ============================================================

/**
 * Restituisce la classe CSS corrispondente al livello RVOL%.
 * @param {number} rvol
 * @returns {string}
 */
function getRvolClass(rvol) {
  if (rvol >= CONFIG.RVOL_EXTREME) return 'rvol-extreme';
  if (rvol >= CONFIG.RVOL_HIGH)    return 'rvol-high';
  if (rvol >= CONFIG.RVOL_NORMAL)  return 'rvol-normal';
  return 'rvol-low';
}

/**
 * Formatta un numero intero di volume in forma leggibile:
 * 1.234.567 → '1.23M' | 234.567 → '234.6K' | 567 → '567'
 * @param {number} vol
 * @returns {string}
 */
function formatVolume(vol) {
  if (vol >= 1_000_000) return (vol / 1_000_000).toFixed(2) + 'M';
  if (vol >= 1_000)     return (vol / 1_000).toFixed(1)     + 'K';
  return String(vol);
}

/**
 * Aggiorna il testo di un elemento per ID.
 * @param {string} id
 * @param {string|number} value
 */
function updateEl(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/**
 * Aggiorna il badge WebSocket con stile e label.
 * @param {string} label
 * @param {'live'|'loading'|'error'|'warning'|'closed'} type
 */
function updateWsBadge(label, type) {
  const badge = document.getElementById('ws-badge');
  if (!badge) return;

  const styles = {
    live:    'bg-emerald-900/40 border-emerald-600/50 text-emerald-400',
    loading: 'bg-blue-900/30 border-blue-600/40 text-blue-400',
    error:   'bg-red-900/30 border-red-700/40 text-red-400',
    warning: 'bg-yellow-900/30 border-yellow-700/40 text-yellow-400',
    closed:  'bg-gray-800/40 border-gray-700/40 text-muted',
  };

  badge.className = `px-2 py-0.5 rounded text-xs border ${styles[type] || styles.closed}`;
  badge.textContent = label;
}

/**
 * Mostra un banner informativo sopra la tabella.
 * @param {string} html   Contenuto HTML del messaggio
 * @param {'info'|'warning'|'error'} type
 */
function showBanner(html, type) {
  const banner = document.getElementById('info-banner');
  if (!banner) return;

  const styles = {
    info:    'bg-blue-900/30 border-blue-700/40 text-blue-300',
    warning: 'bg-yellow-900/30 border-yellow-700/40 text-yellow-300',
    error:   'bg-red-900/30 border-red-700/40 text-red-300',
  };

  banner.className = `mb-4 p-4 rounded-lg border text-sm ${styles[type] || styles.info}`;
  banner.innerHTML = html;
  banner.classList.remove('hidden');
}
