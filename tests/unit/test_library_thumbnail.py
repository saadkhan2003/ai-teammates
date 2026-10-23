import io
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "computer" / "src"))
import library_thumbnail


def encoded(fmt: str, size=(24, 16)) -> bytes:
    image = Image.new("RGB", size, (35, 90, 150))
    out = io.BytesIO()
    image.save(out, fmt)
    return out.getvalue()


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
def test_image_formats_become_small_metadata_free_webp(fmt):
    result = library_thumbnail.generate_thumbnail(encoded(fmt, (600, 400)), "image")
    with Image.open(io.BytesIO(result)) as thumb:
        assert thumb.format == "WEBP"
        assert max(thumb.size) <= 256
        assert thumb.getexif() == {}


def test_pdf_thumbnail_when_pdftoppm_is_installed():
    import shutil
    if shutil.which("pdftoppm") is None:
        pytest.skip("pdftoppm is not installed")
    pdf = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"
    assert Image.open(io.BytesIO(library_thumbnail.generate_thumbnail(pdf, "pdf"))).format == "WEBP"


def test_decompression_bomb_rejected(monkeypatch):
    monkeypatch.setattr(library_thumbnail, "MAX_PIXELS", 100)
    with pytest.raises(ValueError):
        library_thumbnail.generate_thumbnail(encoded("PNG", (20, 20)), "image")


def test_corrupt_input_fails_closed():
    with pytest.raises(ValueError):
        library_thumbnail.generate_thumbnail(b"not an image", "image")
