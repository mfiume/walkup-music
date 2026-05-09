#!/usr/bin/env python3
"""Take the Bloordale 'B' thumbnail, knock the white background out to
transparent, trim, and save as a PNG ready to drop into the header."""

from PIL import Image
import os

SRC = "/tmp/bloordale.jpg"
OUT_PNG = "/Users/mfiume/Development/walkup-music/icon-bloordale-b.png"


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    px = img.load()
    w, h = img.size

    # Make near-white pixels transparent. The logo is dark green so anything
    # bright is background. We feather the alpha across the threshold band so
    # edges stay smooth.
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            brightness = (r + g + b) / 3
            if brightness >= 240:
                px[x, y] = (0, 0, 0, 0)
            elif brightness >= 200:
                # Edge feather: darker → more opaque
                alpha = int((240 - brightness) / 40 * 255)
                # Pull the colour toward the dark green of the logo
                px[x, y] = (29, 75, 47, alpha)
            # else: keep the original dark-green pixel as-is

    # Trim transparent borders
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)

    img.save(OUT_PNG, "PNG", optimize=True)
    print(f"Wrote {OUT_PNG} ({os.path.getsize(OUT_PNG)} bytes), size={img.size}")


if __name__ == "__main__":
    main()
