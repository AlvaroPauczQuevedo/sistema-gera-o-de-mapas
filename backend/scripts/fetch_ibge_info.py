"""Baixa população, área e densidade oficiais (IBGE, Censo 2022) dos municípios.
Saída: frontend/public/data/indicadores_ibge.json"""
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

VARIAVEIS = {"93": "populacao", "6318": "area_km2", "614": "densidade_hab_km2"}
url = ("https://servicodados.ibge.gov.br/api/v3/agregados/4714/periodos/2022/variaveis/"
       + "|".join(VARIAVEIS) + "?localidades=N6[" + ",".join(map(str, MUNICIPIOS)) + "]")
with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "gemeos-digitais/0.1"}), timeout=60) as r:
    dados = json.load(r)

saida = {str(c): {"codigo_ibge": c, "nome": n} for c, n in MUNICIPIOS.items()}
for v in dados:
    chave = VARIAVEIS[v["id"]]
    for s in v["resultados"][0]["series"]:
        valor = s["serie"]["2022"]
        saida[s["localidade"]["id"]][chave] = int(valor) if chave == "populacao" else float(valor)

(ROOT / "frontend/public/data/indicadores_ibge.json").write_text(json.dumps({
    "municipios": list(saida.values()),
    "fonte": {"nome": "IBGE — Censo Demográfico 2022 (tabela 4714)", "licenca": "CC BY 4.0",
              "url": "https://sidra.ibge.gov.br/tabela/4714",
              "obtido_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
}, ensure_ascii=False, indent=1), encoding="utf-8")
print("ok", sum(m["populacao"] for m in saida.values()), "habitantes")
