#!/usr/bin/env python3
"""
Disentangle .aup3 projects into separate announcement and music WAV files.

Strategy: parse the project's name dictionary (it has fixed numeric IDs for
"wavetrack", "name", "blockid", "rate", etc.), then scan the binary `project.doc`
linearly for the byte signatures of those specific records:

  - StartTag wavetrack       = 0x01 0x15 0x00
  - String attr "name"       = 0x03 0x16 0x00 + 4-byte UTF-16 byte length + content
  - LongLong attr "blockid"  = 0x07 0x30 0x00 + 8-byte LE uint64
  - Double attr "rate"       = 0x0A 0x04 0x00 + 8-byte LE float64 (project root)

For each `<wavetrack>` we capture its name and every blockid that appears
between its StartTag and the next wavetrack's StartTag (or end of doc).
That is robust to whatever else lives in the doc — we don't need a full parser.

Sample format is 32-bit float (sampleformat code 262159 = 0x0004000F).

Usage:
    python3 extract_aup3.py
"""

import glob
import os
import re
import struct
import sqlite3
import sys
import wave

SOURCE_DIR = "/Users/mfiume/Downloads/10U Songs"
ANN_OUT = "/Users/mfiume/Development/walkup-music/audio/simple/announcements"
MUSIC_OUT = "/Users/mfiume/Development/walkup-music/audio/simple/walkups-clean"


def parse_dict(blob: bytes) -> dict:
    """project.dict BLOB → {id: name}. Format: 2-byte header, then sequence of
    0x0F + u16 id + u16 byte_len + UTF-16-LE content."""
    names = {}
    i = 2
    while i < len(blob) and blob[i] == 0x0F:
        nid = struct.unpack_from("<H", blob, i + 1)[0]
        blen = struct.unpack_from("<H", blob, i + 3)[0]
        names[nid] = blob[i + 5 : i + 5 + blen].decode("utf-16-le")
        i += 5 + blen
    return names


def find_id(names: dict, name: str) -> int:
    for k, v in names.items():
        if v == name:
            return k
    raise KeyError(f"name {name!r} not in dict")


def scan_doc(doc: bytes, ids: dict):
    """Linear scan: find each wavetrack StartTag, its name, rate, and block ids.
    Returns list of {"name", "rate", "blocks"} dicts and the project sample rate."""
    wt_id = ids["wavetrack"]      # 21
    name_id = ids["name"]          # 22
    blockid_id = ids["blockid"]    # 48
    rate_id = ids["rate"]          # 4

    # Pre-compute byte signatures
    wt_sig = bytes([0x01]) + struct.pack("<H", wt_id)              # 01 15 00
    name_sig = bytes([0x03]) + struct.pack("<H", name_id)          # 03 16 00
    blk_sig = bytes([0x07]) + struct.pack("<H", blockid_id)        # 07 30 00
    rate_sig = bytes([0x0A]) + struct.pack("<H", rate_id)          # 0A 04 00

    # Project-level sample rate (first rate attribute, before any wavetrack)
    project_rate = 44100
    first_rate = doc.find(rate_sig)
    if first_rate >= 0:
        project_rate = int(struct.unpack_from("<d", doc, first_rate + 3)[0])

    # All wavetrack starts
    wt_starts = []
    p = 0
    while True:
        p = doc.find(wt_sig, p)
        if p < 0:
            break
        wt_starts.append(p)
        p += 1

    tracks = []
    for i, start in enumerate(wt_starts):
        end = wt_starts[i + 1] if i + 1 < len(wt_starts) else len(doc)

        # Name = first occurrence of name_sig within this segment
        track_name = ""
        n = doc.find(name_sig, start, end)
        if n >= 0:
            blen = struct.unpack_from("<I", doc, n + 3)[0]
            track_name = doc[n + 7 : n + 7 + blen].decode("utf-16-le", errors="replace")

        # Per-track rate. Each wavetrack has its own `rate` (Double) attribute.
        # Fall back to the project rate if not present.
        track_rate = project_rate
        r = doc.find(rate_sig, start, end)
        if r >= 0:
            track_rate = int(struct.unpack_from("<d", doc, r + 3)[0])

        # Block IDs in this segment (in document order)
        block_ids = []
        q = start
        while True:
            q = doc.find(blk_sig, q, end)
            if q < 0:
                break
            bid = struct.unpack_from("<Q", doc, q + 3)[0]
            block_ids.append(bid)
            q += 11

        tracks.append({"name": track_name, "rate": track_rate, "blocks": block_ids})

    return tracks, project_rate


def extract_track(db: sqlite3.Connection, blockids: list, sample_rate: int, out_path: str):
    """Read float32 PCM from sampleblocks rows and write 16-bit PCM mono WAV."""
    raw = bytearray()
    cur = db.cursor()
    for bid in blockids:
        row = cur.execute(
            "SELECT sampleformat, samples FROM sampleblocks WHERE blockid = ?", (bid,)
        ).fetchone()
        if row is None:
            print(f"    ! missing blockid {bid}", file=sys.stderr)
            continue
        sample_format, blob = row
        if sample_format != 262159:  # floatSample
            print(f"    ! unexpected sample format {sample_format}", file=sys.stderr)
        raw.extend(blob)

    n = len(raw) // 4
    floats = struct.unpack(f"<{n}f", bytes(raw))
    out = bytearray(n * 2)
    for i, f in enumerate(floats):
        if f >= 1.0:
            v = 32767
        elif f <= -1.0:
            v = -32768
        else:
            v = int(f * 32767.0)
        struct.pack_into("<h", out, i * 2, v)

    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(bytes(out))


def player_slug(filename: str) -> str:
    base = os.path.basename(filename)
    name = base.split(" - ", 1)[0]
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def process_aup3(aup3_path: str):
    slug = player_slug(aup3_path)
    print(f"\n=== {slug}  ({os.path.basename(aup3_path)}) ===")

    db = sqlite3.connect(aup3_path)
    dict_blob = db.execute("SELECT dict FROM project").fetchone()[0]
    doc_blob = db.execute("SELECT doc FROM project").fetchone()[0]
    names = parse_dict(dict_blob)

    ids = {n: find_id(names, n) for n in ("wavetrack", "name", "blockid", "rate")}
    tracks, project_rate = scan_doc(doc_blob, ids)

    print(f"  project rate: {project_rate}")
    print(f"  wavetracks:   {len(tracks)}")

    for t in tracks:
        # Estimate duration using this track's own sample rate
        total_samples = 0
        for bid in t["blocks"]:
            row = db.execute(
                "SELECT length(samples) FROM sampleblocks WHERE blockid = ?", (bid,)
            ).fetchone()
            if row:
                total_samples += row[0] // 4
        t["duration"] = total_samples / t["rate"] if t["rate"] else 0
        print(f"    {t['name']!r}: rate={t['rate']}  blocks={t['blocks']}  ~{t['duration']:.2f}s")

    if len(tracks) < 2:
        print("  ! fewer than 2 tracks, skipping")
        db.close()
        return

    # Heuristic: shortest = announcement, longest = music
    tracks_sorted = sorted(tracks, key=lambda t: t["duration"])
    ann = tracks_sorted[0]
    music = tracks_sorted[-1]
    print(f"  → announcement: {ann['name']!r} @ {ann['rate']}Hz, music: {music['name']!r} @ {music['rate']}Hz")

    extract_track(db, ann["blocks"], ann["rate"], os.path.join(ANN_OUT, f"{slug}.wav"))
    print(f"  ✓ announcement → {os.path.join(ANN_OUT, slug + '.wav')}")
    extract_track(db, music["blocks"], music["rate"], os.path.join(MUSIC_OUT, f"{slug}.wav"))
    print(f"  ✓ music        → {os.path.join(MUSIC_OUT, slug + '.wav')}")
    db.close()


def main():
    os.makedirs(ANN_OUT, exist_ok=True)
    os.makedirs(MUSIC_OUT, exist_ok=True)

    files = sorted(glob.glob(os.path.join(SOURCE_DIR, "*.aup3")))
    if not files:
        sys.exit(f"No .aup3 files in {SOURCE_DIR}")

    print(f"Found {len(files)} projects.")
    for f in files:
        try:
            process_aup3(f)
        except Exception as e:
            import traceback
            print(f"  ! error: {e}")
            traceback.print_exc()

    print("\nDone.")


if __name__ == "__main__":
    main()
