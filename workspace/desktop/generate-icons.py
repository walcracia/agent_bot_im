"""Rasterize the existing application SVG into local Windows icons (development only)."""
from base64 import b64decode, b64encode
from pathlib import Path
import struct

from playwright.sync_api import sync_playwright


def generate():
    desktop = Path(__file__).resolve().parent
    source = (desktop.parent / "client/logo.svg").read_bytes()
    destination = desktop / "assets"
    destination.mkdir(exist_ok=True)
    raster = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        try:
            page = browser.new_page()
            for size in (16, 32, 48, 256):
                for unread in (False, True) if size == 32 else (False,):
                    value = page.evaluate("""async ({svg, size, unread}) => {
                        const image = new Image(); image.src = 'data:image/svg+xml;base64,' + svg;
                        await image.decode();
                        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
                        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, size, size);
                        if (unread) {
                            context.beginPath(); context.arc(size * .80, size * .20, size * .17, 0, Math.PI * 2);
                            context.fillStyle = '#e35d6a'; context.fill();
                            context.lineWidth = size / 18; context.strokeStyle = '#171a1d'; context.stroke();
                        }
                        return canvas.toDataURL('image/png').split(',')[1];
                    }""", {"svg": b64encode(source).decode(), "size": size, "unread": unread})
                    data = b64decode(value)
                    if unread:
                        (destination / "tray-unread.png").write_bytes(data)
                    else:
                        raster[size] = data
            (destination / "tray.png").write_bytes(raster[32])
            (destination / "app.png").write_bytes(raster[256])
        finally:
            browser.close()
    entries = []; offset = 6 + len(raster) * 16
    for size, data in raster.items():
        entries.append(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    (destination / "app.ico").write_bytes(struct.pack('<HHH', 0, 1, len(raster)) + b''.join(entries) + b''.join(raster.values()))


if __name__ == '__main__':
    generate()
