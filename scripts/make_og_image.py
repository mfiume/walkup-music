#!/usr/bin/env python3
"""Generate a 1200x630 Open Graph social card for the Bloordale walk-up app.

Layout: large gold blackletter "B" (the team mark, recolored from
icon-bloordale-b.png) on the left, two-line wordmark and a small caption
on the right, on a deep green gradient with a subtle gold accent line.
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B_PNG = os.path.join(ROOT, "icon-bloordale-b.png")
OUT = os.path.join(ROOT, "og-image.png")

W, H = 1200, 630

GREEN_TOP = (35, 110, 55)        # lit green
GREEN_BOT = (12, 38, 22)         # deeper, near-black green
GOLD = (245, 197, 24)
GOLD_LIGHT = (255, 224, 101)
CREAM = (247, 243, 226)
CREAM_DIM = (199, 197, 175)
ACCENT_DIVIDER = (245, 197, 24, 200)

FONTS = {
    "black": "/System/Library/Fonts/Helvetica.ttc",
    "neue":  "/System/Library/Fonts/HelveticaNeue.ttc",
    "avenir":"/System/Library/Fonts/Avenir Next.ttc",
    "avenir_cond": "/System/Library/Fonts/Avenir Next Condensed.ttc",
}


def load_font(path: str, size: int, idx: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size, index=idx)


def vertical_gradient(w: int, h: int, top: tuple, bot: tuple) -> Image.Image:
    img = Image.new("RGB", (w, h), top)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def add_radial_highlight(img: Image.Image, cx: int, cy: int, radius: int, strength: int) -> None:
    """Soft radial light from (cx, cy)."""
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for r in range(radius, 0, -10):
        a = int(strength * (1 - r / radius) ** 2)
        draw.ellipse(
            (cx - r, cy - r, cx + r, cy + r),
            fill=(255, 255, 230, a),
        )
    overlay = overlay.filter(ImageFilter.GaussianBlur(40))
    img.alpha_composite(overlay)


def colored_logo(b_path: str, target_h: int, color: tuple) -> Image.Image:
    """Load the B PNG, recolor its silhouette to `color`, scale to target_h."""
    src = Image.open(b_path).convert("RGBA")
    # Use the alpha channel as a mask, paint with color
    alpha = src.getchannel("A")
    flat = Image.new("RGBA", src.size, color + (255,))
    flat.putalpha(alpha)
    # Resize maintaining aspect
    w0, h0 = flat.size
    new_w = int(w0 * target_h / h0)
    flat = flat.resize((new_w, target_h), Image.LANCZOS)
    return flat


def main() -> None:
    # Background gradient
    bg = vertical_gradient(W, H, GREEN_TOP, GREEN_BOT).convert("RGBA")
    add_radial_highlight(bg, cx=W // 3, cy=int(H * 0.25), radius=520, strength=70)

    # Subtle baseball stitching motif (very faint diagonal lines)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for x in range(-H, W + H, 60):
        od.line([(x, 0), (x + H, H)], fill=(255, 255, 255, 6), width=1)
    bg.alpha_composite(overlay)

    # Big gold B with shadow
    b_height = 460
    b = colored_logo(B_PNG, b_height, GOLD)
    bx = 70
    by = (H - b.height) // 2

    # Drop shadow
    sh_alpha = b.getchannel("A").point(lambda v: int(v * 0.55))
    shadow_dark = Image.new("RGBA", b.size, (0, 0, 0, 0))
    shadow_dark.putalpha(sh_alpha)
    sh_blurred = shadow_dark.filter(ImageFilter.GaussianBlur(14))
    bg.alpha_composite(sh_blurred, (bx + 14, by + 18))

    bg.alpha_composite(b, (bx, by))

    # Right column: wordmark + caption
    text_x = bx + b.width + 60
    draw = ImageDraw.Draw(bg)

    # Pick a brand size that fits the available width (auto-shrink loop)
    avail_w = W - text_x - 60
    f_brand = None
    for size in (130, 120, 110, 100, 92):
        candidate = load_font(FONTS["avenir_cond"], size, idx=4)  # Heavy
        bbox = draw.textbbox((0, 0), "BLOORDALE", font=candidate)
        if (bbox[2] - bbox[0]) <= avail_w:
            f_brand = candidate
            break
    if f_brand is None:
        f_brand = load_font(FONTS["avenir_cond"], 92, idx=4)

    f_team    = load_font(FONTS["avenir_cond"], 70, idx=4)
    f_kicker  = load_font(FONTS["avenir"], 24, idx=4)
    f_caption = load_font(FONTS["neue"], 28, idx=2)

    # Tracking-y mini kicker above brand
    draw.text((text_x, 120), "GAME DAY · WALK-UP", font=f_kicker, fill=CREAM_DIM, spacing=4)

    # Team name (vertically anchored from top of B-text area)
    draw.text((text_x, 162), "BLOORDALE", font=f_brand, fill=GOLD)
    draw.text((text_x, 295), "BOMBERS", font=f_team, fill=CREAM)

    # Gold rule
    draw.line([(text_x, 395), (text_x + 320, 395)], fill=GOLD, width=4)

    # Subtitle/caption
    draw.text((text_x, 418),
              "Announcements + walk-up music",
              font=f_caption, fill=CREAM_DIM)
    draw.text((text_x, 458),
              "for every batter, every at-bat.",
              font=f_caption, fill=CREAM_DIM)

    # Bottom-right URL
    f_url = load_font(FONTS["neue"], 22, idx=2)
    url_text = "mfiume.github.io/walkup-music"
    bbox = draw.textbbox((0, 0), url_text, font=f_url)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((W - tw - 56, H - th - 50), url_text, font=f_url, fill=GOLD)

    # Vignette in corners
    vignette = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vignette)
    vd.rectangle([0, 0, W, H], fill=(0, 0, 0, 0))
    # darken edges
    for i in range(60):
        a = int((1 - i / 60) * 90)
        vd.rectangle([i, i, W - i, H - i], outline=(0, 0, 0, a))
    bg.alpha_composite(vignette)

    bg.convert("RGB").save(OUT, "PNG", optimize=True)
    print(f"Wrote {OUT} — {os.path.getsize(OUT) // 1024} KB")


if __name__ == "__main__":
    main()
