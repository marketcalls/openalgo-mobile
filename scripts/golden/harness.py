"""Golden harness: the server's own Python services on recorded /api/v1 replies (design 9.2).

    python scripts/golden/harness.py --server <dir> --in <inputs> --out <expected>

Run it in the server's own uv environment, as npm run gen-golden does.

For each test/golden/inputs/<source>-<case>.json it writes the same name under --out:
  routes      the five session routes the phone answers (body and status);
  legs        calculate_greeks for every priced leg of chain 25 at F = its underlying_ltp;
  withGreeks  calculate_chain_greeks on chain 25, as the optionchain with_greeks mode runs it;
  routesF     plan F's ten tool services (args, body and status), for an input with a master.
An input without plan E's chain 25 (a part-F recording alone) has no routes, legs or
withGreeks. It also writes black76.json, a synthetic opengreeks grid with no recording.

The server runs isolated: its .sample.env with every *DATABASE_URL in a temporary folder,
which is also the working directory, and no socket may connect. Plan E's chain, futures and
quote fetches answer from the recording by request key; datetime.now in option_greeks_service
is frozen at the input's serverNowMs. Plan F's services keep their own logic, with the data
layer patched (install_f): chains and history are served from the superset recording by one
rule (Recording.chain and .history; scripts/lib/golden-record-f.mjs is its twin), quotes per
module (preflight F conflict 6), the master's strikes, futures and near-month future from the
input's master, and datetime frozen at serverNowMs while each runs (conflict 9). A fetch with
no recorded answer stops the run, since the server would otherwise turn it into a 500 golden.
"""

import argparse
import copy
import json
import logging
import math
import os
import re
import socket
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from itertools import product
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
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

# --- Plan F: what the harness asks, as scripts/lib/golden-record-f.mjs F_PARAMS ----------
F_INTERVAL = "5m"
F_STRADDLE_INTERVAL = "1m"
F_PROFILE_EXPIRIES = 6
F_SURFACE_EXPIRIES = 4
F_SURFACE_STRIKES = 40
F_DAYS = {"ivchart": 1, "oiprofile": 5, "straddle": 3, "straddlepnl": 1, "strategy": 3}
F_ADJUSTMENT_POINTS = 50
F_ARBITRAGE_EXCHANGES = ["NFO", "MCX"]
# Strike Profile's and OI Profile's chain, and the builder's
F_CHAIN = 20
F_SERVICES = (
    "strike_profile_service",
    "vol_surface_service",
    "iv_chart_service",
    "oi_profile_service",
    "straddle_chart_service",
    "custom_straddle_service",
    "strategy_chart_service",
    "multi_strike_oi_service",
    "strategy_builder_reference_service",
    "arbitrage_service",
    "option_symbol_service",
)
# Whose datetime reads the frozen clock while a plan F service runs (preflight F conflict 9)
CLOCK_MODULES = (
    "strike_profile_service",
    "vol_surface_service",
    "iv_chart_service",
    "oi_profile_service",
    "straddle_chart_service",
    "custom_straddle_service",
    "strategy_chart_service",
    "multi_strike_oi_service",
    "option_greeks_service",
    "option_symbol_service",
    "arbitrage_service",
)
HISTORY_READERS = (
    "iv_chart_service",
    "oi_profile_service",
    "straddle_chart_service",
    "custom_straddle_service",
    "strategy_chart_service",
    "multi_strike_oi_service",
)
# These quote the reference as the recording does (fakeApi's quotes, conflict 6)
RECORDED_QUOTES = (
    "straddle_chart_service",
    "custom_straddle_service",
    "strategy_chart_service",
    "multi_strike_oi_service",
)
# resolve_underlying_quote reads SymToken: answered from the input's master
REFERENCE_RESOLVERS = (
    "vol_surface_service",
    "iv_chart_service",
    "straddle_chart_service",
    "custom_straddle_service",
    "strategy_builder_reference_service",
)
MASTER_STRIKES = ("iv_chart_service", "straddle_chart_service", "custom_straddle_service")
GREEK_FIELDS = ("implied_volatility", "delta", "gamma", "theta", "vega")
NO_SPOT = frozenset({"MCX", "CDS", "BCD", "NCDEX", "NCO"})


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
    import importlib

    from services import (
        gamma_density_service,
        gex_service,
        iv_smile_service,
        oi_tracker_service,
        option_chain_service,
        option_greeks_service,
    )

    logging.disable(logging.CRITICAL)
    svc = {
        "option_chain_service": option_chain_service,
        "oi_tracker_service": oi_tracker_service,
        "gex_service": gex_service,
        "iv_smile_service": iv_smile_service,
        "gamma_density_service": gamma_density_service,
        "option_greeks_service": option_greeks_service,
    }
    for name in F_SERVICES:
        svc[name] = importlib.import_module(f"services.{name}")
    svc["token_db_enhanced"] = importlib.import_module("database.token_db_enhanced")
    return svc


def frozen_datetime(now_ms):
    """A datetime class whose now() is `now_ms`: aware in the asked zone, naive in IST."""

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            at = instant(now_ms)
            return at.astimezone(tz) if tz else at.astimezone(IST).replace(tzinfo=None)

    return Frozen


def freeze_clock(svc, now_ms):
    """datetime.now in option_greeks_service (calculate_time_to_expiry) reads `now_ms`."""
    svc["option_greeks_service"].datetime = frozen_datetime(now_ms)


@contextmanager
def frozen(svc, now_ms):
    """While a plan F service runs, every clock it reads is `now_ms` (preflight F conflict 9):
    each module's own datetime, and datetime.datetime itself, which vol_surface_service
    imports inside the function."""
    clock = frozen_datetime(now_ms)
    for name in CLOCK_MODULES:
        if isinstance(getattr(svc[name], "datetime", None), type):
            svc[name].datetime = clock
    with mock.patch("datetime.datetime", clock):
        yield


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def chain_base(body):
    """A chain read without its strike_count and with_greeks: the expiry it is of."""
    return {k: v for k, v in body.items() if k not in ("strike_count", "with_greeks")}


def history_triple(body):
    """(symbol, exchange, interval), case-folded."""
    return tuple(
        str(body.get(k) if body.get(k) is not None else "").casefold()
        for k in ("symbol", "exchange", "interval")
    )


def row_date(row):
    """A history row's IST date: its timestamp in seconds, or in ms when over 1e12."""
    t = row.get("timestamp") if isinstance(row, dict) else None
    if not is_number(t):
        return None
    return datetime.fromtimestamp(t / 1000 if t > 1e12 else t, IST).date().isoformat()


class Recording:
    def __init__(self, data):
        self.data = data
        self.responses = {}
        self.chains = []
        self.histories = {}
        for key, body in data["responses"].items():
            endpoint, _, raw = key.partition(" ")
            asked = json.loads(raw)
            self.responses[request_key(endpoint, asked)] = body
            if endpoint == "optionchain":
                self.chains.append((asked, body))
            elif endpoint == "history":
                self.histories.setdefault(history_triple(asked), []).append((asked, body))

    def get(self, endpoint, body):
        key = request_key(endpoint, body)
        if key not in self.responses:
            raise Missing(f"no recorded reply for {key}")
        return copy.deepcopy(self.responses[key])

    def futures(self):
        body = {"symbol": self.data["underlying"], "exchange": self.data["exchange"]}
        return self.get("expiry", {**body, "instrumenttype": "futures"}).get("data") or []

    def expiries(self):
        """The options expiries (DDMMMYY), as the expiry read lists them."""
        body = {"symbol": self.data["underlying"], "exchange": self.data["exchange"]}
        listed = self.get("expiry", {**body, "instrumenttype": "options"}).get("data") or []
        return [d.replace("-", "") for d in listed]

    def has_e(self):
        """Whether plan E's chain 25 was recorded (a part-F recording alone has none)."""
        asked = {
            "underlying": self.data["underlying"],
            "exchange": self.data["exchange"],
            "expiry_date": self.data["expiry"],
            "strike_count": LEGS_CHAIN,
        }
        return request_key("optionchain", asked) in self.responses

    def chain(self, ask):
        """The chain for `ask` by the superset rule (preflight F 5a with 5c,
        golden-record-f.mjs servedChain), from the recorded chains of the same expiry at a
        strike_count >= the asked: for a plain ask the narrowest of either kind, the plain one
        on a tie, its Greeks taken out (OI Profile's plain 20 is the with-Greeks 20 whose legs'
        daily OI is recorded); for a with_greeks ask the narrowest with-Greeks one, else the
        narrowest plain one. Its rows cut to strike_count each side of its own atm_strike by
        index (get_strikes_with_labels); server_ts the case instant; the first recorded wins a
        full tie. Returns (reply, whether Greeks were asked of a chain without them: one
        recorded plain, before 2.0.2.0, or by the mock)."""
        n = ask.get("strike_count")
        greeks = ask.get("with_greeks") is True
        want = chain_base(ask)
        source = None
        if is_number(n):
            for asked, reply in self.chains:
                count = asked.get("strike_count")
                if chain_base(asked) != want or not is_number(count) or count < n:
                    continue
                other = 0 if (asked.get("with_greeks") is True) == greeks else 1
                rank = (other, count) if greeks else (count, other)
                if source is None or rank < source[0]:
                    source = (rank, reply, other)
        if source is None:
            raise Missing(f"no recorded reply for {request_key('optionchain', ask)}")
        reply = copy.deepcopy(source[1])
        rows = reply.get("chain") if isinstance(reply.get("chain"), list) else []
        at = next(
            (i for i, row in enumerate(rows) if row.get("strike") == reply.get("atm_strike")), -1
        )
        if at >= 0:
            reply["chain"] = rows[max(0, at - n) : min(len(rows), at + n + 1)]
        if not greeks and source[2] == 1:
            for row in reply.get("chain") or []:
                for leg in (row.get("ce"), row.get("pe")):
                    if leg:
                        for k in GREEK_FIELDS:
                            leg.pop(k, None)
            reply["forward_price"] = None
            reply["greeks_included"] = False
        reply["server_ts"] = math.floor(self.data["serverNowMs"] / 1000)
        return reply, greeks and reply.get("greeks_included") is not True

    def history(self, ask):
        """The history for `ask` (golden-record-f.mjs servedHistory): the widest recorded read
        of the same symbol, exchange and interval, cut to the rows whose IST date lies within
        start_date..end_date, in recorded order."""
        source = None
        for asked, reply in self.histories.get(history_triple(ask), []):
            start, end = asked.get("start_date"), asked.get("end_date")
            if source is None or start < source[0] or (start == source[0] and end > source[1]):
                source = (start, end, reply)
        start, end = ask.get("start_date"), ask.get("end_date")
        if source is None or not isinstance(start, str) or not isinstance(end, str):
            raise Missing(f"no recorded reply for {request_key('history', ask)}")
        rows = source[2].get("data") if isinstance(source[2].get("data"), list) else []
        kept = [r for r in rows if (d := row_date(r)) is not None and start <= d <= end]
        return {"status": "success", "data": copy.deepcopy(kept)}


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


# --- Plan F ------------------------------------------------------------------------


def ltp_reply(ltp):
    return {"status": "success", "data": {"ltp": ltp}}


def attach_greeks(svc, reply, expiry, options_ex):
    """A with_greeks chain from one recorded without Greeks (a server before 2.0.2.0, or the
    mock, which computes none): the server's own forward and Black-76 pass
    (option_chain_service.py:237-270, 722-724)."""
    ocs, ogs = svc["option_chain_service"], svc["option_greeks_service"]
    chain = reply.get("chain") or []
    forward = ocs._forward_from_chain(chain, reply.get("atm_strike"), reply.get("underlying_ltp"))
    try:
        expiry_dt = ogs.get_expiry_datetime(expiry, options_ex)
    except ValueError:
        expiry_dt = None
    ocs._attach_chain_greeks(chain, expiry_dt, forward, None)
    reply["forward_price"] = forward
    reply["greeks_included"] = True
    if reply.get("expiry_ts") is None and expiry_dt is not None:
        reply["expiry_ts"] = int(expiry_dt.timestamp())


def install_master(svc, master):
    """The symbol cache holds the input's futures, so fno_search_symbols runs the server's own
    search (token_db_enhanced.py:697-847) over them, in its own order: by symbol when there is
    no query (:825-847), not the file order preflight F conflict 10 assumed. get_intervals is
    left alone: none of the ported services calls it (only the blueprints do)."""
    tdb = svc["token_db_enhanced"]
    rows = [
        SimpleNamespace(
            symbol=r["symbol"],
            brsymbol=r["symbol"],
            name=r["name"],
            exchange=r["exchange"],
            brexchange=r["exchange"],
            token=f"golden-{i}",
            expiry=r["expiry"],
            strike=r["strike"],
            lotsize=r["lotsize"],
            instrumenttype=r["itype"],
            tick_size=r["tick"],
        )
        for i, r in enumerate(master["futures"])
    ]
    tdb.get_cache()._snap = tdb._build_snapshot(rows, "golden")


def near_month_future(master, now_ms):
    """resolve_underlying_quote (option_symbol_service.py:130-210) over the input's futures:
    the exact base then a DDMMMYY date, expiring today (IST, at the frozen now) or later, the
    soonest; the spot itself where there is one."""

    def resolve(base_symbol, exchange):
        exch = (exchange or "").upper()
        if exch not in NO_SPOT:
            return (base_symbol, exch)
        base = (base_symbol or "").upper()
        exact = re.compile(rf"^{re.escape(base)}\d{{2}}[A-Z]{{3}}\d{{2}}FUT$")
        today = instant(now_ms).astimezone(IST).date()
        candidates = []
        for row in master["futures"]:
            # the query's exchange and instrumenttype, then the exact base
            if row["exchange"] != exch or row["itype"] != "FUT":
                continue
            if not exact.match(row["symbol"] or ""):
                continue
            try:
                expiry = datetime.strptime(row["expiry"], "%d-%b-%y").date()
            except (ValueError, TypeError):
                continue
            if expiry >= today:
                candidates.append((expiry, row))
        if not candidates:
            return None
        candidates.sort(key=lambda pair: pair[0])
        row = candidates[0][1]
        return (row["symbol"], row["exchange"])

    return resolve


def install_f(svc, rec):
    """Plan F's data layer over `rec`: everything but the services' own logic."""
    data = rec.data
    u, x = data["underlying"], data["exchange"]
    ox = options_exchange(x)
    master = data["master"]

    def served_chain(ask):
        reply, attach = rec.chain(ask)
        if attach:
            attach_greeks(svc, reply, ask["expiry_date"], ox)
        return reply

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
        ask = {
            "underlying": underlying,
            "exchange": exchange,
            "expiry_date": expiry_date,
            "strike_count": strike_count,
        }
        if with_greeks:
            ask["with_greeks"] = True
        return True, served_chain(ask), 200

    def get_history(symbol, exchange, interval, start_date, end_date, api_key=None, **_kw):
        ask = {
            "symbol": symbol,
            "exchange": exchange,
            "interval": interval,
            "start_date": start_date,
            "end_date": end_date,
        }
        return True, rec.history(ask), 200

    def recorded_quotes(symbol, exchange, api_key=None, **_kw):
        return True, rec.get("quotes", {"symbol": symbol, "exchange": exchange}), 200

    def master_strikes(base_symbol, expiry_date, option_type, exchange):
        asked = (base_symbol.upper(), option_type.upper(), exchange.upper())
        if asked != (u.upper(), "CE", ox):
            raise Missing(f"no master strikes for {asked}")
        return list(master["strikes"].get(expiry_date.upper(), []))

    for name in ("strike_profile_service", "oi_profile_service"):
        svc[name].get_option_chain = get_option_chain
    for name in HISTORY_READERS:
        svc[name].get_history = get_history
    for name in RECORDED_QUOTES:
        svc[name].get_quotes = recorded_quotes
    for name in MASTER_STRIKES:
        svc[name].get_available_strikes = master_strikes
    resolve = near_month_future(master, data["serverNowMs"])
    for name in REFERENCE_RESOLVERS:
        svc[name].resolve_underlying_quote = resolve
    install_master(svc, master)
    # Under the development server there is no time budget: the waits between batches of
    # daily reads change nothing, so they are skipped.
    svc["oi_profile_service"].time = SimpleNamespace(
        monotonic=time.monotonic, sleep=lambda _seconds: None
    )

    def chain_ask(expiry, count):
        return {"underlying": u, "exchange": x, "expiry_date": expiry, "strike_count": count}

    def iv_quotes(expiry):
        """IV Chart quotes the chain at 1 strike's underlying LTP (conflict 6)."""

        def get_quotes(symbol, exchange, api_key=None, **_kw):
            return True, ltp_reply(served_chain(chain_ask(expiry, 1))["underlying_ltp"]), 200

        svc["iv_chart_service"].get_quotes = get_quotes

    def surface(expiries, count):
        """Vol Surface reads the chains the phone reads (conflicts 6 and 7): the first expiry's
        underlying LTP, each expiry's CE strikes, and each leg's LTP from its chain."""
        vs = svc["vol_surface_service"]
        chains = {e: served_chain(chain_ask(e, count)) for e in expiries}
        ltps = {}
        for chain in chains.values():
            for row in chain.get("chain") or []:
                for leg in (row.get("ce"), row.get("pe")):
                    if leg and leg.get("symbol"):
                        ltps[leg["symbol"]] = leg.get("ltp")

        def get_quotes(symbol, exchange, api_key=None, **_kw):
            return True, ltp_reply(chains[expiries[0]]["underlying_ltp"]), 200

        def get_multiquotes(symbols, api_key=None, **_kw):
            results = [
                {**q, "data": {"ltp": ltps[q["symbol"]]}} for q in symbols if q["symbol"] in ltps
            ]
            return True, {"status": "success", "results": results}, 200

        def get_available_strikes(base_symbol, expiry_date, option_type, exchange):
            chain = chains.get(expiry_date)
            if chain is None or option_type.upper() != "CE":
                raise Missing(f"no surface chain for {expiry_date} {option_type}")
            return sorted(row["strike"] for row in chain.get("chain") or [] if row.get("ce"))

        vs.get_quotes = get_quotes
        vs.get_multiquotes = get_multiquotes
        vs.get_available_strikes = get_available_strikes

    return SimpleNamespace(served_chain=served_chain, iv_quotes=iv_quotes, surface=surface)


def run_f(svc, rec):
    """Plan F's ten routes on the recording, as the pages ask them: {name: args, status, body}."""
    data = rec.data
    now_ms = data["serverNowMs"]
    u, x = data["underlying"], data["exchange"]
    with frozen(svc, now_ms):
        f = install_f(svc, rec)
        expiries = rec.expiries()
        e0 = expiries[0]
        asked = {"underlying": u, "exchange": x, "expiry_date": e0, "strike_count": F_CHAIN}
        builder = f.served_chain({**asked, "with_greeks": True})
    legs = [leg for row in builder.get("chain") or [] for leg in (row.get("ce"), row.get("pe"))]
    # the chain's lot: Straddle PnL's lot_size
    lot = next((leg["lotsize"] for leg in legs if leg and leg.get("lotsize")), None)
    case = {"underlying": u, "exchange": x}
    profile = {**case, "expiry_dates": expiries[:F_PROFILE_EXPIRIES]}
    surface = {
        **case,
        "expiry_dates": expiries[:F_SURFACE_EXPIRIES],
        "strike_count": F_SURFACE_STRIKES,
    }
    five = {**case, "expiry_date": e0, "interval": F_INTERVAL}
    minute = {**case, "expiry_date": e0, "interval": F_STRADDLE_INTERVAL}
    straddle = {**minute, "days": F_DAYS["straddle"]}
    simulation = {
        **minute,
        "days": F_DAYS["straddlepnl"],
        "adjustment_points": F_ADJUSTMENT_POINTS,
        "lot_size": lot,
        "lots": 1,
    }
    strategy = {
        **case,
        "legs": data["strategyLegs"],
        "interval": F_INTERVAL,
        "days": F_DAYS["strategy"],
    }
    # (name in routesF, module, args); the function is the name, the strike profile's twice
    calls = (
        ("get_strike_profile", "strike_profile_service", {**profile, "range_pct": 5.0}),
        ("get_strike_profile_all", "strike_profile_service", {**profile, "range_pct": None}),
        ("get_vol_surface_data", "vol_surface_service", surface),
        ("get_iv_chart_data", "iv_chart_service", {**five, "days": F_DAYS["ivchart"]}),
        ("get_oi_profile_data", "oi_profile_service", {**five, "days": F_DAYS["oiprofile"]}),
        ("get_straddle_chart_data", "straddle_chart_service", straddle),
        ("get_custom_straddle_simulation", "custom_straddle_service", simulation),
        ("get_strategy_chart_data", "strategy_chart_service", strategy),
        ("get_multi_strike_oi_data", "multi_strike_oi_service", strategy),
        ("get_arbitrage_universe", "arbitrage_service", {"exchanges": F_ARBITRAGE_EXCHANGES}),
    )
    out = {}
    for name, module, args in calls:
        service = getattr(svc[module], name.removesuffix("_all"))
        with frozen(svc, now_ms):
            if name == "get_vol_surface_data":
                f.surface(args["expiry_dates"], args["strike_count"])
            if name == "get_iv_chart_data":
                f.iv_quotes(args["expiry_date"])
            _ok, body, status = service(**copy.deepcopy(args), api_key=API_KEY)
        if name == "get_arbitrage_universe" and isinstance(body.get("data"), dict):
            # the universe is a pure master read; only its clock stamp would differ
            body["data"].pop("generated_at", None)
        out[name] = {"args": args, "status": status, "body": body}
    return out


def run_case(svc, data):
    rec = Recording(data)
    u, x, e = data["underlying"], data["exchange"], data["expiry"]
    out = {
        "case": data["case"],
        "source": data["source"],
        "serverNowMs": data["serverNowMs"],
        "underlying": u,
        "exchange": x,
        "expiry": e,
    }
    if rec.has_e():
        out.update(run_e(svc, rec))
    if "master" in data:
        out["routesF"] = run_f(svc, rec)
    return out


def run_e(svc, rec):
    """Plan E's routes, legs and withGreeks."""
    data = rec.data
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
    return {"routes": routes, "legs": legs, "withGreeks": with_greeks}


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
    # plan F's two: IV saturates at 4.999999999999996 for a price from sigma 6.2, and is 1e-6
    # at intrinsic (iv_chart_service prices Greeks at either)
    from_sigma = black76.black("c", 24000, 24000, WEEK, RATE, 6.2)
    priced = (
        ("a price from sigma 6.2", "c", 24000, 24000, WEEK, from_sigma),
        ("at intrinsic", "c", 24000, 23000, WEEK, 24000 - 23000),
    )
    for label, flag, F, K, t, price in (*EDGES, *priced):
        iv, error = solve(black76, price, F, K, t, flag)
        greeks = None
        if iv is not None:
            args = (flag, F, K, t, RATE, iv)
            greeks = {
                "delta": black76.delta(*args),
                "gamma": black76.gamma(*args),
                "theta": black76.theta(*args),
                "vega": black76.vega(*args),
            }
        edges.append(
            {"label": label, "flag": flag, "F": F, "K": K, "t": t, "price": price}
            | {"iv": iv, "error": error, "greeks": greeks}
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
            parts = [
                f"{len(result.get('routes', {}))} routes",
                f"{len(result.get('legs', []))} legs",
                f"{len(result.get('routesF', {}))} part-F routes",
            ]
            print(f"{path.name}: {', '.join(parts)}")
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
