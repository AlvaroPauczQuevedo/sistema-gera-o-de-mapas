"""Estabelecimentos de saúde do CNES (Ministério da Saúde, API de dados abertos), com coordenadas oficiais.
Mantém os públicos, os que atendem pelo SUS e os hospitais/urgência. Telefone só de estabelecimentos públicos
(consultórios privados podem expor contato pessoal).
Saída: frontend/public/data/<codigo>/saude_cnes.geojson"""
import json
import sys
import time
import urllib.request
from pathlib import Path

from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

# Atenção: nesta API, "offset" é o número da PÁGINA (0, 1, 2...), não a quantidade de registros a pular.
API = "https://apidadosabertos.saude.gov.br/cnes/estabelecimentos?codigo_municipio={m}&limit=20&offset={o}"
# Tabela de tipos de unidade do CNES (principais para emergência)
TIPOS = {1: "Posto de saúde", 2: "Centro de saúde / UBS", 4: "Policlínica", 5: "Hospital geral", 7: "Hospital especializado",
         15: "Unidade mista", 20: "Pronto-socorro geral", 21: "Pronto-socorro especializado", 22: "Consultório isolado",
         36: "Clínica / centro de especialidade", 39: "Unidade de apoio diagnose e terapia", 40: "Unidade móvel terrestre",
         42: "Unidade móvel de urgência (SAMU)", 43: "Farmácia", 50: "Unidade de vigilância em saúde", 68: "Secretaria de saúde",
         70: "CAPS", 73: "Pronto atendimento", 74: "Polo academia da saúde", 81: "Central de regulação"}
URGENCIA = {5, 7, 15, 20, 21, 42, 73}


def get(url):
    for t in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "gemeos-digitais/0.1"}), timeout=60) as r:
                return json.load(r)
        except Exception as ex:
            print("  tentativa", t + 1, ex)
            time.sleep(5 * (t + 1))
    raise RuntimeError(url)


for codigo, nome in MUNICIPIOS.items():
    limite = shape(json.loads((ROOT / "backend/data/boundaries" / f"{codigo}.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"])
    todos, o = [], 0
    while True:
        lote = get(API.format(m=codigo // 10, o=o))["estabelecimentos"]
        todos += lote
        if len(lote) < 20:
            break
        o += 1
        time.sleep(0.5)
    feats = []
    for e in todos:
        publico = str(e.get("descricao_natureza_juridica_estabelecimento") or "").startswith("1")
        sus = e.get("estabelecimento_faz_atendimento_ambulatorial_sus") == "SIM"
        tipo = e.get("codigo_tipo_unidade")
        if not (publico or sus or tipo in URGENCIA):
            continue
        lat, lon = e.get("latitude_estabelecimento_decimo_grau"), e.get("longitude_estabelecimento_decimo_grau")
        if lat is None or lon is None or not limite.buffer(0.01).contains(Point(lon, lat)):
            continue  # sem coordenada ou coordenada fora do município: não inventa posição
        endereco = ", ".join(x for x in [e.get("endereco_estabelecimento"), e.get("numero_estabelecimento"), e.get("bairro_estabelecimento")] if x)
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {
            "name": e.get("nome_fantasia") or e.get("nome_razao_social"), "categoria": "Saúde",
            "tipo": TIPOS.get(tipo, f"Tipo CNES {tipo}"), "cnes": e.get("codigo_cnes"), "endereco": endereco,
            "telefone": e.get("numero_telefone_estabelecimento") if publico else None,
            "turno": e.get("descricao_turno_atendimento"), "atende_sus": sus, "publico": publico,
            "atendimento_hospitalar": bool(e.get("estabelecimento_possui_atendimento_hospitalar")),
            "centro_cirurgico": bool(e.get("estabelecimento_possui_centro_cirurgico")),
            "situacao": "dado oficial CNES"}})
    (ROOT / "frontend/public/data" / str(codigo) / "saude_cnes.geojson").write_text(json.dumps({
        "type": "FeatureCollection", "features": feats,
        "fonte": {"nome": "CNES — Cadastro Nacional de Estabelecimentos de Saúde (Ministério da Saúde)", "licenca": "dados abertos",
                  "url": "https://apidadosabertos.saude.gov.br/", "obtido_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}},
        ensure_ascii=False), encoding="utf-8")
    print(nome, len(todos), "no CNES ->", len(feats), "mantidos")
