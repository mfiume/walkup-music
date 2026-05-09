#!/usr/bin/env python3
"""Generate iOS apple-touch-icon and PWA manifest icons:
gold Bloordale B on a green gradient. Writes 180/192/512 PNGs."""

from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B_PNG = os.path.join(ROOT, "icon-bloordale-b.png")

SIZES = [
    (180, "icon-180.png"),     # Apple touch icon
    (192, "icon-192.png"),     # PWA manifest
    (512, "icon-512.png"),     # PWA manifest
]

GREEN_TOP = (38, 119, 60)
GREEN_BOT = (10, 36, 20)
GOLD = (245, 197, 24)


def vertical_gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), GREEN_TOP + (255,))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(GREEN_TOP[0] + (GREEN_BOT[0] - GREEN_TOP[0]) * t)
        g = int(GREEN_TOP[1] + (GREEN_BOT[1] - GREEN_TOP[1]) * t)
        b = int(GREEN_TOP[2] + (GREEN_BOT[2] - GREEN_TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def add_top_highlight(img: Image.Image) -> None:
    """Soft radial highlight from upper-center to give the icon depth."""
    size = img.size[0]
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    cx = size // 2
    cy = int(size * 0.28)
    rmax = int(size * 0.55)
    for r in range(rmax, 0, -8):
        a = int(60 * (1 - r / rmax) ** 2)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 245, 200, a))
    overlay = overlay.filter(ImageFilter.GaussianBlur(size // 18))
    img.alpha_composite(overlay)


def colored_b(target_h: int, color: tuple) -> Image.Image:
    src = Image.open(B_PNG).convert("RGBA")
    alpha = src.getchannel("A")
    flat = Image.new("RGBA", src.size, color + (255,))
    flat.putalpha(alpha)
    w0, h0 = flat.size
    target_w = int(round(w0 * target_h / h0))
    return flat.resize((target_w, target_h), Image.LANCZOS)


def make_icon(size: int, out_path: str) -> None:
    img = vertical_gradient(size)
    add_top_highlight(img)

    # B sized to ~62% of the icon height — generous breathing room around it
    # because iOS rounds the corners aggressively.
    b = colored_b(int(size * 0.62), GOLD)
    bw, bh = b.size
    bx = (size - bw) // 2
    # Slight optical-center adjustment: a blackletter B is heavier on the
    # bottom, so shift it up a hair so it reads visually centered.
    by = (size - bh) // 2 - int(size * 0.015)

    # Soft drop shadow under the B
    sh_alpha = b.getchannel("A").point(lambda v: int(v * 0.55))
    shadow = Image.new("RGBA", b.size, (0, 0, 0, 0))
    shadow.putalpha(sh_alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, size // 70)))
    img.alpha_composite(shadow, (bx + max(1, size // 130), by + max(2, size // 90)))

    img.alpha_composite(b, (bx, by))

    img.convert("RGB").save(out_path, "PNG", optimize=True)


def main() -> None:
    for size, fname in SIZES:
        out = os.path.join(ROOT, fname)
        make_icon(size, out)
        print(f"  ✓ {fname} ({size}x{size}, {os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
