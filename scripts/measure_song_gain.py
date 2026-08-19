#!/usr/bin/env python3
"""Measure every library clip's loudness and write a playback gain into
audio/simple/library.json.

Why this exists: the library was assembled clip by clip over a season and its
levels are all over the place — 13 dB between the quietest and the loudest song
— so one kid's walk-up came out twice as loud as the next kid's, and the ducking
multiplier that is supposed to keep music under the announcement meant something
different for every song. A per-song gain gives the app one predictable level to
duck from.

Gains only ever attenuate. Pushing a quiet clip up would clip it (most of these
peak within a dB of full scale) and the problem being solved is songs that are
too loud, which is one-directional.

Run after adding songs to the library:

    python3 scripts/measure_song_gain.py            # writes library.json
    python3 scripts/measure_song_gain.py --check    # report only, exit 1 if stale

Deezer tracks are measured the same way, but in the browser at download time —
see measureClipGain() in app.js. Keep TARGET_MEAN_DBFS here in step with it.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# Where music should sit at full level. Chosen as the median of the library as
# it stood when this was written (-13 dB), a touch lower, so most clips move
# very little and only the hot ones come down. The announcements measure -16 to
# -19 dB mean, so music at this target sits just above the spoken voice at full
# volume and well under it once ducked.
TARGET_MEAN_DBFS = -14.0

ROOT = Path(__file__).resolve().parent.parent
LIBRARY_JSON = ROOT / "audio" / "simple" / "library.json"
KEY_ORDER = ["file", "song", "artist", "explicit", "gain"]


def mean_volume_dbfs(path: Path) -> float:
    """RMS level of a file, as ffmpeg's volumedetect reports it."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", out)
    if not m:
        raise RuntimeError(f"no mean_volume for {path}")
    return float(m.group(1))


def gain_for(mean_db: float) -> float:
    """Attenuation that brings mean_db down to the target. Never above 1."""
    return round(min(1.0, 10 ** ((TARGET_MEAN_DBFS - mean_db) / 20)), 3)


def render(entries: list[dict]) -> str:
    """One entry per line, columns aligned — the way the file is kept by hand."""
    def cell(key: str, value) -> str:
        return f'"{key}": {json.dumps(value)}'

    widths = {}
    for key in ("file", "song", "artist"):
        widths[key] = max(
            (len(cell(key, e[key])) for e in entries if key in e), default=0)

    lines = []
    for entry in entries:
        parts = []
        keys = [k for k in KEY_ORDER if k in entry]
        for i, key in enumerate(keys):
            text = cell(key, entry[key])
            last = i == len(keys) - 1
            if not last:
                text += ","
                # Pad to the column width (+1 for the comma) so the next key
                # lines up down the file.
                text = text.ljust(widths.get(key, 0) + 1)
            parts.append(text)
        lines.append("  { " + " ".join(parts).rstrip() + " }")
    return "[\n" + ",\n".join(lines) + "\n]\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="report what would change and exit 1 if anything is stale")
    args = ap.parse_args()

    entries = json.loads(LIBRARY_JSON.read_text())
    stale = []
    for entry in entries:
        path = ROOT / entry["file"]
        if not path.exists():
            print(f"missing file: {entry['file']}", file=sys.stderr)
            return 1
        mean_db = mean_volume_dbfs(path)
        gain = gain_for(mean_db)
        was = entry.get("gain")
        entry["gain"] = gain
        flag = "" if was == gain else "  <- changed"
        if was != gain:
            stale.append(entry["file"])
        print(f"{Path(entry['file']).name:34s} {mean_db:6.1f} dB  gain {gain:.3f}{flag}")

    if args.check:
        if stale:
            print(f"\n{len(stale)} entr{'y' if len(stale) == 1 else 'ies'} out of date; "
                  f"run without --check to write", file=sys.stderr)
            return 1
        print("\nlibrary.json is up to date")
        return 0

    LIBRARY_JSON.write_text(render(entries))
    print(f"\nwrote {LIBRARY_JSON.relative_to(ROOT)} (target {TARGET_MEAN_DBFS:.0f} dB mean)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
