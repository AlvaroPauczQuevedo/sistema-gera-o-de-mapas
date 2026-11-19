"""Baixa ruas, rios e edificações do OpenStreetMap (Overpass API, gratuito)
para cada município, recortando pelo limite oficial do IBGE.
Saída: frontend/public/data/<codigo>/{vias,rios,edificacoes}.geojson"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import LineString, Polygon, mapping, shape
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

OUT = ROOT / "frontend" / "public" / "data"
# Instâncias públicas do Overpass; alterna entre elas quando uma falha.
OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.private.coffee/api/interpreter"]

CAMADAS = {
    "vias": ('way["highway"]', ["highway", "name", "surface", "bridge"]),
    "rios": ('way["waterway"~"river|stream|canal"]', ["waterway", "name"]),
    "edificacoes": ('way["building"]', ["building", "name", "amenity", "building:levels", "height"]),
}


def consulta(bbox, filtro):
    s, w, n, e = bbox
    return consulta_bruta(f"[out:json][timeout:180];{filtro}({s},{w},{n},{e});out geom tags;")


def consulta_bruta(q):
    data = urllib.parse.urlencode({"data": q}).encode()
    for tentativa in range(6):
        url = OVERPASS[tentativa % len(OVERPASS)]
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data, {"User-Agent": "gemeos-digitais-defesa-civil/0.1", "Accept": "application/json"}), timeout=240) as r:
                return json.load(r)["elements"]
        except Exception as ex:  # Overpass costuma limitar requisições
            print("  tentativa", tentativa + 1, url.split("/")[2], "falhou:", ex)
            time.sleep(10 * (tentativa + 1))
    raise RuntimeError("Overpass indisponível")


def para_feature(el, tags, fechada):
    pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
    if len(pts) < 2:
        return None
    props = {k: el["tags"][k] for k in tags if k in el.get("tags", {})}
    props["osm_id"] = el["id"]
    if fechada and len(pts) >= 4 and pts[0] == pts[-1]:
        return Polygon(pts), props
    return LineString(pts), props


if __name__ == "__main__":
    for codigo, nome in MUNICIPIOS.items():
        limite = shape(json.loads((ROOT / "backend/data/boundaries" / f"{codigo}.geojson")
                                  .read_text(encoding="utf-8"))["features"][0]["geometry"])
        pl = prep(limite)
        pasta = OUT / str(codigo)
        pasta.mkdir(parents=True, exist_ok=True)
        (pasta / "limite.geojson").write_bytes((ROOT / "backend/data/boundaries" / f"{codigo}.geojson").read_bytes())
        minx, miny, maxx, maxy = limite.bounds
        for camada, (filtro, tags) in CAMADAS.items():
            if (pasta / f"{camada}.geojson").exists() and "--refazer" not in sys.argv:
                continue  # retoma downloads interrompidos
            feats = []
            for el in consulta((miny, minx, maxy, maxx), filtro):
                r = para_feature(el, tags, camada == "edificacoes")
                if r and pl.intersects(r[0]):
                    feats.append({"type": "Feature", "geometry": mapping(r[0]), "properties": r[1]})
            (pasta / f"{camada}.geojson").write_text(
                json.dumps({"type": "FeatureCollection", "features": feats,
                            "fonte": {"nome": "© OpenStreetMap contributors", "licenca": "ODbL 1.0",
                                      "url": "https://www.openstreetmap.org/copyright",
                                      "obtido_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}}),
                encoding="utf-8")
            print(nome, camada, len(feats))
            time.sleep(5)
