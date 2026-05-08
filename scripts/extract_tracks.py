#!/usr/bin/env python3
"""
Extract separate announcement and music tracks from each .aup3 in
"~/Downloads/10U Songs/" by driving Audacity over mod-script-pipe.

Heuristic for which track is which:
  - The shorter track is the announcement.
  - The longer track is the walk-up music.

Output:
  audio/simple/announcements/<firstname>.wav   (extracted announcement)
  audio/simple/walkups-clean/<firstname>.wav   (music with no announcement overlay)

Prereq: enable mod-script-pipe in Audacity Preferences → Modules,
then restart Audacity and leave it running before invoking this script.
"""

import json
import os
import sys
import time
import glob
import re

UID = os.getuid()
TO_NAME = f"/tmp/audacity_script_pipe.to.{UID}"
FROM_NAME = f"/tmp/audacity_script_pipe.from.{UID}"

SOURCE_DIR = "/Users/mfiume/Downloads/10U Songs"
ANN_OUT = "/Users/mfiume/Development/walkup-music/audio/simple/announcements"
MUSIC_OUT = "/Users/mfiume/Development/walkup-music/audio/simple/walkups-clean"

# Map "Adrian - Fair Trade.aup3" -> "adrian"
def player_slug(filename: str) -> str:
    base = os.path.basename(filename)
    name = base.split(" - ", 1)[0]
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


class AudacityPipe:
    def __init__(self):
        if not os.path.exists(TO_NAME):
            sys.exit(
                f"Audacity pipe not found at {TO_NAME}.\n"
                "Enable mod-script-pipe in Audacity → Preferences → Modules, "
                "then restart Audacity and try again."
            )
        # Pipe is line-buffered text
        self.tof = open(TO_NAME, "w")
        self.fromf = open(FROM_NAME, "r")

    def send(self, cmd: str, expect_response: bool = True) -> str:
        self.tof.write(cmd + "\n")
        self.tof.flush()
        if not expect_response:
            return ""
        # Audacity replies with one or more lines, then a blank line.
        out_lines = []
        while True:
            line = self.fromf.readline()
            if line is None:
                break
            if line in ("\n", ""):
                break
            out_lines.append(line)
        return "".join(out_lines)

    def get_tracks(self) -> list:
        raw = self.send("GetInfo: Type=Tracks Format=JSON")
        # Strip any trailing "BatchCommand finished: OK" lines
        m = re.search(r"\[.*\]", raw, re.DOTALL)
        if not m:
            return []
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return []


def main():
    os.makedirs(ANN_OUT, exist_ok=True)
    os.makedirs(MUSIC_OUT, exist_ok=True)

    files = sorted(glob.glob(os.path.join(SOURCE_DIR, "*.aup3")))
    if not files:
        sys.exit(f"No .aup3 files in {SOURCE_DIR}")

    pipe = AudacityPipe()
    print(f"Found {len(files)} projects.")

    for f in files:
        slug = player_slug(f)
        print(f"\n=== {slug}  ({os.path.basename(f)}) ===")

        # Open the project
        pipe.send(f'OpenProject2: Filename="{f}"')
        # Give Audacity a beat to load the project
        time.sleep(1.0)

        tracks = pipe.get_tracks()
        if not tracks:
            print("  ! could not enumerate tracks, skipping")
            pipe.send("Close:")
            continue

        # Compute durations: end - start
        for t in tracks:
            t["__dur"] = float(t.get("end", 0)) - float(t.get("start", 0))

        # Sort by duration: shortest = announcement, longest = music
        ordered = sorted(enumerate(tracks), key=lambda kv: kv[1]["__dur"])
        ann_idx = ordered[0][0]
        music_idx = ordered[-1][0]
        print(
            f"  tracks: {[(i, round(t['__dur'], 1), t.get('name','')) for i, t in enumerate(tracks)]}"
        )
        print(f"  → announcement = track {ann_idx}, music = track {music_idx}")

        # Export each track in turn by soloing it (mute all, unmute the one)
        for kind, idx, out_dir in [
            ("announcement", ann_idx, ANN_OUT),
            ("music", music_idx, MUSIC_OUT),
        ]:
            # Solo: unmute all → mute all → select target → unmute selection
            pipe.send("SelectAll:")
            pipe.send("UnmuteAllTracks:")
            pipe.send("MuteAllTracks:")
            pipe.send(f"SelectTracks: Track={idx} TrackCount=1 Mode=Set")
            pipe.send("UnmuteTracks:")
            # Select the audio of the soloed track for export
            pipe.send("SelTrackStartToEnd:")

            out_path = os.path.join(out_dir, f"{slug}.wav")
            # Remove existing so Audacity doesn't prompt
            if os.path.exists(out_path):
                os.remove(out_path)
            pipe.send(f'Export2: Filename="{out_path}" NumChannels=2')
            print(f"  ✓ {kind:13s} → {out_path}")

        # Close without saving
        pipe.send("Close:")
        time.sleep(0.4)

    print("\nDone.")


if __name__ == "__main__":
    main()
