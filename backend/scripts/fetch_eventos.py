"""Baixa da ANA as séries observadas de eventos de cheia já ocorridos, para alimentar e calibrar as
simulações (seções 17 e 21). Saída: frontend/public/data/eventos/eventos.json + <id>.json

Para incluir um evento: acrescente em EVENTOS (estação, rio, janela de datas). O nível é o da régua
da estação (referência própria); a simulação usa a SUBIDA em relação ao nível do início do evento."""
import json
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "public" / "data" / "eventos"
BRT = timezone(timedelta(hours=-3))

EVENTOS = [
    {"id": "antas-2023-09", "nome": "Cheia de setembro de 2023 (ciclone extratropical)", "rio": "rio_das_antas",
     "estacao": "86472000", "estacao_nome": "Linha José Júlio (SGB/CPRM) — Rio das Antas", "inicio": "01/09/2023", "fim": "10/09/2023"},
    {"id": "antas-2023-11", "nome": "Cheia de novembro de 2023", "rio": "rio_das_antas",
     "estacao": "86472000", "estacao_nome": "Linha José Júlio (SGB/CPRM) — Rio das Antas", "inicio": "14/11/2023", "fim": "24/11/2023"},
    {"id": "antas-2024-05", "nome": "Cheia de maio de 2024 (rompimento parcial da barragem 14 de Julho)", "rio": "rio_das_antas",
     "estacao": "86472000", "estacao_nome": "Linha José Júlio (SGB/CPRM) — Rio das Antas", "inicio": "27/04/2024", "fim": "08/05/2024"},
]


def serie(estacao, ini, fim):
    q = urllib.parse.urlencode({"codEstacao": estacao, "dataInicio": ini, "dataFim": fim})
    req = urllib.request.Request(f"https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos?{q}",
                                 headers={"User-Agent": "gemeos-digitais/0.1"})
    for tentativa in range(5):  # o serviço da ANA falha de forma intermitente (HTTP 500)
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                x = ET.fromstring(r.read())
            break
        except Exception as ex:
            print("  tentativa", tentativa + 1, "falhou:", ex)
            time.sleep(10 * (tentativa + 1))
    else:
        raise RuntimeError("ANA indisponível")
    pts = []
    for e in x.iter():
        if not e.tag.endswith("DadosHidrometereologicos"):
            continue
        g = {c.tag: c.text for c in e}
        if not g.get("Nivel"):
            continue
        t = datetime.strptime(g["DataHora"].strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=BRT)
        pts.append({"t": t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "nivel_cm": float(g["Nivel"]), "chuva_mm": float(g["Chuva"]) if g.get("Chuva") else None})
    return sorted(pts, key=lambda p: p["t"])


OUT.mkdir(parents=True, exist_ok=True)
indice = []
for ev in EVENTOS:
    pts = serie(ev["estacao"], ev["inicio"], ev["fim"])
    if not pts:
        print(ev["id"], "sem dados")
        continue
    base = min(p["nivel_cm"] for p in pts[: max(1, len(pts) // 10)])  # nível no início do evento
    pico = max(pts, key=lambda p: p["nivel_cm"])
    # Lacunas > 2 h podem indicar falha do sensor durante a cheia.
    lacunas = [(a["t"], b["t"]) for a, b in zip(pts, pts[1:])
               if (datetime.fromisoformat(b["t"][:-1]) - datetime.fromisoformat(a["t"][:-1])).total_seconds() > 7200]
    resumo = {**ev, "pontos": len(pts), "nivel_base_cm": base, "pico_cm": pico["nivel_cm"], "pico_em": pico["t"],
              "subida_max_m": round((pico["nivel_cm"] - base) / 100, 2),
              "chuva_total_mm": round(sum(p["chuva_mm"] or 0 for p in pts), 1), "lacunas_maiores_2h": lacunas,
              "fonte": "ANA — telemetria (HidroWeb), dado bruto não consistido", "arquivo": f"{ev['id']}.json"}
    (OUT / f"{ev['id']}.json").write_text(json.dumps({**resumo, "serie": pts}, ensure_ascii=False), encoding="utf-8")
    indice.append(resumo)
    print(ev["id"], len(pts), "pontos; subida máx.", resumo["subida_max_m"], "m em", pico["t"], "; lacunas:", len(lacunas))
    time.sleep(1)
(OUT / "eventos.json").write_text(json.dumps({"eventos": indice, "gerado_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                                             ensure_ascii=False, indent=1), encoding="utf-8")
