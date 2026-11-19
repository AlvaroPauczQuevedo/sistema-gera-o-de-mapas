"""Gera altitude e declividade por município a partir do Copernicus GLO-30 (30 m).

Lê só o recorte necessário dos COGs públicos na AWS (sem baixar os tiles inteiros).
Saída em frontend/public/data/<codigo>/:
  declividade.png   — classes de declividade (EMBRAPA), transparente fora do limite
  relevo.json       — limites da imagem, estatísticas de altitude e área por classe
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import geometry_mask
from rasterio.merge import merge
from shapely.geometry import mapping, shape

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

OUT = ROOT / "frontend" / "public" / "data"
COG = ("/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/"
       "Copernicus_DSM_COG_10_{t}_DEM/Copernicus_DSM_COG_10_{t}_DEM.tif")

# Classes de relevo da EMBRAPA (Santos et al., Manual de descrição e coleta de solo no campo).
CLASSES = [
    (0, 3, "Plano", (26, 152, 80)),
    (3, 8, "Suave ondulado", (145, 207, 96)),
    (8, 20, "Ondulado", (217, 239, 139)),
    (20, 45, "Forte ondulado", (254, 224, 139)),
    (45, 75, "Montanhoso", (252, 141, 89)),
    (75, 1e9, "Escarpado", (215, 48, 39)),
]
FONTE = {
    "nome": "Copernicus DEM GLO-30 (ESA), via AWS Open Data",
    "licenca": "Copernicus DEM — licença de uso livre (© DLR e.V. 2010-2014, © Airbus 2014-2018, ESA)",
    "url": "https://registry.opendata.aws/copernicus-dem/",
    "resolucao_espacial": "1 segundo de arco (~30 m)",
    "metodo": "Declividade em % por diferenças centrais (numpy.gradient) sobre o DSM. "
              "O GLO-30 é modelo de SUPERFÍCIE: inclui copas de árvores e edificações.",
}


def tiles(minx, miny, maxx, maxy):
    """Nomes dos tiles de 1° (canto inferior esquerdo) que cobrem o retângulo."""
    nomes = []
    for lat in range(math.floor(miny), math.floor(maxy) + 1):
        for lon in range(math.floor(minx), math.floor(maxx) + 1):
            ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}_00"
            ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}_00"
            nomes.append(f"{ns}_{ew}")
    return nomes


def processar(codigo, nome):
    limite = shape(json.loads((ROOT / "backend/data/boundaries" / f"{codigo}.geojson")
                              .read_text(encoding="utf-8"))["features"][0]["geometry"])
    minx, miny, maxx, maxy = limite.buffer(0.002).bounds
    fontes = [rasterio.open(COG.format(t=t)) for t in tiles(minx, miny, maxx, maxy)]
    try:
        dem, transf = merge(fontes, bounds=(minx, miny, maxx, maxy))
    finally:
        for f in fontes:
            f.close()
    dem = dem[0].astype("float64")
    res_x, res_y = transf.a, -transf.e
    lat_c = (miny + maxy) / 2
    dx = res_x * 111320 * math.cos(math.radians(lat_c))  # metros por pixel em x
    dy = res_y * 110574                                    # metros por pixel em y
    gy, gx = np.gradient(dem, dy, dx)
    decl = np.hypot(gx, gy) * 100  # %

    dentro = ~geometry_mask([mapping(limite)], out_shape=dem.shape, transform=transf)
    rgba = np.zeros((*dem.shape, 4), dtype=np.uint8)
    area_px = dx * dy / 1e6  # km² por pixel
    estat = []
    for lo, hi, rotulo, cor in CLASSES:
        m = dentro & (decl >= lo) & (decl < hi)
        rgba[m] = (*cor, 190)
        estat.append({"classe": rotulo, "de_pct": lo, "ate_pct": None if hi > 1e8 else hi,
                      "cor": "#%02x%02x%02x" % cor, "area_km2": round(float(m.sum() * area_px), 2),
                      "fracao": round(float(m.sum() / dentro.sum()), 4)})

    pasta = OUT / str(codigo)
    pasta.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(pasta / "declividade.png", optimize=True)
    alt = dem[dentro]
    h, w = dem.shape
    meta = {
        "codigo_ibge": codigo, "nome": nome,
        "retangulo": {"oeste": transf.c, "norte": transf.f,
                      "leste": transf.c + w * res_x, "sul": transf.f - h * res_y},
        "altitude_m": {"min": round(float(alt.min()), 1), "max": round(float(alt.max()), 1),
                       "media": round(float(alt.mean()), 1)},
        "declividade_media_pct": round(float(decl[dentro].mean()), 1),
        "classes": estat,
        "fonte": {**FONTE, "obtido_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
    }
    (pasta / "relevo.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(nome, meta["altitude_m"], "decl. média", meta["declividade_media_pct"], "%")


if __name__ == "__main__":
    for c, n in MUNICIPIOS.items():
        processar(c, n)
