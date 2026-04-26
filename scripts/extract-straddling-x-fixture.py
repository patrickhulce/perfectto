#!/usr/bin/env python3
"""
One-shot fixture extractor: pull a small slice of the 80MB chrome trace
that exercises the straddling-X parser bug, then gzip it.

The slice contains:
  - All `M` (metadata) events (cheap, makes the fixture self-describing).
  - One full `output_code.py(611): __call__` invocation worth of events on
    the same (pid, tid), plus a small lookback window before it so the
    PyTorch profiler probes that wrap it are present too.
"""

import gzip
import json
import os
import re
import sys

SRC = "test-results/chrome_trace_hf_compiled.json.gz"
OUT = "src/__tests__/fixtures/chrome-straddling-x.json.gz"

TARGET_NAME_PATTERN = re.compile(r"output_code\.py\(\d+\):\s*__call__")
LOOKBACK_US = 1_000   # 1 ms before __call__ start
LOOKAHEAD_US = 1_000  # 1 ms after __call__ end


def stream_events(fp):
    """Yield raw JSON event objects (as strings) from the `traceEvents` array.

    Uses a brace-aware state machine so multi-line events with embedded
    strings are captured correctly without ever materializing the whole
    1.3 GiB array.
    """
    # Skip prelude until we find `"traceEvents":`.
    buf = ""
    while '"traceEvents"' not in buf:
        chunk = fp.read(64 * 1024)
        if not chunk:
            raise RuntimeError("no traceEvents")
        buf += chunk
    # Move cursor past `"traceEvents":` and the opening `[`.
    idx = buf.index('"traceEvents"')
    idx = buf.index("[", idx) + 1
    # Stream events out of buf, refilling as we go.
    depth = 0
    in_string = False
    escape = False
    obj_start = -1
    while True:
        i = idx
        end = len(buf)
        while i < end:
            ch = buf[i]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
            else:
                if ch == '"':
                    in_string = True
                elif ch == "{":
                    if depth == 0:
                        obj_start = i
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0 and obj_start >= 0:
                        yield buf[obj_start:i + 1]
                        obj_start = -1
                elif ch == "]" and depth == 0:
                    return
            i += 1
        # Refill: drop everything before idx (or before obj_start if mid-obj).
        keep_from = obj_start if obj_start >= 0 else i
        buf = buf[keep_from:]
        if obj_start >= 0:
            obj_start = 0
        idx = len(buf)
        chunk = fp.read(256 * 1024)
        if not chunk:
            return
        buf += chunk


def main():
    src_size = os.path.getsize(SRC)
    print(f"reading {SRC} ({src_size / 1024 / 1024:.1f} MiB compressed)")

    metadata_events = []
    target_pid = None
    target_tid = None
    target_window_start = None
    target_window_end = None

    # Pass 1: find the first qualifying __call__ and remember its window.
    # Stream metadata + look for the target. We don't keep non-metadata events
    # in this pass — that's pass 2.
    with gzip.open(SRC, "rt", encoding="utf-8") as fp:
        for raw in stream_events(fp):
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            ph = ev.get("ph")
            if ph == "M":
                metadata_events.append(ev)
                continue
            if target_window_start is not None:
                continue
            if ph != "X":
                continue
            name = ev.get("name", "")
            if not TARGET_NAME_PATTERN.search(name):
                continue
            dur = ev.get("dur", 0) or 0
            if dur < 50_000:  # skip warmup; we want a meaty 50ms+ instance
                continue
            target_pid = ev.get("pid")
            target_tid = ev.get("tid")
            ts = ev.get("ts", 0)
            target_window_start = ts - LOOKBACK_US
            target_window_end = ts + dur + LOOKAHEAD_US
            print(
                f"target: name={name!r} pid={target_pid} tid={target_tid} "
                f"ts={ts} dur={dur:.1f} -> window "
                f"[{target_window_start:.1f}, {target_window_end:.1f}]"
            )

    if target_window_start is None:
        print("no qualifying __call__ found", file=sys.stderr)
        sys.exit(1)
    print(f"metadata events: {len(metadata_events)}")

    # Pass 2: collect events on (target_pid, target_tid) inside the window.
    kept = []
    scanned = 0
    with gzip.open(SRC, "rt", encoding="utf-8") as fp:
        for raw in stream_events(fp):
            scanned += 1
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            ph = ev.get("ph")
            if ph == "M":
                continue  # already collected
            if ev.get("pid") != target_pid or ev.get("tid") != target_tid:
                continue
            ts = ev.get("ts", 0)
            dur = ev.get("dur", 0) or 0
            end = ts + dur
            if end < target_window_start or ts > target_window_end:
                continue
            kept.append(ev)
            if scanned % 200_000 == 0:
                print(f"  scanned {scanned} events, kept {len(kept)}")

    print(f"scanned {scanned} events total, kept {len(kept)} on-thread events")

    # Strip args (huge & not needed for the parser-shape regression).
    for ev in kept:
        ev.pop("args", None)
    for ev in metadata_events:
        # keep tiny args on metadata (process_name etc.) — they're small.
        a = ev.get("args")
        if isinstance(a, dict):
            txt = json.dumps(a)
            if len(txt) > 256:
                ev["args"] = {"truncated": True}

    out_payload = {
        "displayTimeUnit": "ms",
        "metadata": {
            "source": "chrome_trace_hf_compiled.json.gz",
            "fixture": "straddling-x slice for parser regression",
            "originalEvents": scanned,
            "keptEvents": len(kept),
        },
        "traceEvents": metadata_events + kept,
    }
    out_text = json.dumps(out_payload, separators=(",", ":"))
    out_bytes = out_text.encode("utf-8")
    print(
        f"raw payload: {len(out_bytes)} bytes "
        f"({len(out_bytes) / 1024 / 1024:.2f} MiB)"
    )

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, "wb", compresslevel=9) as gz:
        gz.write(out_bytes)
    out_size = os.path.getsize(OUT)
    print(f"wrote {OUT} ({out_size} bytes, {out_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
