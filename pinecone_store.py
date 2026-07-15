"""Shared Pinecone configuration and helpers for Alertas Analyzer."""

from __future__ import annotations

import os
import time

from pinecone import Pinecone


INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "alertas-analyzer")
NAMESPACE = os.getenv("PINECONE_NAMESPACE", "digemid-alertas")
EMBED_MODEL = os.getenv("PINECONE_EMBED_MODEL", "multilingual-e5-large")
PINECONE_CLOUD = os.getenv("PINECONE_CLOUD", "aws")
PINECONE_REGION = os.getenv("PINECONE_REGION", "us-east-1")
TEXT_FIELD = "chunk_text"


def pinecone_client() -> Pinecone:
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise RuntimeError("Falta PINECONE_API_KEY")
    return Pinecone(api_key=api_key)


def get_or_create_index():
    """Return the integrated-embedding index, creating it for the pilot if needed."""
    pc = pinecone_client()
    if not pc.has_index(INDEX_NAME):
        pc.create_index_for_model(
            name=INDEX_NAME,
            cloud=PINECONE_CLOUD,
            region=PINECONE_REGION,
            embed={
                "model": EMBED_MODEL,
                "field_map": {"text": TEXT_FIELD},
                "metric": "cosine",
            },
        )
        # The control plane can return before the data plane is ready.
        deadline = time.time() + 120
        while time.time() < deadline:
            description = pc.describe_index(INDEX_NAME)
            status = getattr(description, "status", None)
            ready = getattr(status, "ready", False)
            if ready:
                break
            time.sleep(2)
    return pc.Index(INDEX_NAME)

