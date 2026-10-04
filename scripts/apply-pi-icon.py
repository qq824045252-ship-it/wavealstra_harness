"""
Apply official Pi (pi.dev) icons as the sole MyBuddy app + tray branding.

Sources (kept under build/pi-source/):
  - https://pi.dev/favicon.svg  — rounded black field + white mark (app/tray)
  - https://pi.dev/logo.svg     — transparent white mark (reference)

Writes only the production paths used by Electron / electron-builder.
"""
from __future__ import annotations

import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
ASSETS = ROOT / "src" / "main" / "assets"
SOURCE = BUILD / "pi-source"

# Official Pi favicon geometry (viewBox 0 0 800 800)
CANVAS = 800
RX = 120  # rounded rect corner
# P stem + bowl + i-dot from https://pi.dev/favicon.svg
P_OUTER = [(165.29, 165.29), (517.36, 165.29), (517.36, 400), (400, 400), (400, 517.36), (282.65, 517.36), (282.65, 634.72), (165.29, 634.72)]
P_HOLE = [(282.65, 282.65), (400, 282.65), (400, 400), (282.65, 400)]
I_DOT = [(517.36, 400), (634.72, 400), (634.72, 634.72), (517.36, 634.72)]

BG = (9, 9, 11, 255)  # #09090b
FG = (255, 255, 255, 255)

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
PNG_APP = 1024
PNG_512 = 512


def draw_pi_mark(size: int) -> Image.Image:
    """Rasterize official Pi mark on rounded black field at `size` px."""
    scale = size / CANVAS
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)

    # Rounded square background
    r = max(1, int(RX * scale))
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=BG)

    def sx(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
        return [(x * scale, y * scale) for x, y in pts]

    # Even-odd P: outer then hole
    draw.polygon(sx(P_OUTER), fill=FG)
    draw.polygon(sx(P_HOLE), fill=BG)
    draw.polygon(sx(I_DOT), fill=FG)
    return im


def save_png(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "PNG", optimize=True)
    print(f"PNG {path.relative_to(ROOT)} {im.size} {path.stat().st_size} B")


def write_ico(im: Image.Image, path: Path, sizes: tuple[int, ...] = ICO_SIZES) -> None:
    """
    Write a multi-size ICO with embedded PNG frames (Vista+).
    Pillow's default ICO writer often collapses to a single 16px entry;
    we pack PNG payloads ourselves for reliable Windows taskbar/tray.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    frames: list[tuple[int, bytes]] = []
    for s in sizes:
        frame = im.resize((s, s), Image.Resampling.LANCZOS) if im.size != (s, s) else im.copy()
        if frame.size != (s, s):
            frame = frame.resize((s, s), Image.Resampling.LANCZOS)
        from io import BytesIO

        buf = BytesIO()
        frame.save(buf, format="PNG")
        frames.append((s, buf.getvalue()))

    # ICONDIR + ICONDIRENTRY*n + image data
    count = len(frames)
    header = struct.pack("<HHH", 0, 1, count)
    entries = bytearray()
    payload = bytearray()
    offset = 6 + 16 * count
    for s, data in frames:
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)

    path.write_bytes(header + bytes(entries) + bytes(payload))
    print(f"ICO {path.relative_to(ROOT)} {path.stat().st_size} B sizes={sizes}")


def main() -> None:
    SOURCE.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    master = draw_pi_mark(PNG_APP)
    master512 = master.resize((PNG_512, PNG_512), Image.Resampling.LANCZOS)

    # electron-builder + packaging
    save_png(master, BUILD / "icon.png")
    save_png(master512, BUILD / "icon-512.png")
    write_ico(master, BUILD / "icon.ico")

    # tray mirrors (packaged copies; runtime uses assets/)
    save_png(master, BUILD / "tray.png")
    write_ico(master, BUILD / "tray.ico")

    # runtime Electron assets
    save_png(master, ASSETS / "app.png")
    save_png(master512, ASSETS / "app-512.png")
    write_ico(master, ASSETS / "app.ico")
    save_png(master, ASSETS / "tray.png")
    write_ico(master, ASSETS / "tray.ico")

    print("Applied official Pi icons from https://pi.dev/favicon.svg")
    print("Production paths: build/icon.*  build/tray.*  src/main/assets/app.*  src/main/assets/tray.*")


if __name__ == "__main__":
    main()
