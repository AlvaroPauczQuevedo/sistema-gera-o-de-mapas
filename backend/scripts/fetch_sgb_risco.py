"""Baixa a setorização de risco geológico do SGB/CPRM (risco alto e muito alto) dos municípios.
Saída: frontend/public/data/<codigo>/areas_risco.geojson  e  frontend/public/data/areas_risco_resumo.json

Fonte oficial: Serviço Geológico do Brasil — geoportal.sgb.gov.br (gestaoterritorial/risco)."""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import mapping, shape

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

URL = "https://geoportal.sgb.gov.br/server/rest/services/gestaoterritorial/risco/MapServer/0/query"
CAMPOS = ["municipio", "num_setor", "data_setor", "local", "tipolo_g1", "tipolo_e1", "cobrade_01",
          "tipolo_g2", "tipolo_e2", "descricao", "obs_ocup", "grau_vulne", "grau_risco", "num_edif",
          "num_domi", "num_pess", "sug_interv", "orgao_exec"]
OUT = ROOT / "frontend" / "public" / "data"

resumo = {}
for codigo, nome in MUNICIPIOS.items():
    limite = shape(json.loads((ROOT / "backend/data/boundaries" / f"{codigo}.geojson")
                              .read_text(encoding="utf-8"))["features"][0]["geometry"])
    minx, miny, maxx, maxy = limite.bounds
    q = urllib.parse.urlencode({
        "geometry": f"{minx},{miny},{maxx},{maxy}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": ",".join(CAMPOS), "returnGeometry": "true",
        "outSR": 4326, "f": "geojson"})
    with urllib.request.urlopen(urllib.request.Request(f"{URL}?{q}", headers={"User-Agent": "gemeos-digitais/0.1"}),
                                timeout=120) as r:
        dados = json.load(r)
    feats = []
    for f in dados.get("features", []):
        g = shape(f["geometry"])
        # setor pertence ao município se o seu ponto interno está dentro do limite
        if not limite.contains(g.representative_point()):
            continue
        p = {k: f["properties"].get(k) for k in CAMPOS}
        p["fonte"] = "SGB/CPRM — Setorização de Risco Geológico"
        feats.append({"type": "Feature", "geometry": mapping(g), "properties": p})
    (OUT / str(codigo) / "areas_risco.geojson").write_text(json.dumps({
        "type": "FeatureCollection", "features": feats,
        "fonte": {"nome": "SGB/CPRM — Setorização de Áreas de Risco Geológico (risco alto e muito alto)",
                  "licenca": "Dados públicos SGB", "url": "https://geoportal.sgb.gov.br/",
                  "obtido_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}}, ensure_ascii=False), encoding="utf-8")
    graus = {}
    for f in feats:
        g = f["properties"]["grau_risco"] or "não informado"
        graus[g] = graus.get(g, 0) + 1
    num = lambda k: sum(int(f["properties"][k] or 0) for f in feats if str(f["properties"][k] or "").isdigit())
    datas = sorted({str(f["properties"]["data_setor"])[:10] for f in feats if f["properties"]["data_setor"]})
    resumo[codigo] = {"nome": nome, "setores": len(feats), "por_grau": graus, "edificacoes": num("num_edif"),
                      "pessoas": num("num_pess"), "datas_mapeamento": datas}
    print(nome, len(feats), "setores", graus, "pessoas:", resumo[codigo]["pessoas"])
    time.sleep(1)

(OUT / "areas_risco_resumo.json").write_text(json.dumps(resumo, ensure_ascii=False, indent=1), encoding="utf-8")
