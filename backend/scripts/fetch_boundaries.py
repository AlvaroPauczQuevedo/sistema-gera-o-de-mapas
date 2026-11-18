"""Baixa os limites municipais oficiais do IBGE para backend/data/boundaries."""
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.municipios import MUNICIPIOS  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "data" / "boundaries"
OUT.mkdir(parents=True, exist_ok=True)
URL = ("https://servicodados.ibge.gov.br/api/v3/malhas/municipios/{id}"
       "?formato=application/vnd.geo+json&qualidade=maxima")

for codigo, nome in MUNICIPIOS.items():
    with urllib.request.urlopen(URL.format(id=codigo), timeout=60) as r:
        (OUT / f"{codigo}.geojson").write_bytes(r.read())
    print("ok", codigo, nome)
