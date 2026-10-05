#!/usr/bin/env python3
"""
SYNTHETIC TELEMETRY, AT A VOLUME NO DEMO DATASET REACHES.

=== WHY THIS EXISTS ALONGSIDE scripts/generate-synthetic-data.ts ===

That generator makes three files a person can demo in ninety seconds. This one
makes five files with the SHAPE of real operational telemetry, at a volume and
with an outlier rate chosen to drive the alert path hard enough to prove the
background evaluation loop survives sustained load.

The distinction matters because the two answer different questions. A demo file
proves the engine reads a CSV. This file proves the scheduler keeps a flat heap
while ten thousand rows arrive, still fences the outliers, and still reaches a
connected SSE consumer -- which is a claim about the RUNNING system rather than
about a parser.

=== EVERYTHING HERE IS SYNTHETIC, AND THAT IS A CONSTRAINT NOT A COINCIDENCE ===

  - Seeded PRNG. Two runs with the same seed are byte-identical, so a failure is
    reproducible rather than anecdotal. The existing generator made the same
    argument and it is worth repeating: an unreproducible load test is a story.
  - Client addresses come ONLY from RFC 5737 documentation ranges. These are
    reserved for exactly this and cannot collide with a real network, so a stress
    run cannot leak a customer topology into a file somebody attaches to a ticket.
  - Identifiers are opaque sequences. A synthetic file containing something that
    looks like a real person is a file that eventually gets treated as one.

=== WHY THE OUTLIERS ARE INJECTED RATHER THAN LEFT TO CHANCE ===

A lognormal draw will produce a tail, and a tail is not a breach. The detection
here is an interquartile fence, so what has to be tested is a SMALL number of
values FAR outside the fence -- not the ordinary spread of a heavy-tailed
distribution. Each dataset therefore gets its own explicit spike count, written
as a separate pass so the number of fences that trip is a known quantity rather
than something the run reports and nobody checks.

=== NO TIMEZONE, NO LOCALE, NO AMBIGUOUS TIMESTAMPS ===

Instants are ISO 8601 with an explicit offset. A timestamp without an offset is
a value that means different instants in different deployments, and a load test
whose timestamps mean two different things is testing the wrong half of the
system.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# RFC 5737. Reserved for documentation, so these cannot be a real network.
DOC_NETS = ("192.0.2.", "198.51.100.", "203.0.113.")


def _doc_ip(rng: np.random.Generator, index: int) -> str:
    net = DOC_NETS[index % len(DOC_NETS)]
    return f"{net}{rng.integers(1, 254)}"


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _base_instants(count: int, start: datetime, step_ms: int) -> list[datetime]:
    """One instant per row, evenly stepped.

    Even rather than random because the streaming broker buckets by hour, and a
    run whose rows clump into two buckets tests the bucketing rather than the
    loop. The caller's load pattern is what varies; the clock is not.
    """
    return [start + timedelta(milliseconds=step_ms * i) for i in range(count)]


def database_query_times(rng, n, spikes, start) -> pd.DataFrame:
    """Database query execution timings.

    The value column is `elapsed_ms`, which is what an operator actually waits
    on, and its natural distribution is lognormal: a long tail of slow queries
    around a tight median. The spikes are the ones past the extreme fence.
    """
    base = rng.lognormal(mean=3.2, sigma=0.55, size=n)
    idx = rng.choice(n, size=spikes, replace=False) if spikes else np.array([], dtype=int)
    base[idx] = base.mean() * rng.uniform(25, 90, size=spikes)
    return pd.DataFrame(
        {
            "query_id": [f"QRY-{i:07d}" for i in range(n)],
            "db_host": rng.choice(["db-primary", "db-replica-a", "db-replica-b"], size=n),
            "elapsed_ms": np.round(base, 2),
            "rows_returned": rng.integers(1, 50_000, size=n),
            "plan_hash": [f"{rng.integers(0, 2**32):08x}" for _ in range(n)],
            "started_at": [_iso(t) for t in _base_instants(n, start, 40)],
        }
    )


def splunk_events(rng, n, spikes, start) -> pd.DataFrame:
    """Splunk-shaped events: sourcetypes, hosts, volumes, severities.

    `bytes_out` is the numeric column here. It is deliberately a different
    column in a different unit from every other dataset, because a detector that
    only ever works when the numeric column is called `elapsed_ms` is not a
    detector.
    """
    volumes = rng.lognormal(mean=7.4, sigma=0.9, size=n)
    idx = rng.choice(n, size=spikes, replace=False) if spikes else np.array([], dtype=int)
    volumes[idx] = volumes.mean() * rng.uniform(30, 120, size=spikes)
    return pd.DataFrame(
        {
            "_time": [_iso(t) for t in _base_instants(n, start, 37)],
            "source": rng.choice(
                ["winsecuritylog", "syslog", "access_combined", "custom_json", "perfmon"], size=n
            ),
            "sourcetype": rng.choice(
                ["XmlWinEventLog", "syslog", "access_combined", "json", "PerfmonCounter"], size=n
            ),
            "host": rng.choice(["app-01", "app-02", "app-03", "edge-01"], size=n),
            "event_id": [f"EVT-{i:08d}" for i in range(n)],
            "bytes_out": np.round(volumes, 1),
            "severity": rng.choice(["INFO", "WARN", "ERROR", "CRITICAL"], size=n, p=[0.7, 0.2, 0.08, 0.02]),
        }
    )


def apache_access(rng, n, spikes, start) -> pd.DataFrame:
    """Apache combined access logs, with microsecond request times.

    The numeric column is `request_time_us` and it is bimodal on purpose: pages
    are fast, assets are slower, and a breach in that population is a genuinely
    rare observation rather than the third-largest of a smooth tail.
    """
    is_page = rng.random(n) < 0.25
    fast = rng.lognormal(mean=9.0, sigma=0.5, size=n)
    slow = rng.lognormal(mean=13.5, sigma=0.6, size=n)
    times = np.where(is_page, slow, fast)
    idx = rng.choice(n, size=spikes, replace=False) if spikes else np.array([], dtype=int)
    times[idx] = times.mean() * rng.uniform(20, 70, size=spikes)
    return pd.DataFrame(
        {
            "ts": [_iso(t) for t in _base_instants(n, start, 41)],
            "remote_host": [_doc_ip(rng, i) for i in range(n)],
            "method": rng.choice(["GET", "GET", "GET", "POST"], size=n),
            "path": rng.choice(
                ["/", "/login", "/api/orders", "/assets/app.js", "/health", "/api/checkout"], size=n
            ),
            "status": rng.choice([200, 200, 200, 204, 301, 404, 500], size=n, p=[0.78, 0.08, 0.05, 0.04, 0.02, 0.02, 0.01]),
            "bytes": rng.integers(180, 900_000, size=n),
            "request_time_us": np.round(times, 1),
        }
    )


def pega_traces(rng, n, spikes, start) -> pd.DataFrame:
    """Pega Dev Studio traces, shaped to the columns the platform already routes on.

    `service` and `pega_time` are the key column and time column the live
    gateway connects with, and `alert_code` / `elapsed_time` / `threshold` are the
    four columns the existing `pega-alert-export` schema matches on. Generating a
    different shape here would test a stream the gateway does not accept, which is
    the easiest way to write a load test that passes by sending nothing.

    Threshold is set BELOW the slow population so `elapsed_time` is genuinely
    over its line on the spike rows, which is what makes the fence observable on
    a column that means something operationally.
    """
    elapsed = rng.lognormal(mean=6.0, sigma=0.5, size=n)
    idx = rng.choice(n, size=spikes, replace=False) if spikes else np.array([], dtype=int)
    elapsed[idx] = elapsed.mean() * rng.uniform(15, 60, size=spikes)
    return pd.DataFrame(
        {
            "service": rng.choice(
                ["order-fulfilment", "claims-adjudication", "customer-onboarding"], size=n
            ),
            "pega_time": [_iso(t) for t in _base_instants(n, start, 43)],
            "alert_code": rng.choice(
                ["PEGA0001", "PEGA0002", "PEGA0003", "PEGA0007"], size=n
            ),
            "elapsed_time": np.round(elapsed, 1),
            "threshold": 1000,
            "rule_name": rng.choice(
                ["CaseTimeWithinThreshold", "SLAPerformance", "BatchCycleTime", "QueueDepth"], size=n
            ),
        }
    )


def vugen_metrics(rng, n, spikes, start) -> pd.DataFrame:
    """LoadRunner VuGen transaction metrics.

    `elapsed_ms` and `think_time_ms` are both present and they mean different
    things: time inside the transaction, and time the simulated user spent
    between transactions. Generating only one of them is how a run ends up
    proving that a think-time column is treated the same as a service-time
    column, which is exactly the mistake worth catching.
    """
    elapsed = rng.lognormal(mean=5.4, sigma=0.7, size=n)
    think = rng.exponential(scale=1200.0, size=n)
    idx = rng.choice(n, size=spikes, replace=False) if spikes else np.array([], dtype=int)
    elapsed[idx] = elapsed.mean() * rng.uniform(18, 75, size=spikes)
    failed = (rng.random(n) < 0.03).astype(int)
    return pd.DataFrame(
        {
            "transaction_name": rng.choice(
                ["Login", "SearchCatalogue", "ViewBasket", "Checkout", "PaymentSubmit"], size=n
            ),
            "sample_at": [_iso(t) for t in _base_instants(n, start, 47)],
            "elapsed_ms": np.round(elapsed, 2),
            "think_time_ms": np.round(think, 2),
            "hits": rng.integers(1, 4000, size=n),
            "passed": (1 - failed) * rng.integers(1, 4000, size=n),
            "failed": failed * rng.integers(0, 60, size=n),
        }
    )


# The numeric column each dataset is expected to be fenced on. Recorded in the
# manifest so the Node proof can state which column it expected to break rather
# than discovering a breach somewhere and reporting success.
DATASETS = {
    "db_query_times": (database_query_times, "elapsed_ms"),
    "splunk_events": (splunk_events, "bytes_out"),
    "apache_access": (apache_access, "request_time_us"),
    "pega_traces": (pega_traces, "elapsed_time"),
    "vugen_metrics": (vugen_metrics, "elapsed_ms"),
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate synthetic operational telemetry.")
    parser.add_argument("--out", required=True, type=Path, help="directory to write the CSV files into")
    parser.add_argument("--rows", type=int, default=2_000, help="rows per dataset")
    parser.add_argument("--spikes", type=int, default=12, help="injected extreme values per dataset")
    parser.add_argument("--seed", type=int, default=20261004)
    parser.add_argument("--start", default="2026-10-04T00:00:00Z", help="ISO instant of the first row")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    start = datetime.fromisoformat(args.start.replace("Z", "+00:00"))

    manifest = {"seed": args.seed, "rows": args.rows, "spikes": args.spikes, "datasets": {}}

    for name, (builder, value_column) in DATASETS.items():
        # A FRESH generator per dataset, so adding a dataset does not shift the
        # numbers every dataset before it. A load test whose baseline moves
        # whenever the suite grows is not a baseline.
        rng = np.random.default_rng(args.seed + abs(hash(name)) % 1_000)
        frame = builder(rng, args.rows, args.spikes, start)
        path = args.out / f"{name}.csv"
        frame.to_csv(path, index=False)

        column = frame[value_column]
        # Reported so the proof can compare what it OBSERVED against what was
        # INJECTED. A harness that only reports its own success is a harness
        # that cannot fail.
        manifest["datasets"][name] = {
            "file": path.name,
            "rows": int(len(frame)),
            "value_column": value_column,
            "injected_spikes": int(args.spikes),
            "observed_max": float(column.max()),
            "observed_median": float(column.median()),
            "max_over_median": float(column.max() / max(column.median(), 1e-9)),
            "columns": list(frame.columns),
        }
        print(
            f"  {name:<18} rows={len(frame):>6}  column={value_column:<16}"
            f"  max/median={manifest['datasets'][name]['max_over_median']:>8.1f}x"
        )

    manifest_path = args.out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nmanifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())