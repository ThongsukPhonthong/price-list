"""Export configured Google Sheets tabs to PNGs for GitHub Pages."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import fitz
import requests


# Fill each gid from the Google Sheets URL (?gid=...). SHEET_ID comes from the
# environment and must never be stored in this committed file.
SHEETS = {
    "mookata": "680600051",
    "shabu": "1177642641",
    "grocery": "1002",
    "squid": "1636193476",
}
BASE_URL = "https://USERNAME.github.io/price-list"
DPI = 150
EXPECTED_PAGES = 2
PDF_OPTIONS = {
    "size": "A4",
    "portrait": "true",
    "scale": "2",
    "gridlines": "false",
    "printtitle": "false",
    "sheetnames": "false",
    "pagenum": "UNDEFINED",
    "fzr": "true",
    "top_margin": "0.3",
    "bottom_margin": "0.3",
    "left_margin": "0.3",
    "right_margin": "0.3",
}

ROOT = Path(__file__).resolve().parent
PDF_DIR = ROOT / "output_pdf"
DOCS_DIR = ROOT / "docs"
LINKS_FILE = ROOT / "links.txt"
MAX_IMAGE_BYTES = 10 * 1024 * 1024


class ExportError(Exception):
    """An actionable error while exporting a sheet."""


def download_pdf(session: requests.Session, sheet_id: str, gid: str, name: str) -> bytes:
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export"
    params = {"format": "pdf", "gid": gid, **PDF_OPTIONS}
    try:
        response = session.get(url, params=params, timeout=(20, 120))
    except requests.RequestException as exc:
        raise ExportError(f"Network error downloading {name}: {exc}") from exc
    if response.status_code != 200:
        detail = "Google Sheets did not return a PDF. Check sharing settings and SHEET_ID."
        if response.status_code in (401, 403):
            detail = "Google Sheet access denied. Share it as Anyone with the link (Viewer)."
        raise ExportError(f"Download for {name} failed (HTTP {response.status_code}). {detail}")
    if not response.content.startswith(b"%PDF"):
        raise ExportError(
            f"Download for {name} was not a PDF. Check SHEET_ID, gid, and sheet sharing settings."
        )
    return response.content


def render_pdf(pdf_bytes: bytes, name: str) -> list[Path]:
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except (fitz.FileDataError, RuntimeError) as exc:
        raise ExportError(f"Could not open the downloaded PDF for {name}: {exc}") from exc

    paths: list[Path] = []
    try:
        if len(document) != EXPECTED_PAGES:
            print(
                f"WARNING: {name} has {len(document)} pages; expected {EXPECTED_PAGES}.",
                file=sys.stderr,
            )
        for page_number, page in enumerate(document, start=1):
            output = DOCS_DIR / f"{name}_{page_number}.png"
            page.get_pixmap(dpi=DPI, alpha=False).save(output)
            size = output.stat().st_size
            if size > MAX_IMAGE_BYTES:
                print(
                    f"WARNING: {output.name} is {size / 1024 / 1024:.1f} MB; LINE limit is 10 MB.",
                    file=sys.stderr,
                )
            paths.append(output)
    finally:
        document.close()
    return paths


def run_git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=ROOT, text=True, encoding="utf-8", errors="replace",
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=check,
    )


def publish() -> None:
    try:
        pull = run_git("pull", "--rebase", "--autostash", check=False)
    except FileNotFoundError as exc:
        raise ExportError("Git was not found. Install Git or run with --no-git.") from exc
    if pull.returncode:
        raise ExportError(f"git pull failed; resolve repository issues and retry:\n{pull.stdout.strip()}")

    run_git("add", "docs")
    staged = run_git("diff", "--cached", "--quiet", check=False)
    if staged.returncode == 0:
        print("No published files changed; skipping commit and push.")
        return
    if staged.returncode != 1:
        raise ExportError(f"Could not inspect staged changes:\n{staged.stdout.strip()}")
    run_git("commit", "-m", "Update price list images")
    pushed = run_git("push", check=False)
    if pushed.returncode:
        raise ExportError(f"git push failed:\n{pushed.stdout.strip()}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-git", action="store_true", help="Generate PDFs and PNGs without pulling or pushing")
    args = parser.parse_args()

    sheet_id = os.environ.get("SHEET_ID", "").strip()
    if not sheet_id:
        print("ERROR: SHEET_ID environment variable is required.", file=sys.stderr)
        return 1

    failures: list[str] = []
    all_images: list[Path] = []
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    with requests.Session() as session:
        session.headers["User-Agent"] = "PriceListExporter/1.0"
        for name, gid in SHEETS.items():
            try:
                # Remove stale pages even when a new download fails, so the
                # public docs folder cannot silently present outdated prices.
                for old_file in DOCS_DIR.glob(f"{name}_*.png"):
                    old_file.unlink()
                if not gid or not re.fullmatch(r"\d+", gid):
                    raise ExportError(f"gid for {name} is not configured; fill it in SHEETS at the top of the script.")
                data = download_pdf(session, sheet_id, gid, name)
                pdf_path = PDF_DIR / f"{name}.pdf"
                pdf_path.write_bytes(data)
                images = render_pdf(data, name)
                all_images.extend(images)
                print(f"Exported {name}: {pdf_path.name}, {len(images)} PNG page(s).")
            except (ExportError, OSError) as exc:
                failures.append(f"{name}: {exc}")
                print(f"ERROR: {name}: {exc}", file=sys.stderr)

    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    (DOCS_DIR / ".nojekyll").touch()
    timestamp = datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y%m%d%H%M")
    LINKS_FILE.write_text(
        "".join(f"{BASE_URL}/{path.name}?v={timestamp}\n" for path in all_images),
        encoding="utf-8",
    )

    if not args.no_git:
        try:
            publish()
        except (ExportError, subprocess.CalledProcessError) as exc:
            message = exc if isinstance(exc, str) else str(exc)
            failures.append(f"publish: {message}")
            print(f"ERROR: {message}", file=sys.stderr)

    if failures:
        print("Export finished with errors:\n- " + "\n- ".join(failures), file=sys.stderr)
        return 1
    print(f"Done. {len(all_images)} image(s); links written to links.txt.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
