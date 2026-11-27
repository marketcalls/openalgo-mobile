"""Golden harness: the server's own Python services on recorded /api/v1 replies (design 9.2).

    python scripts/golden/harness.py --server <dir> --in <inputs> --out <expected>

Run it in the server's own uv environment, as npm run gen-golden does.

For each test/golden/inputs/<source>-<case>.json it writes the same name under --out:
  routes      the five session routes the phone answers (body and status);
  legs        calculate_greeks for every priced leg of chain 25 at F = its underlying_ltp;
  withGreeks  calculate_chain_greeks on chain 25, as the optionchain with_greeks mode runs it.
It also writes black76.json, a synthetic opengreeks grid with no recording.

The server runs isolated: its .sample.env with every *DATABASE_URL in a temporary folder,
which is also the working directory, and no socket may connect. The chain, futures and quote
fetches answer from the recording (lookup by request key); datetime.now in
option_greeks_service is frozen at the input's serverNowMs. A fetch with no recorded answer
stops the run, since the server would otherwise turn it into a 500 golden.
"""

import argparse
import copy
import json
import logging
import math
import os
import socket
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from itertools import product
from pathlib import Path
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
LEGS_CHAIN = 25
API_KEY = "golden-harness"  # never sent anywhere: every fetch is patched
ROUTES = (
    ("get_oi_data", "oi_tracker_service"),
    ("calculate_max_pain", "oi_tracker_service"),
    ("get_iv_smile_data", "iv_smile_service"),
    ("get_gex_data", "gex_service"),
    ("calculate_gamma_density", "gamma_density_service"),
)
CHAIN_FETCHERS = (
    "option_chain_service",
    "oi_tracker_service",
    "gex_service",
    "iv_smile_service",
    "gamma_density_service",
)


class Missing(BaseException):
    """A fetch with no recorded answer. Not an Exception, so the services cannot swallow it."""


def instant(ms):
    return EPOCH + timedelta(milliseconds=ms)


def ist_ms(y, mo, d, h, mi):
    return int((datetime(y, mo, d, h, mi, tzinfo=IST) - EPOCH) / timedelta(milliseconds=1))


def request_key(endpoint, body):
    """scripts/lib/golden-keys.mjs requestKey: keys sorted at every depth, no whitespace."""
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return f"{endpoint} {text}"


def options_exchange(exchange):
    """The options exchange, as iv_smile_service and gex_service derive it."""
    ex = exchange.upper()
    return {"NSE_INDEX": "NFO", "NSE": "NFO", "BSE_INDEX": "BFO", "BSE": "BFO"}.get(ex, ex)


def isolate(server, tmp):
    from dotenv import dotenv_values

    for name, value in dotenv_values(Path(server, ".sample.env")).items():
        if value is None:
            continue
        if name.endswith("DATABASE_URL"):
            # sqlite URLs become files in `tmp`; HISTORIFY's DuckDB path a file there too
            file = Path(tmp, Path(value.removeprefix("sqlite:///")).name)
            value = f"sqlite:///{file}" if value.startswith("sqlite:") else str(file)
        os.environ[name] = value
    # A valid per-install salt, so auth_db does not warn about the legacy one.
    os.environ["FERNET_SALT"] = "00" * 16

    def refuse(self, *args, **kwargs):
        raise OSError("the golden harness allows no network")

    socket.socket.connect = refuse
    os.chdir(tmp)
    sys.path.insert(0, server)


def load_services():
    from services import (
        gamma_density_service,
        gex_service,
        iv_smile_service,
        oi_tracker_service,
        option_chain_service,
        option_greeks_service,
    )

    logging.disable(logging.CRITICAL)
    return {
        "option_chain_service": option_chain_service,
        "oi_tracker_service": oi_tracker_service,
        "gex_service": gex_service,
        "iv_smile_service": iv_smile_service,
        "gamma_density_service": gamma_density_service,
        "option_greeks_service": option_greeks_service,
    }


def freeze_clock(svc, now_ms):
    """datetime.now in option_greeks_service (calculate_time_to_expiry) reads `now_ms`."""

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            at = instant(now_ms)
            return at.astimezone(tz) if tz else at.astimezone(IST).replace(tzinfo=None)

    svc["option_greeks_service"].datetime = Frozen


class Recording:
    def __init__(self, data):
        self.data = data
        self.responses = {}
        for key, body in data["responses"].items():
            endpoint, _, raw = key.partition(" ")
            self.responses[request_key(endpoint, json.loads(raw))] = body

    def get(self, endpoint, body):
        key = request_key(endpoint, body)
        if key not in self.responses:
            raise Missing(f"no recorded reply for {key}")
        return copy.deepcopy(self.responses[key])

    def futures(self):
        body = {"symbol": self.data["underlying"], "exchange": self.data["exchange"]}
        return self.get("expiry", {**body, "instrumenttype": "futures"}).get("data") or []


def install(svc, rec):
    """Patches every fetch the five routes make to answer from `rec`."""
    served = {}

    def chain_fetch(module):
        def get_option_chain(
            underlying,
            exchange,
            expiry_date,
            strike_count,
            api_key,
            with_quotes=True,
            with_greeks=False,
            interest_rate=None,
        ):
            body = {
                "underlying": underlying,
                "exchange": exchange,
                "expiry_date": expiry_date,
                "strike_count": strike_count,
            }
            if with_greeks:
                body["with_greeks"] = True
            reply = rec.get("optionchain", body)
            served[module] = reply
            return True, copy.deepcopy(reply), 200

        return get_option_chain

    for module in CHAIN_FETCHERS:
        svc[module].get_option_chain = chain_fetch(module)

    def fno_search_symbols(
        query=None,
        exchange=None,
        expiry=None,
        instrumenttype=None,
        strike_min=None,
        strike_max=None,
        underlying=None,
        limit=10000,
    ):
        wanted = (rec.data["underlying"], rec.data["exchange"], "FUT")
        asked = (
            (underlying or "").strip().upper(),
            exchange,
            (instrumenttype or "").strip().upper(),
        )
        if query is not None or asked != wanted:
            raise Missing(f"no recorded symbols for {asked}")
        rows = [
            {
                "symbol": f"{rec.data['underlying']}{d.replace('-', '')}FUT",
                "name": rec.data["underlying"],
                "exchange": rec.data["exchange"],
                "expiry": d,
                "instrumenttype": "FUT",
            }
            for d in rec.futures()
        ]
        if expiry:
            rows = [r for r in rows if r["expiry"] == expiry.strip()]
        return rows[:limit]

    def get_quotes(symbol, exchange, api_key):
        return True, rec.get("quotes", {"symbol": symbol, "exchange": exchange}), 200

    oi = svc["oi_tracker_service"]
    oi.fno_search_symbols = fno_search_symbols
    oi.get_quotes = get_quotes

    def resolve_forward_price(
        base_symbol, opt_exchange, underlying_exchange, expiry, api_key, synth_cache=None
    ):
        """The phone's forward: round(K + C - P, 2) of the same chain's ATM row
        (synthetic_future_service.py:152,173), or None (spot) when a leg or its ltp is missing."""
        reply = served.get("gamma_density_service")
        if reply is None:
            raise Missing("the forward was asked before the gamma density chain")
        atm = reply.get("atm_strike")
        row = next((r for r in reply.get("chain", []) if r.get("strike") == atm), None)
        if not row or not row.get("ce") or not row.get("pe"):
            return None
        call, put = row["ce"].get("ltp"), row["pe"].get("ltp")
        if call is None or put is None:
            return None
        return round(atm + call - put, 2)

    svc["gamma_density_service"]._resolve_forward_price = resolve_forward_price


def run_case(svc, data):
    rec = Recording(data)
    install(svc, rec)
    freeze_clock(svc, data["serverNowMs"])
    u, x, e = data["underlying"], data["exchange"], data["expiry"]

    routes = {}
    for name, module in ROUTES:
        route = getattr(svc[module], name)
        _ok, body, status = route(underlying=u, exchange=x, expiry_date=e, api_key=API_KEY)
        routes[name] = {"status": status, "body": body}

    asked = {"underlying": u, "exchange": x, "expiry_date": e, "strike_count": LEGS_CHAIN}
    chain = rec.get("optionchain", asked)
    rows = chain.get("chain", [])
    ox = options_exchange(x)
    greeks = svc["option_greeks_service"]
    legs = []
    for row in rows:
        for leg in (row.get("ce"), row.get("pe")):
            if not leg or not leg.get("symbol") or not (leg.get("ltp") or 0) > 0:
                continue
            _ok, body, status = greeks.calculate_greeks(
                option_symbol=leg["symbol"],
                exchange=ox,
                spot_price=chain["underlying_ltp"],
                option_price=leg["ltp"],
            )
            legs.append(
                {
                    "symbol": leg["symbol"],
                    "exchange": ox,
                    "spot": chain["underlying_ltp"],
                    "price": leg["ltp"],
                    "status": status,
                    "body": body,
                }
            )

    forward = svc["option_chain_service"]._forward_from_chain(
        rows, chain.get("atm_strike"), chain.get("underlying_ltp")
    )
    years, days = greeks.calculate_time_to_expiry(greeks.get_expiry_datetime(e, ox))
    ce, pe = greeks.calculate_chain_greeks(
        [row["strike"] for row in rows],
        [(row.get("ce") or {}).get("ltp", 0) for row in rows],
        [(row.get("pe") or {}).get("ltp", 0) for row in rows],
        forward,
        years,
        None,
    )
    with_greeks = {
        "forward": forward,
        "years": years,
        "days": days,
        "rows": [
            {"strike": row["strike"], "ce": c, "pe": p}
            for row, c, p in zip(rows, ce, pe, strict=True)
        ],
    }
    return {
        "case": data["case"],
        "source": data["source"],
        "serverNowMs": data["serverNowMs"],
        "underlying": u,
        "exchange": x,
        "expiry": e,
        "routes": routes,
        "legs": legs,
        "withGreeks": with_greeks,
    }


# --- black76.json: the synthetic grid ------------------------------------------------

FLAGS = ("c", "p")
FORWARDS = (100, 24000, 52000)
MONEYNESS = (0.8, 0.9, 0.97, 1, 1.03, 1.1, 1.2)
TENORS = (1e-4, 2 / 365, 7 / 365, 30 / 365, 0.5)
SIGMAS = (0.08, 0.15, 0.3, 0.8)
RATE = 0  # DEFAULT_INTEREST_RATES: 0 on every exchange

WEEK = 7 / 365
EDGES = (
    ("below intrinsic", "c", 24000, 23000, WEEK, 900),
    ("below intrinsic", "p", 24000, 25000, WEEK, 900),
    ("at the maximum", "c", 24000, 24000, WEEK, 24000),
    ("at the maximum", "p", 24000, 25000, WEEK, 25000),
    ("above the maximum", "c", 24000, 24000, WEEK, 24001),
    ("above the maximum", "p", 24000, 25000, WEEK, 25001),
    ("0.05 deep out of the money", "c", 24000, 28800, WEEK, 0.05),
    ("0.05 deep out of the money", "p", 24000, 19200, WEEK, 0.05),
    ("0.05 deep out of the money", "c", 52000, 57200, 2 / 365, 0.05),
)

# calculate_greeks cases: (label, symbol, exchange, spot, price, now), now in IST
WEEK_OUT = ist_ms(2026, 12, 22, 10, 0)
EXPIRY_DAY = (2026, 12, 29)
SYMBOLS = (
    ("ATM call a week out", "NIFTY29DEC2624000CE", "NFO", 24010.5, 180.35, WEEK_OUT),
    ("deep ITM, no time value", "NIFTY29DEC2623000CE", "NFO", 24010.5, 1008.0, WEEK_OUT),
    ("price at the maximum (F)", "NIFTY29DEC2624000CE", "NFO", 24010.5, 24010.5, WEEK_OUT),
    ("price above the maximum", "NIFTY29DEC2624000CE", "NFO", 24010.5, 24500.0, WEEK_OUT),
    (
        "expiry day after the cut-off",
        "NIFTY29DEC2624000PE",
        "NFO",
        24010.5,
        30.5,
        ist_ms(*EXPIRY_DAY, 15, 45),
    ),
    (
        "expiry day 30 min before the cut-off",
        "NIFTY29DEC2624000PE",
        "NFO",
        24010.5,
        12.4,
        ist_ms(*EXPIRY_DAY, 15, 0),
    ),
    (
        "MCX after 15:30, before its 23:30 cut-off",
        "CRUDEOIL16DEC266000CE",
        "MCX",
        5980.0,
        45.2,
        ist_ms(2026, 12, 16, 20, 0),
    ),
    (
        "CDS before its 12:30 cut-off",
        "USDINR29DEC2683.50CE",
        "CDS",
        83.42,
        0.21,
        ist_ms(*EXPIRY_DAY, 11, 0),
    ),
    ("an ampersand in the underlying", "M&M29DEC263500PE", "NFO", 3550.0, 42.3, WEEK_OUT),
    ("a hyphen in the underlying", "BAJAJ-AUTO29DEC269000CE", "NFO", 8950.0, 120.75, WEEK_OUT),
    ("BFO", "SENSEX24DEC2680000CE", "BFO", 79850.0, 410.6, WEEK_OUT),
    ("not an option symbol", "NIFTY24000CE", "NFO", 24010.5, 100.0, WEEK_OUT),
)


def finite(v):
    return v if v is not None and math.isfinite(v) else None


def solve(black76, price, F, K, t, flag):
    """opengreeks implied_volatility, or (None, its error)."""
    try:
        iv = black76.implied_volatility(price, F, K, RATE, t, flag)
    except Exception as err:
        return None, str(err)
    return (finite(iv), None if finite(iv) is not None else "not finite")


def black76_golden(svc):
    from opengreeks import black76

    grid = []
    for flag, F, m, t, sigma in product(FLAGS, FORWARDS, MONEYNESS, TENORS, SIGMAS):
        K = round(F * m, 2)
        price = black76.black(flag, F, K, t, RATE, sigma)
        iv, error = solve(black76, price, F, K, t, flag)
        args = (flag, F, K, t, RATE, sigma)
        grid.append(
            {
                "flag": flag,
                "F": F,
                "K": K,
                "t": t,
                "sigma": sigma,
                "price": price,
                "iv": iv,
                "ivError": error,
                "delta": black76.delta(*args),
                "gamma": black76.gamma(*args),
                "theta": black76.theta(*args),
                "vega": black76.vega(*args),
            }
        )
    edges = []
    for label, flag, F, K, t, price in EDGES:
        iv, error = solve(black76, price, F, K, t, flag)
        edges.append(
            {"label": label, "flag": flag, "F": F, "K": K, "t": t, "price": price}
            | {"iv": iv, "error": error}
        )
    symbols = []
    greeks = svc["option_greeks_service"]
    for label, symbol, exchange, spot, price, now_ms in SYMBOLS:
        freeze_clock(svc, now_ms)
        _ok, body, status = greeks.calculate_greeks(
            option_symbol=symbol, exchange=exchange, spot_price=spot, option_price=price
        )
        symbols.append(
            {
                "label": label,
                "symbol": symbol,
                "exchange": exchange,
                "spot": spot,
                "price": price,
                "nowMs": now_ms,
                "status": status,
                "body": body,
            }
        )
    return {"rate": RATE, "grid": grid, "edges": edges, "symbols": symbols}


def write(path, data):
    text = json.dumps(data, indent=2, allow_nan=False, ensure_ascii=False)
    path.write_text(f"{text}\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--server", required=True, help="the openalgo server tree at openalgo.ref")
    parser.add_argument("--in", dest="inputs", required=True, help="test/golden/inputs")
    parser.add_argument("--out", required=True, help="test/golden/expected")
    args = parser.parse_args()
    server = str(Path(args.server).resolve())
    inputs = Path(args.inputs).resolve()
    out = Path(args.out).resolve()

    home = os.getcwd()
    with tempfile.TemporaryDirectory(prefix="openalgo-golden-") as tmp:
        isolate(server, tmp)
        svc = load_services()
        out.mkdir(parents=True, exist_ok=True)
        written = set()
        failed = False
        for path in sorted(inputs.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            try:
                result = run_case(svc, data)
            except Missing as err:
                print(f"{path.name}: {err}", file=sys.stderr)
                failed = True
                continue
            write(out / path.name, result)
            written.add(path.name)
            print(f"{path.name}: {len(result['routes'])} routes, {len(result['legs'])} legs")
        write(out / "black76.json", black76_golden(svc))
        written.add("black76.json")
        print("black76.json: synthetic grid")
        for stale in out.glob("*.json"):
            if stale.name not in written and not failed:
                stale.unlink()
        os.chdir(home)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
