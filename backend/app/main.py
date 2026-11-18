import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .municipios import FONTE_LIMITES, MUNICIPIOS

DATA = Path(__file__).resolve().parents[1] / "data" / "boundaries"

app = FastAPI(title="Gêmeos Digitais – API")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"],
                   allow_methods=["GET"], allow_headers=["*"])


def _carregar(codigo: int) -> dict:
    if codigo not in MUNICIPIOS:
        raise HTTPException(404, "Município não cadastrado")
    arq = DATA / f"{codigo}.geojson"
    if not arq.exists():
        raise HTTPException(503, "Limite não baixado: rode scripts/fetch_boundaries.py")
    gj = json.loads(arq.read_text(encoding="utf-8"))
    for f in gj["features"]:
        f["properties"] = {"codigo_ibge": codigo, "nome": MUNICIPIOS[codigo]}
    gj["fonte"] = {**FONTE_LIMITES,
                   "data_arquivo": datetime.fromtimestamp(arq.stat().st_mtime, timezone.utc).isoformat()}
    return gj


@app.get("/api/municipios")
def listar():
    return [{"codigo_ibge": c, "nome": n, "limite_disponivel": (DATA / f"{c}.geojson").exists()}
            for c, n in MUNICIPIOS.items()]


@app.get("/api/municipios/{codigo}/limite")
def limite(codigo: int):
    return _carregar(codigo)
