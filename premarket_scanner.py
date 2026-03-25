#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════╗
║   VORT — Volumetric Opening Range Tracker                       ║
║   Pre-Market Scanner  |  Modulo A                               ║
║                                                                  ║
║   Calcola la baseline volumetrica (mediana) per la fascia        ║
║   09:30–10:00 EST per i 50 ticker S&P 500 con il maggiore        ║
║   score composito di gap% e volume assoluto.                     ║
║                                                                  ║
║   Strategia ottimizzazione chiamate API EODHD:                   ║
║     1. Lista S&P 500 da EODHD GSPC.INDX  →  1 API call         ║
║     2. Bulk EOD US exchange              →  1 API call          ║
║     3. Intraday 5min × max 50 ticker     → 50 API calls         ║
║     TOTALE: ~52 chiamate                                         ║
║                                                                  ║
║   Output:                                                        ║
║     baseline.json  — dati baseline per il frontend              ║
║     manifest.json  — cache-busting per GitHub Pages CDN         ║
╚══════════════════════════════════════════════════════════════════╝
"""

import os
import json
import time
import logging
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Optional

# ============================================================
# [00] CONFIGURAZIONE LOGGING
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger(__name__)


# ============================================================
# [01] PARAMETRI CONFIGURABILI
# ============================================================
API_KEY         = os.environ.get("EODHD_API_KEY", "")

# Path output — in un repo GitHub questo è la root
OUTPUT_DIR      = os.path.dirname(os.path.abspath(__file__))
BASELINE_FILE   = os.path.join(OUTPUT_DIR, "baseline.json")
MANIFEST_FILE   = os.path.join(OUTPUT_DIR, "manifest.json")

# Screener
TOP_N_TICKERS   = 50         # Limite dettato dal WebSocket EODHD

# Baseline storica
LOOKBACK_DAYS   = 30         # Sedute di trading per il calcolo
INTERVAL        = "5m"       # Candele a 5 minuti (78 bar/giorno)
MIN_VALID_DAYS  = 10         # Minimo giorni validi per baseline affidabile
MIN_CANDLES_DAY = 3          # Candele minime per considerare una seduta valida

# Opening Range window (EST / EDT — gestita automaticamente da zoneinfo)
OR_START_TIME   = "09:30"
OR_END_TIME     = "09:55"    # Ultima candela 5m inizia alle 09:55 (chiude 10:00)

# Rate limiting: EODHD consente 1000 req/min → 0.12s = ~500 req/min con margine
API_DELAY       = 0.12

EASTERN         = ZoneInfo("America/New_York")


# ============================================================
# [02] LISTA S&P 500 — da EODHD Index Components (1 API call)
# ============================================================
def get_sp500_tickers(api_key: str) -> list[str]:
    """
    Recupera la lista aggiornata dei componenti S&P 500 tramite l'endpoint
    EODHD per i componenti degli indici (fundamentals/GSPC.INDX).

    Endpoint: GET /api/fundamentals/GSPC.INDX?filter=Components&fmt=json
    Risposta: dict { "AAPL": {"Code": "AAPL", "Name": "Apple Inc", ...}, ... }

    Normalizzazione ticker:
        'BRK.B' → 'BRK-B'  (punto → trattino, formato EODHD per il bulk EOD)

    Fallback chain:
        1. EODHD GSPC.INDX Components  (primario — affidabile in CI/CD)
        2. Wikipedia read_html          (fallback locale — bloccato da GitHub Actions)
        3. Lista hardcoded top-50       (emergenza assoluta)

    Args:
        api_key: Token EODHD (necessario per l'endpoint primario)

    Returns:
        Lista di stringhe ticker (es. ['AAPL', 'MSFT', 'BRK-B', ...])
    """
    # ── Primario: EODHD Index Components API ──
    log.info("📋 Fetching S&P 500 constituents from EODHD (GSPC.INDX)...")
    try:
        url = "https://eodhd.com/api/fundamentals/GSPC.INDX"
        params = {
            "api_token": api_key,
            "filter":    "Components",
            "fmt":       "json",
        }
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        components = resp.json()   # dict: ticker → { Code, Name, Exchange, ... }

        if not components or not isinstance(components, dict):
            raise ValueError("Risposta EODHD vuota o formato inatteso")

        # Estrai i ticker dal campo "Code" di ogni voce; fallback alla chiave del dict
        tickers = [
            v.get("Code", k).replace(".", "-")
            for k, v in components.items()
        ]
        tickers = [t for t in tickers if t]  # rimuovi stringhe vuote
        log.info(f"✅ S&P 500 da EODHD: {len(tickers)} ticker")
        time.sleep(API_DELAY)
        return tickers

    except Exception as e:
        log.warning(f"⚠️  EODHD GSPC.INDX fallito: {e}. Provo Wikipedia...")

    # ── Fallback: Wikipedia (funziona in locale, bloccata in GitHub Actions) ──
    try:
        tables = pd.read_html(
            "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
            attrs={"id": "constituents"}
        )
        tickers = tables[0]["Symbol"].str.replace(".", "-", regex=False).tolist()
        log.info(f"✅ S&P 500 da Wikipedia: {len(tickers)} ticker")
        return tickers
    except Exception as e2:
        log.error(f"❌ Wikipedia fallita: {e2}. Uso lista hardcoded di emergenza.")

    # ── Emergenza: top-50 per capitalizzazione (hardcoded) ──
    log.warning("⚠️  Usando lista hardcoded (50 titoli). Qualità screening ridotta.")
    return [
        "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA",
        "BRK-B", "JPM", "UNH", "V", "XOM", "LLY", "AVGO", "MA", "JNJ",
        "PG", "HD", "COST", "MRK", "ABBV", "CVX", "KO", "PEP", "WMT",
        "BAC", "PFE", "AMD", "INTC", "NFLX", "DIS", "ADBE", "CRM", "CSCO",
        "TMO", "ACN", "ABT", "DHR", "TXN", "NEE", "PM", "RTX", "HON",
        "UPS", "QCOM", "IBM", "GE", "CAT", "BA"
    ]


# ============================================================
# [03] BULK EOD — 1 CHIAMATA API PER TUTTO L'EXCHANGE US
# ============================================================
def fetch_bulk_eod_us(api_key: str) -> pd.DataFrame:
    """
    Scarica i prezzi EOD dell'ultimo giorno disponibile per TUTTI i
    titoli dell'exchange US in una singola chiamata API.

    Questo è il punto di forza architetturale: invece di fare 500
    chiamate per i singoli componenti S&P 500, una sola risposta
    copre l'intero mercato.

    Args:
        api_key: Token EODHD

    Returns:
        DataFrame con colonne: code, ticker, open, close,
        previousClose, volume, change_p (gap%)
    """
    log.info("📡 Bulk EOD US — 1 API call per ~8.000 titoli...")
    url = "https://eodhd.com/api/eod-bulk-last-day/US"
    params = {
        "api_token": api_key,
        "fmt":       "json",
        # Nota: non usiamo filter=extended perché il campo 'previousClose'
        # non è garantito nella risposta bulk. Lo screener gestisce
        # l'assenza di previousClose con fallback su solo volume.
    }

    resp = requests.get(url, params=params, timeout=60)
    resp.raise_for_status()
    df = pd.DataFrame(resp.json())

    # Normalizza: rimuovi suffisso '.US' dal campo code per match con lista SP500
    if "code" in df.columns:
        df["ticker"] = df["code"].str.replace(r"\.US$", "", regex=True)

    log.info(f"✅ Bulk EOD ricevuto: {len(df):,} titoli US")
    return df


# ============================================================
# [04] SCREENER — TOP 50 MOVER S&P 500
# ============================================================
def screen_top_movers(
    bulk_df: pd.DataFrame,
    sp500_tickers: list[str],
    top_n: int = TOP_N_TICKERS
) -> pd.DataFrame:
    """
    Filtra il bulk EOD ai soli componenti S&P 500 e seleziona i top N
    per score composito di gap% assoluto e volume assoluto.

    Score composito (basato su percentile rank interno al paniere):
        score = 0.60 × vol_rank + 0.40 × gap_rank

    Motivazione dei pesi:
        - Il volume è il segnale primario di interesse istituzionale
        - Il gap% cattura l'effetto news/catalizzatore
        - Ponderazione 60/40 privilegia liquidità su volatilità pura

    Nota: l'RVOL pre-market richiederebbe 500 chiamate storiche aggiuntive.
    Il proxy volume-assoluto + gap% è sufficiente per identificare i titoli
    con maggiore probabilità di anomalia volumetrica nell'Opening Range.

    Args:
        bulk_df:       Output di fetch_bulk_eod_us()
        sp500_tickers: Lista componenti S&P 500
        top_n:         Numero ticker da selezionare (max 50 per WebSocket)

    Returns:
        DataFrame con i top_n ticker con colonne aggiuntive: gap_pct, score
    """
    log.info(f"🔍 Screening top {top_n} tra {len(sp500_tickers)} componenti S&P 500...")

    # Filtra ai soli componenti dell'indice
    df = bulk_df[bulk_df["ticker"].isin(sp500_tickers)].copy()
    log.info(f"   Match S&P 500 nel bulk EOD: {len(df)} ticker")

    if df.empty:
        raise ValueError("Nessun ticker S&P 500 trovato nel bulk EOD. Verifica l'exchange.")

    # Log diagnostico: mostra le colonne effettivamente ricevute dal bulk EOD
    log.info(f"   Colonne bulk EOD disponibili: {list(df.columns)}")

    # Pulizia base: rimuovi righe senza volume
    for col in ["open", "volume"]:
        if col not in df.columns:
            df[col] = np.nan
    df = df.dropna(subset=["volume"])
    df = df[pd.to_numeric(df["volume"], errors="coerce").fillna(0) > 0]
    df["volume"] = pd.to_numeric(df["volume"], errors="coerce")

    # Percentile rank volume — sempre disponibile
    df["vol_rank"] = df["volume"].rank(pct=True)

    # ── Gap%: opzionale, richiede previousClose ──
    # Il campo 'previousClose' non è presente nel bulk EOD standard.
    # Se disponibile, arricchisce lo score composito (60/40 vol/gap).
    # Se assente, lo score si basa al 100% sul volume (proxy di liquidità).
    has_prev_close = (
        "previousClose" in df.columns
        and pd.to_numeric(df["previousClose"], errors="coerce").notna().sum() > 0
    )

    if has_prev_close:
        df["previousClose"] = pd.to_numeric(df["previousClose"], errors="coerce")
        df["open"]          = pd.to_numeric(df["open"],          errors="coerce")
        df = df[(df["previousClose"] > 0) & df["previousClose"].notna()]
        df["gap_pct"]  = ((df["open"] - df["previousClose"]) / df["previousClose"] * 100).abs()
        df["gap_rank"] = df["gap_pct"].rank(pct=True)
        df["score"]    = 0.60 * df["vol_rank"] + 0.40 * df["gap_rank"]
        log.info("   📐 Score composito: 60% volume + 40% gap%")
    else:
        df["gap_pct"] = 0.0
        df["score"]   = df["vol_rank"]
        log.warning("   ⚠️  previousClose assente nel bulk EOD — score basato solo su volume")

    # Colonna prev_close per il frontend (usa close come proxy se previousClose assente)
    if not has_prev_close:
        close_col = "adjusted_close" if "adjusted_close" in df.columns else "close"
        if close_col in df.columns:
            df["previousClose"] = pd.to_numeric(df[close_col], errors="coerce")
        else:
            df["previousClose"] = 0.0

    top_df = df.nlargest(top_n, "score").reset_index(drop=True)

    log.info(f"✅ {len(top_df)} ticker selezionati")
    log.info(f"   Top 5 per score: {top_df['ticker'].head(5).tolist()}")
    if has_prev_close:
        log.info(f"   Gap% medio top {top_n}: {top_df['gap_pct'].mean():.2f}%")

    return top_df


# ============================================================
# [05] BASELINE INTRADAY — MEDIANA VOLUME 09:30–10:00
# ============================================================
def fetch_intraday_baseline(
    ticker: str,
    api_key: str,
    lookback_days: int = LOOKBACK_DAYS
) -> Optional[float]:
    """
    Scarica lo storico intraday a 5 minuti e calcola la MEDIANA del
    volume cumulato nella fascia 09:30–09:59 EST per le ultime
    `lookback_days` sedute di trading.

    Perché la mediana invece della media:
        La media è fortemente influenzata da giornate anomale (earnings,
        annunci Fed, circuit breaker). La mediana rappresenta il
        'volume tipico' dell'Opening Range, rendendo il segnale RVOL
        molto più robusto operativamente.

    Args:
        ticker:        Simbolo (senza suffisso, es. 'AAPL')
        api_key:       Token EODHD
        lookback_days: Numero di sedute per la baseline

    Returns:
        Mediana del volume Opening Range (float), o None se dati
        insufficienti o errore API.
    """
    # Calcola i timestamp Unix per la finestra temporale
    # Moltiplica per 1.8 per compensare weekend e festività USA
    # (30 sedute ≈ 42 giorni calendario, usiamo 55 per margine sicuro)
    now_est  = datetime.now(EASTERN)
    to_dt    = now_est - timedelta(days=1)
    from_dt  = now_est - timedelta(days=int(lookback_days * 1.8) + 5)

    from_ts = int(from_dt.timestamp())
    to_ts   = int(to_dt.timestamp())

    url = f"https://eodhd.com/api/intraday/{ticker}.US"
    params = {
        "interval":  INTERVAL,
        "api_token": api_key,
        "fmt":       "json",
        "from":      from_ts,
        "to":        to_ts,
    }

    try:
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        if not data:
            log.warning(f"   ⚠️  {ticker}: risposta API vuota")
            return None

        df = pd.DataFrame(data)
        df["datetime"] = pd.to_datetime(df["datetime"])
        df["volume"]   = pd.to_numeric(df["volume"], errors="coerce").fillna(0)

        # === TIMEZONE HANDLING ===
        # EODHD restituisce datetime in UTC senza tz info.
        # Localizza in UTC poi converti in Eastern (gestisce automaticamente EST/EDT).
        if df["datetime"].dt.tz is None:
            df["datetime"] = df["datetime"].dt.tz_localize("UTC").dt.tz_convert(EASTERN)
        else:
            df["datetime"] = df["datetime"].dt.tz_convert(EASTERN)

        df = df.set_index("datetime").sort_index()

        # === FILTRO OPENING RANGE: 09:30 – 09:59 EST ===
        or_start = pd.Timestamp(OR_START_TIME).time()
        or_end   = pd.Timestamp(OR_END_TIME).time()

        mask_or = (
            (df.index.time >= or_start) &
            (df.index.time <= or_end)
        )
        df_or = df[mask_or].copy()

        if df_or.empty:
            log.warning(f"   ⚠️  {ticker}: nessun dato nella finestra 09:30–10:00")
            return None

        # === AGGREGAZIONE GIORNALIERA ===
        df_or = df_or.copy()
        df_or["date"] = df_or.index.date

        # Volume totale Opening Range per ogni giornata
        daily_vol     = df_or.groupby("date")["volume"].sum()
        # Conta candele per giornata — scarta sedute con dati parziali
        daily_candles = df_or.groupby("date")["volume"].count()

        valid_dates = daily_candles[daily_candles >= MIN_CANDLES_DAY].index
        daily_vol   = daily_vol[daily_vol.index.isin(valid_dates)]

        # Usa solo le ultime `lookback_days` sedute valide disponibili
        daily_vol = daily_vol.tail(lookback_days)

        if len(daily_vol) < MIN_VALID_DAYS:
            log.warning(
                f"   ⚠️  {ticker}: solo {len(daily_vol)} sedute valide "
                f"(minimo richiesto: {MIN_VALID_DAYS})"
            )
            return None

        # MEDIANA — robusto agli outlier di earnings/eventi macro
        baseline_vol = float(daily_vol.median())
        return baseline_vol

    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response else "?"
        log.error(f"   ❌ {ticker}: HTTP {code}")
        return None

    except Exception as e:
        log.error(f"   ❌ {ticker}: errore — {type(e).__name__}: {e}")
        return None


# ============================================================
# [06] ORCHESTRAZIONE PRINCIPALE
# ============================================================
def run_premarket_scanner():
    """
    Entry point: orchestra l'intero flusso pre-market e produce
    baseline.json e manifest.json nella root del repository.

    Flusso:
        1. Validazione API key
        2. Fetch lista S&P 500 da EODHD GSPC.INDX  (1 API call)
        3. Bulk EOD US                       (1 API call)
        4. Screener top 50 movers S&P 500
        5. Baseline intraday per 50 ticker   (max 50 API calls)
        6. Export baseline.json + manifest.json
    """
    run_start = datetime.now(timezone.utc)

    log.info("=" * 62)
    log.info("  VORT — Volumetric Opening Range Tracker")
    log.info(f"  Pre-Market Scanner | {run_start.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    log.info("=" * 62)

    # --- Validazione API Key ---
    if not API_KEY:
        raise EnvironmentError(
            "EODHD_API_KEY non trovata. "
            "Imposta il secret su GitHub Actions o la variabile d'ambiente locale."
        )

    # === STEP 1: Lista S&P 500 (1 API call via EODHD GSPC.INDX) ===
    sp500_tickers = get_sp500_tickers(API_KEY)

    # === STEP 2: Bulk EOD (1 API call) ===
    bulk_df = fetch_bulk_eod_us(API_KEY)
    time.sleep(API_DELAY)

    # === STEP 3: Screener ===
    top_df = screen_top_movers(bulk_df, sp500_tickers, top_n=TOP_N_TICKERS)

    # Dizionario ticker → prev_close (usato dal frontend per calcolare Δ%)
    prev_close_map = dict(zip(
        top_df["ticker"],
        top_df["previousClose"].round(2)
    ))
    selected_tickers = top_df["ticker"].tolist()

    # === STEP 4 & 5: Baseline intraday ===
    log.info(
        f"\n📊 Calcolo baseline per {len(selected_tickers)} ticker | "
        f"Intervallo: {INTERVAL} | Fascia: {OR_START_TIME}–{OR_END_TIME} EST | "
        f"Lookback: {LOOKBACK_DAYS} sedute\n"
    )

    baseline_data: dict = {}
    failed_tickers: list = []

    for idx, ticker in enumerate(selected_tickers, start=1):
        log.info(f"   [{idx:02d}/{len(selected_tickers)}] {ticker:<8} — calcolo baseline...")

        vol_baseline = fetch_intraday_baseline(ticker, API_KEY, LOOKBACK_DAYS)

        if vol_baseline is not None and vol_baseline > 0:
            baseline_data[ticker] = {
                "avg_open_vol": int(vol_baseline),   # mediana volume OR (nome mantenuto per compatibilità frontend)
                "prev_close":   prev_close_map.get(ticker, 0.0)
            }
            log.info(
                f"             ✅ Mediana OR vol: {int(vol_baseline):>12,} | "
                f"Prev Close: ${prev_close_map.get(ticker, 0):.2f}"
            )
        else:
            failed_tickers.append(ticker)
            log.warning(f"             ⚠️  Ticker escluso per dati insufficienti")

        # Rate limiting — rispetta quota EODHD
        time.sleep(API_DELAY)

    # === STEP 6: Export ===
    if not baseline_data:
        raise RuntimeError(
            "Nessun ticker con baseline valida. "
            "Controlla la connessione, il piano EODHD e i log sopra."
        )

    now_utc = datetime.now(timezone.utc)

    # ---- baseline.json ----
    # Struttura consumata da app.js per calcolare RVOL% in tempo reale
    with open(BASELINE_FILE, "w", encoding="utf-8") as fh:
        json.dump(baseline_data, fh, indent=2)

    # ---- manifest.json ----
    # Usato dal frontend per cache-busting GitHub Pages CDN.
    # Il campo 'version' è un timestamp numerico inserito come query param
    # nella fetch di baseline.json, forzando il CDN a servire il file fresco.
    manifest = {
        "generated_at":  now_utc.isoformat(),
        "trading_date":  now_utc.strftime("%Y-%m-%d"),
        "ticker_count":  len(baseline_data),
        "version":       now_utc.strftime("%Y%m%d%H%M"),  # es. "202603251300"
        "tickers":       list(baseline_data.keys())
    }
    with open(MANIFEST_FILE, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    # === Summary ===
    elapsed = (datetime.now(timezone.utc) - run_start).seconds
    total_api_calls = 1 + len(selected_tickers)  # bulk + intraday

    log.info("\n" + "=" * 62)
    log.info(f"  ✅ Scanner completato in {elapsed}s")
    log.info(f"  📊 Ticker nella baseline: {len(baseline_data)}/{len(selected_tickers)}")
    log.info(f"  📡 Chiamate API totali:   ~{total_api_calls} (target: <60)")
    if failed_tickers:
        log.info(f"  ⚠️  Ticker falliti ({len(failed_tickers)}): {', '.join(failed_tickers)}")
    log.info(f"  📁 Output: baseline.json, manifest.json")
    log.info("=" * 62)


# ============================================================
# ENTRY POINT
# ============================================================
if __name__ == "__main__":
    run_premarket_scanner()
