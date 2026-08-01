#!/usr/bin/env python3
"""Sync a public Suno playlist into the app as local, offline-playable audio.

Suno serves its playlist pages with `frame-ancestors 'none'`, so there is no
iframe embed to drop in the way Spotify has one. Its public playlist API is
readable though, and every clip exposes a direct MP3 on cdn1.suno.ai. So we
mirror the playlist at build time: download each track + its cover art into
`audio/suno/`, and write `suno-playlist.json` for the app to render.

Mirroring (rather than streaming from the CDN at runtime) buys two things the
rest of this app already depends on: the service worker can cache the files
for a no-signal ball field, and the browser never has to reach an API that
sends no CORS headers.

Re-run any time the playlist changes in Suno:

    python3 scripts/sync_suno_playlist.py

Existing downloads are skipped, so a re-run only fetches what's new.
"""

import json
import pathlib
import re
import sys
import urllib.request

PLAYLIST_ID = "f5dc5fd1-9dc5-4dd0-baaf-c9a19441e943"
API = "https://studio-api.prod.suno.com/api/playlist/{}/?page={}"

ROOT = pathlib.Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "audio" / "suno"
ART_DIR = AUDIO_DIR / "art"
MANIFEST = ROOT / "suno-playlist.json"

# The API 403s a bare urllib user agent.
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s or "track"


def download(url: str, dest: pathlib.Path) -> bool:
    """Fetch url to dest unless it's already there. True if it downloaded."""
    if dest.exists() and dest.stat().st_size > 0:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(get(url))
    return True


def fetch_playlist() -> dict:
    """Read every page of the playlist and return the merged clip list."""
    first = json.loads(get(API.format(PLAYLIST_ID, 0)))
    clips = list(first.get("playlist_clips", []))
    total = first.get("num_total_results", len(clips))
    page = 1
    while len(clips) < total:
        more = json.loads(get(API.format(PLAYLIST_ID, page)))
        batch = more.get("playlist_clips", [])
        if not batch:
            break
        clips.extend(batch)
        page += 1
    first["playlist_clips"] = clips
    return first


def main() -> int:
    playlist = fetch_playlist()
    clips = playlist["playlist_clips"]
    print(f'Playlist "{playlist.get("name")}" — {len(clips)} track(s)')

    tracks = []
    seen_slugs = set()
    for entry in clips:
        clip = entry["clip"]
        if clip.get("status") != "complete" or not clip.get("audio_url"):
            print(f'  skip (not playable): {clip.get("title")}')
            continue

        slug = slugify(clip["title"])
        # Two clips can share a title; keep filenames unique and stable.
        while slug in seen_slugs:
            slug = f'{slug}-{clip["id"][:4]}'
        seen_slugs.add(slug)

        audio_rel = f"audio/suno/{slug}.mp3"
        got_audio = download(clip["audio_url"], ROOT / audio_rel)

        art_rel = None
        art_url = clip.get("image_large_url") or clip.get("image_url")
        if art_url:
            art_rel = f"audio/suno/art/{slug}.jpeg"
            download(art_url, ROOT / art_rel)

        metadata = clip.get("metadata") or {}
        tracks.append({
            "id": clip["id"],
            "title": clip["title"],
            "file": audio_rel,
            "art": art_rel,
            "duration": round(metadata.get("duration") or 0, 1),
            "tags": clip.get("display_tags") or "",
            "url": f'https://suno.com/song/{clip["id"]}',
        })
        print(f'  {"↓" if got_audio else "·"} {clip["title"]}  →  {audio_rel}')

    # Drop files for songs that are no longer in the playlist, so removing a
    # song in Suno doesn't leave 4 MB of dead weight in the repo forever.
    keep = {ROOT / t["file"] for t in tracks}
    keep |= {ROOT / t["art"] for t in tracks if t["art"]}
    for existing in list(AUDIO_DIR.glob("*.mp3")) + list(ART_DIR.glob("*")):
        if existing.is_file() and existing not in keep:
            existing.unlink()
            print(f"  ✕ removed {existing.relative_to(ROOT)} (no longer in playlist)")

    manifest = {
        "id": PLAYLIST_ID,
        "name": playlist.get("name") or "Suno",
        "url": f"https://suno.com/playlist/{PLAYLIST_ID}",
        "creator": playlist.get("user_display_name") or "",
        "tracks": tracks,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {MANIFEST.relative_to(ROOT)} ({len(tracks)} tracks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
