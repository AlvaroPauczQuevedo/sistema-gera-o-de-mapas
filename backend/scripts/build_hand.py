"""Motor de inundação por ESTIMATIVA — HAND (Height Above Nearest Drainage).

Método (Rennó et al., 2008; Nobre et al., 2011; usado no NOAA OWP Flood Inundation Mapping):
  1. Relevo Copernicus GLO-30 da região -> preenchimento de depressões -> direção de fluxo D8.
  2. Canais principais = células de drenagem (acumulação > LIMIAR_KM2) a até 150 m de rios
     nomeados do OpenStreetMap (Rio das Antas, Carreiro, Guaporé, ...).
  3. HAND de cada célula = cota da célula - cota do canal para onde ela escoa.
  4. Uma elevação do nível do rio de Δh metros inunda as células com HAND < Δh;
     profundidade estimada = Δh - HAND.

Saída (frontend/public/data/simulacao/):
  hand_<rio>.png  — HAND em escala de cinza (1 nível = PASSO_M; 255 = fora da área de influência)
  hand.json       — rios, retângulos, escala e procedência

LIMITAÇÕES (mostradas na interface): modelo estático, sem hidrodinâmica (não é HEC-RAS); assume o
mesmo Δh ao longo de todo o trecho; DSM inclui vegetação/telhados; reservatórios de usinas aparecem
como superfície de água. Serve para cenários e triagem, não para decisão sem validação profissional.
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.merge import merge
from shapely.geometry import shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app.municipios import MUNICIPIOS  # noqa: E402
from build_slope import COG, tiles  # noqa: E402

if not hasattr(np, "in1d"):  # pysheds 0.5 usa np.in1d, removida no numpy 2.x
    np.in1d = np.isin
from pysheds.grid import Grid  # noqa: E402
from pysheds.sview import Raster  # noqa: E402

OUT = ROOT / "frontend" / "public" / "data" / "simulacao"
DEM_ARQ = ROOT / "backend" / "data" / "dem" / "regiao.tif"
LIMIAR_KM2 = 2.0      # área de contribuição mínima para ser canal de drenagem
BUFFER_RIO_M = 150    # distância máxima entre o canal do DEM e o rio do OSM
HAND_MAX_M = 40.0     # área de influência máxima considerada
PASSO_M = 0.25        # resolução vertical gravada (40 m / 0.25 = 160 níveis)
RIOS = ["Rio das Antas", "Rio Carreiro", "Rio Guaporé", "Rio da Prata", "Rio Turvo"]


def baixar_dem():
    lims = [shape(json.loads((ROOT / "backend/data/boundaries" / f"{c}.geojson").read_text(encoding="utf-8"))
                  ["features"][0]["geometry"]) for c in MUNICIPIOS]
    minx, miny, maxx, maxy = unary_union(lims).buffer(0.05).bounds
    fontes = [rasterio.open(COG.format(t=t)) for t in tiles(minx, miny, maxx, maxy)]
    try:
        dem, transf = merge(fontes, bounds=(minx, miny, maxx, maxy))
        perfil = fontes[0].profile
    finally:
        for f in fontes:
            f.close()
    perfil.update(driver="GTiff", height=dem.shape[1], width=dem.shape[2], transform=transf, count=1,
                  dtype="float32", compress="deflate", tiled=False, blockxsize=None, blockysize=None)
    perfil.pop("blockxsize", None); perfil.pop("blockysize", None)
    DEM_ARQ.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(DEM_ARQ, "w", **perfil) as d:
        d.write(dem[0].astype("float32"), 1)
    print("DEM", dem.shape, "salvo em", DEM_ARQ)


def rios_osm():
    """Linhas do OSM com os nomes dos rios principais (dos arquivos já baixados)."""
    por_rio = {r: [] for r in RIOS}
    for c in MUNICIPIOS:
        arq = ROOT / "frontend/public/data" / str(c) / "rios.geojson"
        if not arq.exists():
            continue
        for f in json.loads(arq.read_text(encoding="utf-8"))["features"]:
            nome = (f["properties"].get("name") or "").strip()
            for r in RIOS:
                if nome.lower() == r.lower():
                    por_rio[r].append(shape(f["geometry"]))
    return {r: unary_union(g) for r, g in por_rio.items() if g}


def main():
    if not DEM_ARQ.exists() or "--refazer" in sys.argv:
        baixar_dem()
    grid = Grid.from_raster(str(DEM_ARQ))
    dem = grid.read_raster(str(DEM_ARQ))
    print("condicionando o relevo (preenchimento de depressões e áreas planas)...")
    cond = grid.resolve_flats(grid.fill_depressions(grid.fill_pits(dem)))
    fdir = grid.flowdir(cond)
    acc = grid.accumulation(fdir)

    t = grid.affine
    lat_c = t.f + t.e * dem.shape[0] / 2
    dx = t.a * 111320 * math.cos(math.radians(lat_c))
    dy = -t.e * 110574
    area_celula_km2 = dx * dy / 1e6
    drenagem = np.asarray(acc) * area_celula_km2 > LIMIAR_KM2

    rios = rios_osm()
    print("rios do OSM encontrados:", list(rios))
    graus_buffer = BUFFER_RIO_M / 111000
    canal_id = np.zeros(dem.shape, dtype=np.uint8)
    for i, (nome, geo) in enumerate(rios.items(), start=1):
        faixa = rasterize([(geo.buffer(graus_buffer), 1)], out_shape=dem.shape, transform=t, fill=0, dtype="uint8")
        canal_id[(faixa == 1) & drenagem & (canal_id == 0)] = i
    canais = Raster(canal_id > 0, viewfinder=dem.viewfinder)
    print("células de canal principal:", int(np.asarray(canais).sum()))

    print("calculando HAND...")
    hand = np.asarray(grid.compute_hand(fdir, cond, canais, nodata_out=np.nan))
    idx = np.asarray(grid.compute_hand(fdir, cond, canais, return_index=True, nodata_out=-1))
    # rio de cada célula = rio do canal para onde ela escoa
    rio_da_celula = np.zeros(dem.shape, dtype=np.uint8)
    validos = idx >= 0
    rio_da_celula[validos] = canal_id.ravel()[idx[validos].astype(np.int64)]

    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"rios": [], "metodo": __doc__.strip(), "passo_m": PASSO_M, "hand_max_m": HAND_MAX_M,
            "fonte_relevo": "Copernicus DEM GLO-30 (ESA), 30 m", "fonte_rios": "© OpenStreetMap (ODbL)",
            "gerado_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "limiar_drenagem_km2": LIMIAR_KM2}
    for i, nome in enumerate(rios, start=1):
        m = (rio_da_celula == i) & np.isfinite(hand) & (hand <= HAND_MAX_M) & (hand >= 0)
        if not m.any():
            continue
        linhas, cols = np.where(m)
        r0, r1, c0, c1 = linhas.min(), linhas.max() + 1, cols.min(), cols.max() + 1
        sub = np.full((r1 - r0, c1 - c0), 255, dtype=np.uint8)
        hm = hand[r0:r1, c0:c1]
        mm = m[r0:r1, c0:c1]
        sub[mm] = np.clip(np.round(hm[mm] / PASSO_M), 0, 254).astype(np.uint8)
        chave = nome.lower().replace(" ", "_").replace("é", "e")
        Image.fromarray(sub, "L").save(OUT / f"hand_{chave}.png", optimize=True)
        oeste, norte = t.c + c0 * t.a, t.f + r0 * t.e
        meta["rios"].append({
            "id": chave, "nome": nome, "arquivo": f"hand_{chave}.png", "largura": int(c1 - c0), "altura": int(r1 - r0),
            "retangulo": {"oeste": oeste, "norte": norte, "leste": oeste + (c1 - c0) * t.a, "sul": norte + (r1 - r0) * t.e},
            "celula_m": [round(dx, 2), round(dy, 2)], "celulas_influencia": int(mm.sum()),
        })
        print(f"  {nome}: {sub.shape[1]}x{sub.shape[0]} px, {int(mm.sum())} células com HAND <= {HAND_MAX_M} m")
    (OUT / "hand.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
