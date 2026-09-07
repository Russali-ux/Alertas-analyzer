"""Index the PDFs in ``pdfs/`` into Pinecone using integrated embeddings."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import fitz

from pinecone_store import NAMESPACE, TEXT_FIELD, get_or_create_index


ROOT = Path(__file__).resolve().parent
PDF_DIR = ROOT / "pdfs"
MANIFEST_FILE = ROOT / "data" / "pinecone_manifest.json"
CHUNK_SIZE = 5_000
CHUNK_OVERLAP = 600
UPSERT_BATCH_SIZE = 50


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_text(text: str) -> str:
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_pdf_text(path: Path) -> str:
    with fitz.open(path) as document:
        return normalize_text("\n".join(page.get_text("text") for page in document))


def split_text(text: str) -> list[str]:
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        if end < len(text):
            boundary = max(text.rfind("\n", start, end), text.rfind(". ", start, end))
            if boundary > start + CHUNK_SIZE // 2:
                end = boundary + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return chunks


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _iter_alerts(raw):
    """Yield alert dicts from a loaded JSON file, tolerating both list and dict roots.

    Daily snapshots (alertas_YYYYMMDD.json / alertas_latest.json) are lists of
    alert dicts. The backfill (alertas_backfill_2026_01-52.json) is a dict keyed
    by week number whose values are alert dicts. Iterating a dict directly would
    yield its keys (strings), so map dict roots to their values first and skip
    anything that is not a dict.
    """
    if isinstance(raw, dict):
        raw = raw.values()
    for alert in raw:
        if isinstance(alert, dict):
            yield alert


def _normalize_alert(alert: dict) -> dict:
    """Fill standard keys from backfill aliases so all snapshots share one schema."""
    if not alert.get("github_pdf_url") and alert.get("url_pdf_github"):
        alert["github_pdf_url"] = alert["url_pdf_github"]
    if not alert.get("url") and alert.get("url_pagina_digemid"):
        alert["url"] = alert["url_pagina_digemid"]
    return alert


def alert_lookup() -> dict[str, dict]:
    lookup: dict[str, dict] = {}
    from urllib.parse import unquote

    alert_files = sorted((ROOT / "data").glob("alertas_*.json"))
    latest = ROOT / "data" / "alertas_latest.json"
    if latest in alert_files:
        alert_files.remove(latest)
        alert_files.append(latest)
    for alert_file in alert_files:
        for alert in _iter_alerts(load_json(alert_file, [])):
            alert = _normalize_alert(alert)
            pdf_url = alert.get("github_pdf_url") or ""
            pdf_name = pdf_url.rsplit("/", 1)[-1]
            if pdf_name:
                # Newer snapshots intentionally replace older metadata.
                lookup[unquote(pdf_name)] = alert
    return lookup


def build_records(path: Path, file_hash: str, alert: dict) -> list[dict]:
    chunks = split_text(extract_pdf_text(path))
    records = []
    title = alert.get("titulo") or path.stem
    for number, chunk in enumerate(chunks):
        records.append(
            {
                "_id": f"{file_hash[:24]}-{number:04d}",
                TEXT_FIELD: chunk,
                "document_hash": file_hash,
                "chunk_number": number,
                "pdf_name": path.name,
                "titulo": title,
                "producto": alert.get("producto") or "",
                "tipo_alerta": alert.get("tipo_alerta") or "",
                "urgencia": alert.get("urgencia") or "",
                "fecha_publicacion": alert.get("fecha_publicacion") or "",
                "github_pdf_url": alert.get("github_pdf_url") or "",
                "digemid_url": alert.get("url") or "",
            }
        )
    return records


def sync() -> dict[str, int]:
    index = get_or_create_index()
    previous = load_json(MANIFEST_FILE, {"files": {}}).get("files", {})
    alerts = alert_lookup()
    current: dict[str, dict] = {}
    indexed = skipped = deleted = 0

    for path in sorted(PDF_DIR.glob("*.pdf")):
        data = path.read_bytes()
        file_hash = sha256_bytes(data)
        old = previous.get(path.name, {})
        if old.get("sha256") == file_hash:
            current[path.name] = old
            skipped += 1
            continue

        if old.get("record_ids"):
            index.delete(ids=old["record_ids"], namespace=NAMESPACE)

        records = build_records(path, file_hash, alerts.get(path.name, {}))
        for offset in range(0, len(records), UPSERT_BATCH_SIZE):
            index.upsert_records(
                namespace=NAMESPACE,
                records=records[offset : offset + UPSERT_BATCH_SIZE],
            )
        current[path.name] = {
            "sha256": file_hash,
            "record_ids": [record["_id"] for record in records],
            "chunks": len(records),
        }
        indexed += 1

    for pdf_name, old in previous.items():
        if pdf_name not in current and old.get("record_ids"):
            index.delete(ids=old["record_ids"], namespace=NAMESPACE)
            deleted += 1

    MANIFEST_FILE.write_text(
        json.dumps({"namespace": NAMESPACE, "files": current}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {"indexed": indexed, "skipped": skipped, "deleted": deleted}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sync", action="store_true", help="Sincroniza todos los PDF locales")
    args = parser.parse_args()
    if not args.sync:
        parser.error("usa --sync")
    result = sync()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
