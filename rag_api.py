"""Secure RAG API for the Alertas Analyzer frontend."""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel, Field

from pinecone_store import NAMESPACE, TEXT_FIELD, get_or_create_index


SYSTEM_PROMPT = """Eres un experto en regulación farmacéutica peruana (DIGEMID).
Responde en español basándote exclusivamente en los fragmentos recuperados de las alertas.
Si la información solicitada no aparece en las fuentes, dilo claramente.
Sé preciso, conciso y menciona el título de la alerta cuando corresponda."""


class HistoryItem(BaseModel):
    q: str = Field(max_length=2_000)
    a: str = Field(max_length=8_000)


class QueryRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2_000)
    pdf_url: str | None = Field(default=None, max_length=2_000)
    history: list[HistoryItem] = Field(default_factory=list, max_length=6)


class Source(BaseModel):
    title: str
    pdf_url: str | None = None
    score: float | None = None


class QueryResponse(BaseModel):
    answer: str
    sources: list[Source]


app = FastAPI(title="Alertas Analyzer RAG API", version="1.0.0")
allowed_origins = [
    origin.strip()
    for origin in os.getenv("RAG_ALLOWED_ORIGINS", "https://ia.conkomercoplataforma.com").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


def field_value(hit: Any, key: str, default=""):
    fields = getattr(hit, "fields", None)
    if fields is None and isinstance(hit, dict):
        fields = hit.get("fields", {})
    if hasattr(fields, "get"):
        return fields.get(key, default)
    return default


@app.get("/health")
def health():
    return {"status": "ok", "index": os.getenv("PINECONE_INDEX_NAME", "alertas-analyzer")}


@app.post("/api/rag/query", response_model=QueryResponse)
def query_rag(request: QueryRequest):
    try:
        index = get_or_create_index()
        query: dict[str, Any] = {
            "top_k": int(os.getenv("RAG_TOP_K", "6")),
            "inputs": {"text": request.question},
        }
        if request.pdf_url:
            query["filter"] = {"github_pdf_url": {"$eq": request.pdf_url}}
        results = index.search(namespace=NAMESPACE, query=query)
        result = results.get("result", {}) if hasattr(results, "get") else results["result"]
        hits = result.get("hits", []) if hasattr(result, "get") else result.hits
        if not hits:
            return QueryResponse(
                answer="No encontré información suficiente en los documentos indexados.",
                sources=[],
            )

        context_parts = []
        sources: list[Source] = []
        seen_sources: set[str] = set()
        for hit in hits:
            title = field_value(hit, "titulo", "Alerta DIGEMID")
            pdf_url = field_value(hit, "github_pdf_url") or None
            content = field_value(hit, TEXT_FIELD)
            context_parts.append(f"FUENTE: {title}\n{content}")
            source_key = pdf_url or title
            if source_key not in seen_sources:
                score = getattr(hit, "score", None)
                if score is None and isinstance(hit, dict):
                    score = hit.get("_score") or hit.get("score")
                sources.append(Source(title=title, pdf_url=pdf_url, score=score))
                seen_sources.add(source_key)

        history = "\n".join(f"Usuario: {item.q}\nAsistente: {item.a}" for item in request.history[-3:])
        joined_context = "\n\n---\n\n".join(context_parts)
        prompt = (
            f"CONTEXTO RECUPERADO:\n\n{joined_context}\n\n"
            f"HISTORIAL RECIENTE:\n{history or '(sin historial)'}\n\n"
            f"PREGUNTA: {request.question}"
        )
        client = OpenAI()
        response = client.responses.create(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            instructions=SYSTEM_PROMPT,
            input=prompt,
        )
        return QueryResponse(answer=response.output_text, sources=sources)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"No se pudo consultar la base documental: {exc}") from exc
