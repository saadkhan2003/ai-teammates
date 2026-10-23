"""Safe thumbnail generation for Library blobs in the computer sandbox."""
from __future__ import annotations

import io
import subprocess
import tempfile
import warnings
from pathlib import Path

from PIL import Image, ImageOps

MAX_PIXELS = 50_000_000
TIMEOUT_SECONDS = 20
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def generate_thumbnail(data: bytes, kind: str) -> bytes:
    if not data:
        raise ValueError("empty blob")
    try:
        if kind == "video":
            with tempfile.TemporaryDirectory(prefix="library-thumb-") as temp:
                source = Path(temp) / "source.bin"
                target = Path(temp) / "poster.png"
                source.write_bytes(data)
                subprocess.run(["ffmpeg", "-v", "error", "-ss", "1", "-i", str(source), "-frames:v", "1", str(target)], check=True, timeout=TIMEOUT_SECONDS, capture_output=True)
                image = Image.open(target)
                return _webp(image)
        if kind == "pdf":
            with tempfile.TemporaryDirectory(prefix="library-thumb-") as temp:
                source = Path(temp) / "source.pdf"
                target = Path(temp) / "page.png"
                source.write_bytes(data)
                subprocess.run(["pdftoppm", "-f", "1", "-l", "1", "-singlefile", "-scale-to", "512", "-png", str(source), str(target.with_suffix(""))], check=True, timeout=TIMEOUT_SECONDS, capture_output=True)
                image = Image.open(target)
                return _webp(image)
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
            if image.width * image.height > MAX_PIXELS:
                raise ValueError("image exceeds pixel cap")
            image.load()
            return _webp(image)
    except (OSError, subprocess.SubprocessError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("thumbnail generation failed") from exc


def _webp(image: Image.Image) -> bytes:
    image = ImageOps.exif_transpose(image)
    image.thumbnail((256, 256), Image.Resampling.LANCZOS)
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "transparency" in image.info else "RGB")
    out = io.BytesIO()
    image.save(out, "WEBP", quality=78, method=4, exif=b"")
    return out.getvalue()
