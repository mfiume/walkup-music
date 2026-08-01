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
    """Fetch url to dest unless it's already there. True if it downloaded.

    Only safe for content that never changes under a stable URL — the audio for
    a given clip id. Cover art is NOT safe this way; see download_if_changed.
    """
    if dest.exists() and dest.stat().st_size > 0:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(get(url))
    return True


def download_if_changed(url: str, dest: pathlib.Path) -> bool:
    """Fetch url and write it only when the bytes differ. True if it changed.

    Replacing a song's artwork in Suno keeps the same image URL, so an
    exists-check would pin the app to the old cover forever. Art is small
    enough (~100 KB) to just re-fetch and compare every sync.
    """
    data = get(url)
    if dest.exists() and dest.read_bytes() == data:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return True


def previous_files_by_id() -> dict:
    """{clip_id: relative audio path} from the last sync, for rename detection.

    Filenames come from the title, so renaming a song in Suno would otherwise
    re-download several MB just to store identical audio under a new name.
    """
    if not MANIFEST.exists():
        return {}
    try:
        old = json.loads(MANIFEST.read_text())
        return {t["id"]: t["file"] for t in old.get("tracks", []) if t.get("id")}
    except (ValueError, KeyError):
        return {}


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

    was = previous_files_by_id()

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
        art_rel = f"audio/suno/art/{slug}.jpeg"

        # Retitled in Suno: move what we already have rather than re-fetching
        # bytes we're holding under the old name.
        old_rel = was.get(clip["id"])
        if old_rel and old_rel != audio_rel and (ROOT / old_rel).exists():
            (ROOT / audio_rel).parent.mkdir(parents=True, exist_ok=True)
            (ROOT / old_rel).replace(ROOT / audio_rel)
            old_art = ROOT / old_rel.replace("audio/suno/", "audio/suno/art/").replace(".mp3", ".jpeg")
            if old_art.exists():
                (ROOT / art_rel).parent.mkdir(parents=True, exist_ok=True)
                old_art.replace(ROOT / art_rel)
            print(f'  ⇄ renamed  {old_rel}  →  {audio_rel}')

        got_audio = download(clip["audio_url"], ROOT / audio_rel)

        art_url = clip.get("image_large_url") or clip.get("image_url")
        new_art = False
        if art_url:
            new_art = download_if_changed(art_url, ROOT / art_rel)
        else:
            art_rel = None

        metadata = clip.get("metadata") or {}
        tracks.append({
            "id": clip["id"],
            "title": clip["title"],
            # The caption is the one-line note set on the song in Suno, and the
            # only subtext the app shows. `tags` below is mirrored for
            # reference only — the UI deliberately never displays it.
            "caption": (clip.get("caption") or "").strip(),
            "file": audio_rel,
            "art": art_rel,
            "duration": round(metadata.get("duration") or 0, 1),
            "tags": clip.get("display_tags") or "",
            "url": f'https://suno.com/song/{clip["id"]}',
        })
        flags = "".join(["↓" if got_audio else "·", "🖼" if new_art else ""])
        cap = clip.get("caption") or ""
        print(f'  {flags} {clip["title"]}  →  {audio_rel}'
              + (f'   caption: "{cap}"' if cap else "   (no caption)"))

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
