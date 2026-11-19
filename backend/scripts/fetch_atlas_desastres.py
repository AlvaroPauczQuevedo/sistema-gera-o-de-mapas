"""Registros oficiais de desastres dos municípios (Atlas Digital de Desastres no Brasil / S2iD, MIDR).
Baixa a base consolidada 1991–2025 e filtra os municípios cadastrados (seção 17).
Saída: frontend/public/data/eventos/desastres_atlas.json

Uso: python scripts/fetch_atlas_desastres.py [arquivo.csv já baixado]"""
import csv
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

URL = "https://atlasdigital.mdr.gov.br/arquivos/2026/BD_Atlas_1991_2025_v1.1_2026.08.06_Consolidado.csv"
SAIDA = ROOT / "frontend" / "public" / "data" / "eventos" / "desastres_atlas.json"

NUM = {"mortos": "DH_MORTOS", "feridos": "DH_FERIDOS", "enfermos": "DH_ENFERMOS", "desabrigados": "DH_DESABRIGADOS",
       "desalojados": "DH_DESALOJADOS", "desaparecidos": "DH_DESAPARECIDOS", "outros_afetados": "DH_OUTROS AFETADOS",
       "habitacoes_danificadas": "DM_Uni Habita Danificadas", "habitacoes_destruidas": "DM_Uni Habita Destruidas",
       "obras_infra_danificadas": "DM_Obras de Infra Danificadas", "obras_infra_destruidas": "DM_Obras de Infra Destruidas",
       "danos_materiais_rs": "DM_total_danos_materiais", "prejuizo_publico_rs": "PEPL_total_publico",
       "prejuizo_privado_rs": "PEPR_total_privado", "prejuizo_agricultura_rs": "PEPR_Agricultura (R$)"}
TEXTO = {"danos_humanos": "DH_Descricao", "danos_materiais": "DM_Descricao", "prejuizos_publicos": "PEPL_Descricao"}


def num(v):
    v = (v or "").strip().replace(".", "").replace(",", ".") if "," in (v or "") else (v or "").strip()
    try:
        return float(v)
    except ValueError:
        return 0.0


def main():
    if len(sys.argv) > 1:
        bruto = Path(sys.argv[1]).read_bytes()
    else:
        req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (gemeos-digitais)"})
        with urllib.request.urlopen(req, timeout=600) as r:
            bruto = r.read()
    leitor = csv.DictReader(io.StringIO(bruto.decode("latin-1")), delimiter=";")
    eventos = []
    for l in leitor:
        try:
            cod = int(float(l["Cod_IBGE_Mun"]))
        except (TypeError, ValueError):
            continue
        if cod not in MUNICIPIOS:
            continue
        d, m, a = (l["Data_Evento"] or l["Data_Registro"]).split("/")
        ev = {"protocolo": l["Protocolo_S2iD"], "codigo_ibge": cod, "municipio": MUNICIPIOS[cod],
              "data": f"{a}-{m}-{d}", "cobrade": l["Cod_Cobrade"], "tipologia": l["descricao_tipologia"],
              "grupo": l["grupo_de_desastre"], "status": l["Status"]}
        ev.update({k: num(l.get(c)) for k, c in NUM.items()})
        ev.update({k: (l.get(c) or "").strip()[:800] for k, c in TEXTO.items()})
        eventos.append(ev)
    eventos.sort(key=lambda e: e["data"])
    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    SAIDA.write_text(json.dumps({
        "eventos": eventos,
        "fonte": {"nome": "Atlas Digital de Desastres no Brasil (MIDR/Sedec) — registros S2iD, base consolidada 1991–2025 v1.1",
                  "url": "https://atlasdigital.mdr.gov.br/paginas/downloads.xhtml", "licenca": "dados públicos federais",
                  "obtido_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "observacao": "Registros declarados pelos municípios; anteriores a 2013 são menos completos."},
    }, ensure_ascii=False), encoding="utf-8")
    por = {}
    for e in eventos:
        por.setdefault(e["tipologia"], 0)
        por[e["tipologia"]] += 1
    print(len(eventos), "registros:", por)


if __name__ == "__main__":
    main()
