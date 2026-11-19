"""Coleta dos sites oficiais das prefeituras: secretarias, unidades de saúde e órgãos/centros municipais
(CRAS, CREAS, CAPS, Conselho Tutelar, Defesa Civil...), com endereço, telefone e horário de atendimento.
Os endereços são geolocalizados pelo Nominatim (OpenStreetMap), 1 consulta/s, com cache; a posição só é
aceita se cair dentro do município. E-mails não são coletados (o site os protege contra coleta automática).

Saída: frontend/public/data/<codigo>/prefeitura.json (todos os órgãos) e prefeitura.geojson (os localizados).

Sites atrás de verificação antirrobô (ex.: "Vercel Security Checkpoint") são registrados como inacessíveis —
este script não tenta contornar essas proteções."""
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import unicodedata

from shapely.geometry import MultiPoint, Point, shape
from shapely.ops import nearest_points, unary_union

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.municipios import MUNICIPIOS  # noqa: E402

MUNICIPIO_ATUAL = ""
UA = {"User-Agent": "Mozilla/5.0 (gemeos-digitais; coleta de dados publicos para Defesa Civil)"}
SITES = {4322806: "https://www.veranopolis.rs.gov.br", 4305959: "https://www.cotipora.rs.gov.br",
         4322350: "https://www.uniaodaserra.rs.gov.br", 4320404: "https://www.serafinacorrea.rs.gov.br",
         4307864: "https://www.fagundesvarela.rs.gov.br", 4312351: "https://www.montauri.rs.gov.br"}
CACHE = ROOT / "backend" / "data" / "geocode_cache.json"
RELEVANTE = re.compile(r"defesa civil|cras|creas|caps|conselho tutelar|obras|infraestrutura|sa[úu]de|assist|social|habita|"
                       r"educa|desporto|gin[áa]sio|esporte|agricultura|gabinete|administra|oficina|engenharia|centro|posto|esf|ubs|"
                       r"tr[âa]nsito|saneamento|meio ambiente|governo", re.I)


class Bloqueado(Exception):
    pass


def baixar(url):
    time.sleep(1)  # educado com o servidor da prefeitura
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            t = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise Bloqueado(f"HTTP {e.code}")
        raise
    if "Security Checkpoint" in t or "cf-challenge" in t:
        raise Bloqueado("verificação antirrobô")
    return t


def texto(t):
    t = re.sub(r"<script.*?</script>|<style.*?</style>", "", t, flags=re.S)
    t = html.unescape(re.sub(r"<[^>]+>", "\n", t))
    return [l.strip() for l in t.splitlines() if l.strip()]


ROTULOS_CONHECIDOS = re.compile(r"^(e-?mail|telefone|fone|atendimento|hor[áa]rio|descri|endere[çc]o|respons|categoria|secretaria)", re.I)


def campo(linhas, rotulos):
    """Valor de um campo: o rótulo exato (seguido de ':' ou fim de linha) e o valor na mesma linha
    ou nas linhas seguintes (telefones às vezes vêm quebrados: "(54)" / "3446-2810")."""
    for i, l in enumerate(linhas):
        for r in rotulos:
            m = re.match(rf"^{r}\s*(?::\s*(.*))?$", l, re.I)
            if not m:
                continue
            partes = [m.group(1).strip()] if m.group(1) and m.group(1).strip() else []
            j = i + 1
            while j < len(linhas) and j <= i + 3 and not ROTULOS_CONHECIDOS.match(linhas[j]):
                if partes and not re.fullmatch(r"\(?\d{2}\)?", partes[-1]):  # só continua se o anterior era só o DDD
                    break
                partes.append(linhas[j])
                j += 1
            v = " ".join(partes).strip()
            if v and "[email" not in v:
                return v[:200]
    return None


def links(t, padrao):
    return sorted(set(re.findall(rf'href="((?:https?://[^"]+)?/{padrao}/view/\d+[^"#?]*)"', t)))


def coletar_plataforma_view(base, home=""):
    """Plataforma usada por Veranópolis e Cotiporã: /secretaria, /departamento, /unidade-saude."""
    # links já presentes na página inicial (menu) + páginas de índice de cada seção
    paginas = {(sec, u) for sec in ["secretaria", "departamento", "unidade-saude"] for u in links(home, sec)}
    for secao in ["secretaria", "departamento", "unidade-saude"]:
        for pg in range(1, 8):
            try:
                t = baixar(f"{base}/{secao}?page={pg}")
            except urllib.error.HTTPError:
                break
            novos = {(secao, u) for u in links(t, secao)} - paginas
            if not novos:
                break
            paginas |= novos
    orgaos = []
    vistos = set()
    for secao, u in sorted(paginas):
        url = u if u.startswith("http") else base + u
        chave = re.sub(r"/view/(\d+).*", r"/view/\1", url)
        if chave in vistos:
            continue
        vistos.add(chave)
        try:
            bruto = baixar(url)
        except Exception as ex:
            print("   falhou", url, ex)
            continue
        ls = texto(bruto)
        # título da própria página (og:title / <title>), sem o nome do site
        # título da própria página: partes de og:title/<title> que não sejam o nome do site ou do município
        titulo = None
        for m in [re.search(r'property="og:title" content="([^"]+)"', bruto), re.search(r"<title>([^<]+)</title>", bruto)]:
            if not m:
                continue
            partes = [x.strip() for x in re.split(r"\s+[|–-]\s+", html.unescape(m.group(1)))]
            uteis = [x for x in partes if x and not re.search(r"prefeitura|munic[íi]pio", x, re.I)
                     and x.lower() != MUNICIPIO_ATUAL.lower()]
            if uteis:
                titulo = uteis[0]
                break
        if not titulo:  # título genérico: usa o endereço da página
            slug = re.sub(r"[?#].*$", "", url).rstrip("/").rsplit("/", 1)[-1]
            titulo = slug.replace("-", " ").capitalize() if not slug.isdigit() else None
        cat = campo(ls, ["Categoria"]) or {"secretaria": "Secretaria", "unidade-saude": "Unidade de saúde"}.get(secao, "Departamento")
        org = {"nome": titulo or chave.rsplit("/", 1)[-1], "categoria_site": cat, "secao": secao,
               "secretaria": campo(ls, ["Secretaria respons[áa]vel"]),
               "endereco": campo(ls, ["Endere[çc]o"]), "telefone": campo(ls, ["Telefones?", "Fones?"]),
               "atendimento": campo(ls, ["Atendimento", "Hor[áa]rio de Atendimento"]), "url": url}
        if secao == "departamento" and re.match(r"Conselhos|Setor", cat or "", re.I) and not re.search(r"tutelar|defesa", org["nome"], re.I):
            continue  # setores internos (licitações, RH...) e conselhos não são estrutura de resposta
        orgaos.append(org)
    return orgaos


def coletar_generico(base, home):
    """Outras plataformas: segue links de secretarias/telefones e extrai rótulos comuns."""
    alvos = sorted(set(u for u in re.findall(r'href="([^"]+)"', home)
                       if re.search(r"/secretarias?/|telefones", u) and (u.startswith(base) or u.startswith("/"))))
    orgaos = []
    for u in alvos[:30]:
        url = u if u.startswith("http") else base + u
        try:
            ls = texto(baixar(url))
        except Exception as ex:
            print("   falhou", url, ex)
            continue
        nome = next((l for l in ls if re.match(r"^(Secretaria|Gabinete)", l)), url.rstrip("/").rsplit("/", 1)[-1])
        orgaos.append({"nome": nome, "categoria_site": "Secretaria" if "secretaria" in url else "Telefones úteis", "secao": "generico",
                       "endereco": campo(ls, ["Endere[çc]o"]), "telefone": campo(ls, ["Telefone", "Fone", "Contato"]),
                       "atendimento": campo(ls, ["Hor[áa]rio", "Atendimento", "Expediente"]), "url": url})
    return orgaos


ABREV = [(r"^Av\.?\s", "Avenida "), (r"^R\.\s", "Rua "), (r"^Trav\.?\s", "Travessa "), (r"^Pça\.?\s|^Pç\.?\s", "Praça "),
         (r"^Est\.?\s", "Estrada "), (r"\bDr\.\s", "Doutor "), (r"\bPe\.\s", "Padre "), (r"\bCap\.\s", "Capitão ")]


def _nominatim(params, cache):
    chave = json.dumps(params, sort_keys=True, ensure_ascii=False)
    if chave in cache:
        return cache[chave]
    time.sleep(1.1)  # política de uso do Nominatim: no máximo 1 consulta por segundo
    q = urllib.parse.urlencode({**params, "format": "json", "limit": 1, "countrycodes": "br", "addressdetails": 0})
    try:
        with urllib.request.urlopen(urllib.request.Request(f"https://nominatim.openstreetmap.org/search?{q}", headers=UA), timeout=40) as r:
            res = json.load(r)
    except Exception as ex:
        print("   geocodificação falhou:", ex)
        return None
    val = {"lat": float(res[0]["lat"]), "lon": float(res[0]["lon"]), "precisao": res[0].get("addresstype") or res[0].get("type")} if res else None
    cache[chave] = val
    return val


TIPOS_VIA = r"^(rua|avenida|av|travessa|trav|estrada|rodovia|praca|alameda|largo|linha|beco|acesso)\.?\s+"


def normalizar_via(nome):
    n = unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode().lower()
    n = re.sub(TIPOS_VIA, "", n.strip())
    n = re.sub(r"\b(dr|doutor|pe|padre|cap|capitao|prof|professor|mons|monsenhor|sen|senador|ver|vereador|gen|general)\b\.?", "", n)
    return re.sub(r"[^a-z0-9]+", " ", n).strip()


class RuasOSM:
    """Localiza um endereço sobre as vias do OSM já baixadas (nome igual ignorando tipo de via e acentos).
    Sem numeração no OSM, o ponto é o trecho da via mais próximo do centro urbano (instituições)."""

    def __init__(self, codigo):
        pasta = ROOT / "frontend/public/data" / str(codigo)
        self.vias = {}
        for f in json.loads((pasta / "vias.geojson").read_text(encoding="utf-8"))["features"]:
            nome = f["properties"].get("name")
            if nome:
                self.vias.setdefault(normalizar_via(nome), []).append(shape(f["geometry"]))
        inst = json.loads((pasta / "instituicoes.geojson").read_text(encoding="utf-8"))["features"] if (pasta / "instituicoes.geojson").exists() else []
        self.centro = MultiPoint([shape(f["geometry"]) for f in inst]).centroid if inst else None

    def localizar(self, logradouro):
        linhas = self.vias.get(normalizar_via(logradouro))
        if not linhas:
            return None
        geo = unary_union(linhas)
        p = nearest_points(geo, self.centro)[0] if self.centro else geo.interpolate(0.5, normalized=True)
        return {"lat": p.y, "lon": p.x, "precisao": "via do OSM (sem número; trecho mais próximo do centro)"}


def geocodificar(endereco, municipio, cache, ruas=None):
    """1º: vias do OSM já baixadas; 2º: Nominatim estruturado (rua + número); 3º: Nominatim só a rua."""
    if not endereco:
        return None
    end = re.sub(r"\s*[-–]?\s*CEP.*$", "", endereco, flags=re.I)
    end = re.sub(r"\s*[-–]\s*[^,]*?/RS\s*$", "", end)
    rua = re.split(r"\s+[-–]\s+|,\s*(?:bairro|centro)\b", end, flags=re.I)[0].strip(" ,")
    for a, b in ABREV:
        rua = re.sub(a, b, rua, flags=re.I)
    m = re.match(r"^(.*?)[,\s]+(?:n[º°o.]*\s*)?(\d+)\b", rua, re.I)
    logradouro, numero = (m.group(1).strip(" ,"), m.group(2)) if m else (re.sub(r",?\s*s/?n[º°o]?.*$", "", rua, flags=re.I).strip(" ,"), None)
    if ruas and (g := ruas.localizar(logradouro)):
        return g
    base = {"city": municipio, "state": "Rio Grande do Sul", "country": "Brasil"}
    if numero:
        g = _nominatim({**base, "street": f"{numero} {logradouro}"}, cache)
        if g:
            return g
    g = _nominatim({**base, "street": logradouro}, cache)
    if g:
        g = {**g, "precisao": f"{g['precisao']} (só a rua; número não encontrado)" if numero else g["precisao"]}
    return g


def main():
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    for codigo, nome in MUNICIPIOS.items():
        base = SITES.get(codigo)
        global MUNICIPIO_ATUAL
        MUNICIPIO_ATUAL = nome
        limite = shape(json.loads((ROOT / "backend/data/boundaries" / f"{codigo}.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"])
        situacao = "ok"
        try:
            home = baixar(base + "/")
            orgaos = coletar_plataforma_view(base, home) if "/secretaria/view/" in home else coletar_generico(base, home)
        except Bloqueado as b:
            orgaos, situacao = [], f"site inacessível para coleta automática ({b})"
        except Exception as ex:
            orgaos, situacao = [], f"erro: {ex}"
        orgaos = [o for o in orgaos if RELEVANTE.search(o["nome"] + " " + (o.get("secretaria") or ""))]
        unicos = {}
        for o in orgaos:  # mesmo órgão listado em duas páginas: fica o registro com mais campos
            k = re.sub(r"\s*-\s*prefeitura.*$", "", o["nome"], flags=re.I).strip().lower()
            if k not in unicos or sum(bool(o.get(c)) for c in ("endereco", "telefone", "atendimento")) > \
                    sum(bool(unicos[k].get(c)) for c in ("endereco", "telefone", "atendimento")):
                unicos[k] = {**o, "nome": re.sub(r"\s*-\s*Prefeitura Municipal.*$", "", o["nome"]).strip()}
        orgaos = list(unicos.values())
        feats = []
        ruas = RuasOSM(codigo)
        for o in orgaos:
            g = geocodificar(o["endereco"], nome, cache, ruas)
            # rua genérica ou fora do município: não usa a posição
            if g and limite.contains(Point(g["lon"], g["lat"])) and g["precisao"].split(" ")[0] not in ("city", "town", "village", "municipality", "administrative", "county", "state"):
                o["geolocalizacao"] = f"aproximada, a partir do endereço do site: {g['precisao']}"
                feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [g["lon"], g["lat"]]},
                              "properties": {**o, "name": o["nome"], "categoria": "Prefeitura", "tipo": o["categoria_site"],
                                             "situacao": "site oficial da prefeitura; posição aproximada"}})
            else:
                o["geolocalizacao"] = "não localizado (endereço ausente, genérico ou fora do município)"
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8")
        fonte = {"nome": f"Site oficial da Prefeitura de {nome}", "url": base, "licenca": "informação pública",
                 "obtido_em": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "situacao": situacao}
        pasta = ROOT / "frontend/public/data" / str(codigo)
        (pasta / "prefeitura.json").write_text(json.dumps({"orgaos": orgaos, "fonte": fonte}, ensure_ascii=False, indent=1), encoding="utf-8")
        (pasta / "prefeitura.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats, "fonte": fonte},
                                                            ensure_ascii=False), encoding="utf-8")
        print(f"{nome}: {situacao} — {len(orgaos)} órgãos, {len(feats)} localizados")


if __name__ == "__main__":
    main()
