"""Coleta dados de monitoramento meteorológico e hidrológico da região (seção 12).

Fontes (todas gratuitas, sem cadastro):
  - CEMADEN: pluviômetros por município (chuva acumulada).            Horário da fonte: UTC.
  - ANA (HidroWeb telemetria): nível e chuva das estações próximas.   Horário da fonte: Brasília (UTC-3).
  - Open-Meteo: PREVISÃO DE MODELO para cada município (não oficial).

Saída: frontend/public/data/monitoramento.json, com horários em UTC (ISO 8601).

Se uma fonte falhar, mantém os últimos dados recebidos (do arquivo local ou de --anterior URL)
e marca a fonte como "indisponível", com a data da última coleta bem-sucedida.

Uso: python scripts/collect_monitoring.py [--anterior https://.../data/monitoramento.json]
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

SAIDA = ROOT / "frontend" / "public" / "data" / "monitoramento.json"
UA = {"User-Agent": "gemeos-digitais-defesa-civil/0.1"}
BRT = timezone(timedelta(hours=-3))
RAIO_ANA_KM = 25  # estações a até 25 km dos limites municipais


def baixar(url, timeout=90):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def num(v):
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def limites():
    return {c: shape(json.loads((ROOT / "backend/data/boundaries" / f"{c}.geojson")
                                .read_text(encoding="utf-8"))["features"][0]["geometry"])
            for c in MUNICIPIOS}


# ---------------------------------------------------------------- CEMADEN
def coletar_cemaden():
    dados = json.loads(baixar("https://resources.cemaden.gov.br/graficos/interativo/getJson2.php?uf=RS"))
    estacoes = []
    for e in dados:
        if e["codibge"] not in MUNICIPIOS:
            continue
        hora = datetime.strptime(e["datahoraUltimovalor"], "%d/%m/%y %H:%M").replace(tzinfo=timezone.utc)
        estacoes.append({
            "id": e["idestacao"], "nome": e["nomeestacao"], "codigo_ibge": e["codibge"],
            "ultima_leitura": iso(hora),
            # "-" na fonte = sem dado no período; mantido como null, nunca como zero.
            "acumulado_mm": {k: num(e[f"acc{k}"]) for k in ("1hr", "3hr", "6hr", "12hr", "24hr", "48hr", "72hr", "96hr")},
            "ultimo_valor_mm": num(e["ultimovalor"]),
        })
    return {"estacoes": estacoes}


# ---------------------------------------------------------------- ANA
def coletar_ana(lims):
    xml = ET.fromstring(baixar(
        "https://telemetriaws1.ana.gov.br/ServiceANA.asmx/ListaEstacoesTelemetricas?statusEstacoes=0&origem=", 180))
    regiao = None
    for g in lims.values():
        regiao = g if regiao is None else regiao.union(g)
    cx = regiao.centroid
    km_lon = 111.32 * math.cos(math.radians(cx.y))
    escolhidas = {}
    for t in xml.iter():
        if not t.tag.endswith("Table"):
            continue
        g = {c.tag: (c.text or "").strip() for c in t}
        la, lo = num(g.get("Latitude")), num(g.get("Longitude"))
        if la is None or lo is None:
            continue
        # distância aproximada aos limites, em km (graus convertidos localmente)
        p = Point(lo, la)
        d_graus = regiao.distance(p)
        if d_graus * min(km_lon, 110.57) > RAIO_ANA_KM:
            continue
        dentro = next((c for c, geo in lims.items() if geo.contains(p)), None)
        escolhidas[g["CodEstacao"]] = {
            "codigo": g["CodEstacao"], "nome": g["NomeEstacao"], "rio": g.get("NomeRio") or None,
            "municipio_uf": g.get("Municipio-UF"), "operadora": g.get("Operadora"),
            "responsavel": g.get("Responsavel"), "lat": la, "lon": lo,
            "codigo_ibge": dentro,
        }
    agora = datetime.now(BRT)
    ini, fim = (agora - timedelta(days=2)).strftime("%d/%m/%Y"), agora.strftime("%d/%m/%Y")
    for est in escolhidas.values():
        est["serie"], est["erro"] = [], None
        try:
            q = urllib.parse.urlencode({"codEstacao": est["codigo"], "dataInicio": ini, "dataFim": fim})
            x = ET.fromstring(baixar(f"https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos?{q}"))
            for r in x.iter():
                if not r.tag.endswith("DadosHidrometereologicos"):
                    continue
                g = {c.tag: c.text for c in r}
                hora = datetime.strptime(g["DataHora"].strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=BRT)
                est["serie"].append({"t": iso(hora), "nivel_cm": num(g.get("Nivel")),
                                     "chuva_mm": num(g.get("Chuva")), "vazao_m3s": num(g.get("Vazao"))})
            est["serie"].sort(key=lambda s: s["t"])
            # série horária para o painel (último registro de cada hora) — reduz o arquivo
            por_hora = {}
            chuva_h = {}
            for s in est["serie"]:
                h = s["t"][:13]
                por_hora[h] = s
                if s["chuva_mm"] is not None:
                    chuva_h[h] = chuva_h.get(h, 0) + s["chuva_mm"]
            est["serie_horaria"] = [{**v, "chuva_mm": round(chuva_h[h], 2) if h in chuva_h else None}
                                    for h, v in por_hora.items()]
            est["ultima_leitura"] = est["serie"][-1]["t"] if est["serie"] else None
            corte = iso(datetime.now(timezone.utc) - timedelta(hours=24))
            chuvas = [s["chuva_mm"] for s in est["serie"] if s["t"] >= corte and s["chuva_mm"] is not None]
            est["chuva_24h_mm"] = round(sum(chuvas), 1) if chuvas else None
            niveis = [s for s in est["serie"] if s["nivel_cm"] is not None]
            est["nivel_atual_cm"] = niveis[-1]["nivel_cm"] if niveis else None
            if len(niveis) >= 2:
                antes = [s for s in niveis if s["t"] <= iso(datetime.fromisoformat(niveis[-1]["t"][:-1] + "+00:00") - timedelta(hours=6))]
                est["variacao_6h_cm"] = round(niveis[-1]["nivel_cm"] - antes[-1]["nivel_cm"], 1) if antes else None
            else:
                est["variacao_6h_cm"] = None
        except Exception as ex:  # estação isolada fora do ar não derruba a coleta
            est["erro"] = str(ex)
        del est["serie"]
        time.sleep(0.5)
    return {"estacoes": sorted(escolhidas.values(), key=lambda e: e["codigo"])}


# ---------------------------------------------------------------- Open-Meteo
def coletar_previsao(lims):
    municipios = []
    for c, geo in lims.items():
        p = geo.representative_point()
        q = urllib.parse.urlencode({
            "latitude": round(p.y, 4), "longitude": round(p.x, 4),
            "hourly": "precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
            "forecast_days": 3, "timezone": "UTC", "wind_speed_unit": "kmh"})
        d = json.loads(baixar(f"https://api.open-meteo.com/v1/forecast?{q}"))
        h = d["hourly"]
        municipios.append({
            "codigo_ibge": c, "lat": round(p.y, 4), "lon": round(p.x, 4),
            "horaria": [{"t": t + ":00Z", "chuva_mm": h["precipitation"][i],
                         "prob_chuva_pct": h["precipitation_probability"][i],
                         "vento_kmh": h["wind_speed_10m"][i], "rajada_kmh": h["wind_gusts_10m"][i],
                         "vento_dir_graus": h["wind_direction_10m"][i]} for i, t in enumerate(h["time"])],
        })
    return {"municipios": municipios}


FONTES = {
    "cemaden": {"nome": "CEMADEN — pluviômetros automáticos", "tipo": "observado",
                "url": "https://www.gov.br/cemaden/", "frequencia_min": 10},
    "ana": {"nome": "ANA — Rede Hidrometeorológica Nacional (telemetria)", "tipo": "observado",
            "url": "https://www.snirh.gov.br/hidrotelemetria/", "frequencia_min": 15},
    "previsao": {"nome": "Open-Meteo — previsão de modelos numéricos (não é fonte oficial)",
                 "tipo": "previsao", "url": "https://open-meteo.com/", "licenca": "CC BY 4.0",
                 "frequencia_min": 60},
}


def main():
    anterior = {}
    if "--anterior" in sys.argv:
        try:
            anterior = json.loads(baixar(sys.argv[sys.argv.index("--anterior") + 1]))
        except Exception as ex:
            print("sem dados anteriores remotos:", ex)
    elif SAIDA.exists():
        anterior = json.loads(SAIDA.read_text(encoding="utf-8"))

    lims = limites()
    coletores = {"cemaden": coletar_cemaden, "ana": lambda: coletar_ana(lims),
                 "previsao": lambda: coletar_previsao(lims)}
    saida = {"gerado_em": iso(datetime.now(timezone.utc)), "fontes": {}}
    for chave, coletor in coletores.items():
        consulta = iso(datetime.now(timezone.utc))
        try:
            dados = coletor()
            saida["fontes"][chave] = {**FONTES[chave], "situacao": "ok", "consultado_em": consulta,
                                      "ultima_coleta_ok": consulta, "dados": dados}
            print(chave, "ok")
        except Exception as ex:
            velho = anterior.get("fontes", {}).get(chave)
            saida["fontes"][chave] = {**FONTES[chave], "situacao": "indisponivel", "erro": str(ex),
                                      "consultado_em": consulta,
                                      "ultima_coleta_ok": velho.get("ultima_coleta_ok") if velho else None,
                                      "dados": velho.get("dados") if velho else None}
            print(chave, "FALHOU:", ex, "(mantidos dados anteriores)" if velho else "")
    SAIDA.write_text(json.dumps(saida, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
