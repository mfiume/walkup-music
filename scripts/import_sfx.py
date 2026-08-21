#!/usr/bin/env python3
"""Bring a downloaded sound onto the soundboard: level it, name it, put it in
audio/sfx/.

Levelling is by loudness (EBU R128 / LUFS), not by RMS. RMS badly understates a
stadium organ — all transient, big peaks, quiet in between — and going by it
would have made these five imports 3 to 5 dB louder than everything already on
the board when they were in fact already matched. LUFS is what an ear hears.

Every import lands at the same loudness with the same true-peak ceiling, so a
coach can hit any pad without reaching for the volume buttons. The ceiling
matters as much as the level: most of these files arrive peaking at or just over
full scale, which some DACs turn into crackle.

    python3 scripts/import_sfx.py "~/Downloads/thing.mp3" boom-chick
    python3 scripts/import_sfx.py --dry-run <src> <slug>

Then add the file to SOUNDBOARD in app.js and to AUDIO in sw.js, and bump the
service worker's cache name.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# Where every soundboard clip is levelled to. -13 LUFS is the middle of what was
# already there (the team intro and the two long organ pieces all sit within half
# a dB of it), so imports match the board rather than the board matching imports.
TARGET_LUFS = -13.0
# True peak, in dBTP. -1 leaves room for the intersample peaks that show up when
# a decoder reconstructs the waveform.
TARGET_PEAK = -1.0
MP3_BITRATE = '192k'

ROOT = Path(__file__).resolve().parent.parent
SFX_DIR = ROOT / 'audio' / 'sfx'


def measure(path: Path) -> dict:
    """First loudnorm pass: what this file actually is."""
    out = subprocess.run(
        ['ffmpeg', '-hide_banner', '-nostats', '-i', str(path),
         '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
        capture_output=True, text=True).stderr
    m = re.search(r'\{[^{}]*input_i[^{}]*\}', out, re.S)
    if not m:
        raise RuntimeError(f'could not measure {path.name}')
    return json.loads(m.group(0))


def normalise(src: Path, dest: Path, stats: dict) -> None:
    """Second pass: apply the correction loudnorm worked out in the first."""
    flt = (
        f"loudnorm=I={TARGET_LUFS}:TP={TARGET_PEAK}:LRA=11"
        f":measured_I={stats['input_i']}:measured_TP={stats['input_tp']}"
        f":measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}"
        f":offset={stats['target_offset']}:linear=true"
    )
    subprocess.run(
        ['ffmpeg', '-hide_banner', '-nostats', '-y', '-i', str(src),
         '-af', flt, '-c:a', 'libmp3lame', '-b:a', MP3_BITRATE, str(dest)],
        check=True, capture_output=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('source', help='file to import')
    ap.add_argument('slug', help='name in audio/sfx/, without extension')
    ap.add_argument('--dry-run', action='store_true', help='measure only')
    args = ap.parse_args()

    src = Path(args.source).expanduser()
    if not src.exists():
        print(f'no such file: {src}', file=sys.stderr)
        return 1
    dest = SFX_DIR / f'{args.slug}.mp3'

    before = measure(src)
    print(f'{src.name}')
    print(f'  before  {float(before["input_i"]):6.1f} LUFS  peak '
          f'{float(before["input_tp"]):5.1f} dBTP')
    if args.dry_run:
        return 0

    SFX_DIR.mkdir(parents=True, exist_ok=True)
    normalise(src, dest, before)
    after = measure(dest)
    print(f'  after   {float(after["input_i"]):6.1f} LUFS  peak '
          f'{float(after["input_tp"]):5.1f} dBTP'
          f'   -> {dest.relative_to(ROOT)} '
          f'({dest.stat().st_size // 1024} KB)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
