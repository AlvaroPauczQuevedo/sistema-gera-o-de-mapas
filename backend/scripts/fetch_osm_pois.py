"""Baixa do OpenStreetMap instituições e estruturas de emergência de cada município.
Saída: frontend/public/data/<codigo>/instituicoes.geojson (pontos; áreas viram o centro).

Só traz o que existe no OSM. Prefeituras devem conferir e complementar (seção 14 do projeto)."""
import json
import sys
import time
from pathlib import Path

from shapely.geometry import Point, mapping, shape
from shapely.prepared import prep

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_osm import OUT, ROOT, consulta_bruta  # noqa: E402

sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

# (filtro Overpass, categoria, tipo) — categorias da seção 14 do projeto.
FILTROS = [
    ('amenity="townhall"', "Administração", "Prefeitura / órgão público"),
    ('office="government"', "Administração", "Órgão público"),
    ('amenity="police"', "Segurança", "Polícia / Brigada Militar"),
    ('amenity="fire_station"', "Segurança", "Corpo de Bombeiros"),
    ('emergency="ambulance_station"', "Saúde", "Base de ambulância"),
    ('amenity="hospital"', "Saúde", "Hospital"),
    ('amenity~"^(clinic|doctors)$"', "Saúde", "Unidade de saúde"),
    ('healthcare', "Saúde", "Unidade de saúde"),
    ('amenity="pharmacy"', "Saúde", "Farmácia"),
    ('amenity~"^(school|kindergarten|college|university)$"', "Acolhimento", "Escola"),
    ('amenity="community_centre"', "Acolhimento", "Centro comunitário"),
    ('leisure="sports_centre"', "Acolhimento", "Ginásio / centro esportivo"),
    ('amenity="social_facility"', "Acolhimento", "Assistência social"),
    ('amenity="shelter"', "Acolhimento", "Abrigo"),
    ('emergency="assembly_point"', "Acolhimento", "Ponto de encontro"),
    ('man_made~"^(water_works|water_tower|reservoir_covered)$"', "Infraestrutura", "Abastecimento de água"),
    ('power~"^(substation|plant)$"', "Infraestrutura", "Energia elétrica"),
    ('waterway="dam"', "Infraestrutura", "Barragem"),
    ('aeroway~"^(aerodrome|helipad)$"', "Infraestrutura", "Aeródromo / heliponto"),
]
TAGS = ["name", "amenity", "office", "healthcare", "emergency", "operator", "addr:street",
        "addr:housenumber", "phone", "opening_hours"]

for codigo, nome in MUNICIPIOS.items():
    destino = OUT / str(codigo) / "instituicoes.geojson"
    if destino.exists() and "--refazer" not in sys.argv:
        continue
    limite = shape(json.loads((ROOT / "backend/data/boundaries" / f"{codigo}.geojson")
                              .read_text(encoding="utf-8"))["features"][0]["geometry"])
    pl = prep(limite)
    minx, miny, maxx, maxy = limite.bounds
    bbox = f"({miny},{minx},{maxy},{maxx})"
    # Uma consulta só por município, com todos os filtros unidos.
    corpo = "".join(f"nwr[{f}]{bbox};" for f, _, _ in FILTROS)
    elementos = consulta_bruta(f"[out:json][timeout:180];({corpo});out center tags;")
    vistos, feats = set(), []
    for el in elementos:
        lon, lat = (el["lon"], el["lat"]) if "lon" in el else (el["center"]["lon"], el["center"]["lat"])
        ponto = Point(lon, lat)
        if (el["type"], el["id"]) in vistos or not pl.contains(ponto):
            continue
        tags = el.get("tags", {})
        for f, cat, tipo in FILTROS:  # primeira regra que casar define a categoria
            chave, _, valor = f.partition("=") if "=" in f else f.partition("~")
            chave = chave.rstrip("~")
            if chave in tags and (not valor or tags[chave] in valor.strip('"^$()').split("|")):
                break
        else:
            continue
        vistos.add((el["type"], el["id"]))
        props = {k: tags[k] for k in TAGS if k in tags}
        props.update({"categoria": cat, "tipo": tipo, "osm": f"{el['type']}/{el['id']}",
                      "situacao": "não verificado em campo"})
        feats.append({"type": "Feature", "geometry": mapping(ponto), "properties": props})
    destino.write_text(json.dumps({
        "type": "FeatureCollection", "features": feats,
        "fonte": {"nome": "© OpenStreetMap contributors", "licenca": "ODbL 1.0",
                  "url": "https://www.openstreetmap.org/copyright",
                  "obtido_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}},
        ensure_ascii=False), encoding="utf-8")
    print(nome, len(feats), "estruturas")
    time.sleep(5)
