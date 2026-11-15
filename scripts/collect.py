#!/usr/bin/env python3
"""Genera snapshot statici da ViaggiaTreno per GitHub Pages.

Nessun servizio di backend: eseguito da GitHub Actions; il browser legge solo JSON.
Gli endpoint ViaggiaTreno sono non ufficiali e non garantiti.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
OUT = ROOT / "_site"
CACHE = ROOT / "_cache" / "stations.json"
CONFIG = ROOT / "config" / "monitor.json"
SOURCE_URLS = (
    "https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno",
    "http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno",
)
ITALY = ZoneInfo("Europe/Rome")
REGIONS = range(1, 23)
STATION_CODE = re.compile(r"^S\d{5}$")
LOG = logging.getLogger("treni")


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize(value: object) -> str:
    raw = unicodedata.normalize("NFD", str(value or ""))
    raw = "".join(c for c in raw if unicodedata.category(c) != "Mn")
    return " ".join(re.findall(r"[A-Z0-9]+", raw.upper()))


def fetch(endpoint: str, *, expect_json: bool = True):
    """Fetch con limite dimensione/tempo e fallback di protocollo."""
    last_error: Exception | None = None
    for base in SOURCE_URLS:
        url = base + "/" + endpoint.lstrip("/")
        req = Request(url, headers={
            "User-Agent": "TreniGitHubPages/1.0 (unofficial, periodic station snapshots)",
            "Accept": "application/json,text/plain,*/*",
        })
        try:
            with urlopen(req, timeout=8) as response:
                raw = response.read(5_000_001)
                if len(raw) > 5_000_000:
                    raise ValueError("risposta troppo grande")
                content = raw.decode("utf-8-sig", errors="replace")
                if expect_json:
                    return json.loads(content)
                return content
        except (HTTPError, URLError, TimeoutError, ValueError, OSError, json.JSONDecodeError) as exc:
            last_error = exc
    raise RuntimeError(f"Endpoint non disponibile: {endpoint} ({last_error})")


def parse_stations(values: object) -> list[dict]:
    """Estrae id/nome da /elencoStazioni e /cercaStazione."""
    if not isinstance(values, list):
        return []
    stations = []
    for item in values:
        if not isinstance(item, dict):
            continue
        place = item.get("localita")
        if not isinstance(place, dict):
            place = item
        station_id = item.get("codiceStazione") or item.get("id") or place.get("id")
        name = place.get("nomeLungo") or item.get("nomeLungo") or item.get("name")
        if isinstance(station_id, str) and STATION_CODE.fullmatch(station_id) and isinstance(name, str) and name.strip():
            stations.append({"id": station_id, "name": name.strip().upper()})
    return stations


def parse_autocomplete(text: str) -> list[dict]:
    result = []
    for line in text.splitlines():
        if "|" not in line:
            continue
        name, station_id = line.rsplit("|", 1)
        if STATION_CODE.fullmatch(station_id.strip()) and name.strip():
            result.append({"id": station_id.strip(), "name": name.strip().upper()})
    return result


def seed_catalog(names: list[str]) -> list[dict]:
    """Piano B: risolve le singole stazioni se il catalogo regionale fallisce."""
    found: dict[str, dict] = {}
    for name in names:
        try:
            query = quote(name, safe="")
            values = parse_autocomplete(fetch("autocompletaStazione/" + query, expect_json=False))
            exact = [x for x in values if normalize(x["name"]) == normalize(name)]
            selected = exact or [x for x in values if normalize(name) in normalize(x["name"])]
            for station in selected[:4]:
                found[station["id"]] = station
        except Exception as exc:
            LOG.warning("Risoluzione stazione %s fallita: %s", name, exc)
    return list(found.values())


def load_catalog(names: list[str]) -> list[dict]:
    cached: list[dict] = []
    if CACHE.exists():
        try:
            raw = json.loads(CACHE.read_text(encoding="utf-8"))
            cached = parse_stations(raw.get("stations")) if isinstance(raw, dict) else parse_stations(raw)
            if cached:
                LOG.info("Catalogo dalla cache: %s stazioni", len(cached))
                return cached
        except (ValueError, OSError) as exc:
            LOG.warning("Cache non valida: %s", exc)

    catalog: dict[str, dict] = {}
    successes = 0
    consecutive_failures = 0
    for region in REGIONS:
        try:
            entries = parse_stations(fetch(f"elencoStazioni/{region}"))
            if entries:
                successes += 1
                consecutive_failures = 0
                for item in entries:
                    catalog[item["id"]] = item
            else:
                consecutive_failures += 1
                LOG.warning("Regione %s: elenco vuoto/non valido", region)
        except Exception as exc:
            consecutive_failures += 1
            LOG.warning("Regione %s: %s", region, exc)
        if consecutive_failures >= 4 and not successes:
            LOG.error("Catalogo non raggiungibile: interrompo i tentativi regionali")
            break
        time.sleep(0.08)

    # Risolvi i nomi configurati anche quando le stazioni mancano dal catalogo regionale.
    known_names = {normalize(s["name"]) for s in catalog.values()}
    missing = [name for name in names if normalize(name) not in known_names]
    for item in seed_catalog(missing):
        catalog[item["id"]] = item

    stations = sorted(catalog.values(), key=lambda s: (s["name"], s["id"]))
    LOG.info("Catalogo: %s stazioni, %s regioni valide", len(stations), successes)
    # Solo una raccolta regionale consistente entra nella cache giornaliera.
    # Se fallisce la fonte, il prossimo run può riprovare.
    if successes >= 17 and len(stations) >= 200:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps({"stations": stations}, ensure_ascii=False), encoding="utf-8")
    return stations


def monitored_ids(catalog: list[dict], names: list[str]) -> tuple[list[dict], list[str]]:
    by_name: dict[str, list[dict]] = {}
    for station in catalog:
        by_name.setdefault(normalize(station["name"]), []).append(station)
    selected: list[dict] = []
    unresolved: list[str] = []
    seen = set()
    for name in names:
        candidates = by_name.get(normalize(name), [])
        # Nomi non identici fra servizi: accetta una corrispondenza unica e prossima.
        if not candidates:
            candidates = [s for s in catalog if normalize(name) in normalize(s["name"])]
            if len(candidates) != 1:
                candidates = []
        if not candidates:
            unresolved.append(name)
            continue
        station = candidates[0]
        if station["id"] not in seen:
            selected.append(station)
            seen.add(station["id"])
    return selected, unresolved


def local_clock_ms(ms: object) -> str | None:
    try:
        if ms is None:
            return None
        value = float(ms)
        if value < 100000000000:
            return None
        return datetime.fromtimestamp(value / 1000, tz=ITALY).strftime("%H:%M")
    except (ValueError, OverflowError, TypeError, OSError):
        return None


def safe_time(value: object) -> str | None:
    if isinstance(value, str):
        matched = re.search(r"(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)", value)
        if matched:
            return f"{int(matched.group(1)):02d}:{matched.group(2)}"
    return None


def nonempty(value: object) -> str | None:
    if isinstance(value, str) and value.strip() and value.strip() not in ("--", "null"):
        return value.strip()[:100]
    return None


def normalize_train(record: dict, direction: str) -> dict | None:
    try:
        number = str(int(record.get("numeroTreno")))
        if not re.fullmatch(r"\d{1,6}", number):
            return None
    except (TypeError, ValueError, OverflowError):
        return None
    is_departure = direction == "departures"
    clock_key = "compOrarioPartenza" if is_departure else "compOrarioArrivo"
    millis_key = "orarioPartenza" if is_departure else "orarioArrivo"
    scheduled = safe_time(record.get(clock_key)) or local_clock_ms(record.get(millis_key))
    if scheduled is None:
        scheduled = local_clock_ms(record.get("partenzaTreno")) if is_departure else None
    origin = nonempty(record.get("origine")) or nonempty(record.get("stazionePartenza"))
    destination = nonempty(record.get("destinazione")) or nonempty(record.get("stazioneArrivo"))
    other = destination if is_departure else origin
    actual_prefix = "binarioEffettivoPartenza" if is_departure else "binarioEffettivoArrivo"
    planned_prefix = "binarioProgrammatoPartenza" if is_departure else "binarioProgrammatoArrivo"
    actual = nonempty(record.get(actual_prefix + "Descrizione")) or nonempty(record.get(actual_prefix + "Codice"))
    planned = nonempty(record.get(planned_prefix + "Descrizione")) or nonempty(record.get(planned_prefix + "Codice"))
    raw_delay = record.get("ritardo")
    delay = round(raw_delay) if isinstance(raw_delay, (float, int)) and not isinstance(raw_delay, bool) else None
    category = (nonempty(record.get("categoriaDescrizione"))
                or nonempty(record.get("categoria"))
                or "Treno")
    status = record.get("provvedimento")
    day = nonempty(record.get("dataPartenzaTrenoAsDate"))
    return {
        "number": number,
        "category": category,
        "scheduled": scheduled,
        "delay": delay,
        "cancelled": status == 1,
        "partiallyCancelled": status == 2,
        "notDeparted": bool(record.get("nonPartito")),
        "platform": actual,
        "platformPlanned": planned,
        "other": other,
        "origin": origin,
        "destination": destination,
        "serviceDate": day,
    }


def fetch_board(station: dict, direction: str, moment: datetime) -> list[dict]:
    endpoint = "partenze" if direction == "departures" else "arrivi"
    # Formato locale documentato per l'endpoint non ufficiale.
    stamp = moment.strftime("%a %b %d %Y %H:%M:%S")
    path = f"{endpoint}/{station['id']}/{quote(stamp, safe='')}"
    items = fetch(path)
    if not isinstance(items, list):
        raise ValueError(f"{endpoint}: risposta JSON non è un array")
    normalized = []
    for item in items[:150]:
        if isinstance(item, dict):
            result = normalize_train(item, direction)
            if result:
                normalized.append(result)
    return normalized


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def collect() -> int:
    names = json.loads(CONFIG.read_text(encoding="utf-8")).get("stations", [])
    if not isinstance(names, list) or not names or any(not isinstance(x, str) for x in names):
        raise ValueError("config/monitor.json: stations deve essere una lista di nomi")
    names = list(dict.fromkeys(names))[:40]
    catalog = load_catalog(names)
    selected, unresolved = monitored_ids(catalog, names)
    if unresolved:
        LOG.warning("Stazioni non risolte: %s", ", ".join(unresolved))
    selected_ids = {s["id"] for s in selected}
    for item in catalog:
        item["monitored"] = item["id"] in selected_ids

    if not catalog:
        LOG.error("Catalogo completamente indisponibile: il sito mostrerà lo stato di errore.")
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(PUBLIC, OUT)
    # Il sito si trova nella sottodirectory GitHub Pages /Treni/ (path relativi).
    write_json(OUT / "data" / "stations.json", {
        "generatedAt": now_utc(), "stations": catalog,
        "catalogComplete": len(catalog) >= 200,
    })
    moment = datetime.now(ITALY)
    snapshots: dict[str, dict] = {}
    ok_boards = 0
    errors = 0
    for station in selected:
        LOG.info("Recupero %s (%s)", station["name"], station["id"])
        boards: dict[str, object] = {}
        failed: list[str] = []
        for direction in ("departures", "arrivals"):
            try:
                boards[direction] = fetch_board(station, direction, moment)
                ok_boards += 1
            except Exception as exc:
                failed.append(direction)
                boards[direction] = None
                errors += 1
                LOG.warning("%s %s: %s", station["name"], direction, exc)
            time.sleep(0.12)
        snapshots[station["id"]] = {
            "id": station["id"], "name": station["name"],
            "status": "ok" if not failed else ("partial" if len(failed) == 1 else "error"),
            "updatedAt": now_utc() if len(failed) < 2 else None,
            "departures": boards["departures"],
            "arrivals": boards["arrivals"],
            "errors": failed,
        }
    generated = now_utc()
    write_json(OUT / "data" / "live.json", {
        "generatedAt": generated,
        "source": "ViaggiaTreno (endpoint non ufficiali)",
        "intervalMinutes": 15,
        "status": "ok" if ok_boards == 2 * len(selected) and selected
                  else "partial" if ok_boards else "error",
        "monitored": len(selected),
        "unresolved": unresolved,
        "stations": snapshots,
    })
    LOG.info("Terminato: %s tabelloni validi, %s errori, %s stazioni", ok_boards, errors, len(selected))
    return 0  # Pubblica lo stato anche se ViaggiaTreno è indisponibile.


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        return collect()
    except Exception:
        LOG.exception("Raccolta fallita")
        # Il workflow non pubblica dati ambigui in caso di errore del codice.
        return 1


if __name__ == "__main__":
    sys.exit(main())
