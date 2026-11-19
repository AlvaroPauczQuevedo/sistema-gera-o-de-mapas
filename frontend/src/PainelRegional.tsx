import { useEffect, useState } from "react";
import { atualidade, ATUALIDADE, type Monitoramento } from "./Monitoramento";
import { baixarArquivo, CONDICOES, type Registro } from "./Vistorias";
import { lerExecucoes } from "./Simulacao";

interface IndicadorIbge { codigo_ibge: number; nome: string; populacao: number; area_km2: number; densidade_hab_km2: number }
interface Ibge { municipios: IndicadorIbge[]; fonte: { nome: string; licenca: string; obtido_em: string } }
interface ClasseRelevo { classe: string; area_km2: number }
interface RelevoMin { altitude_m: { min: number; max: number }; declividade_media_pct: number; classes: ClasseRelevo[] }
interface Instituicao { properties: { categoria: string; tipo: string } }

const n = (v: number, d = 0) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const dataUrl = (p: string) => `${import.meta.env.BASE_URL}data/${p}`;
// Classes EMBRAPA "Montanhoso" e "Escarpado" (> 45%): indicador de relevo, não de risco mapeado.
const ingreme = (r?: RelevoMin) => r ? r.classes.filter((c) => c.classe === "Montanhoso" || c.classe === "Escarpado")
  .reduce((s, c) => s + c.area_km2, 0) : null;

function Tile({ valor, rotulo, nota, pendente }: { valor: string; rotulo: string; nota?: string; pendente?: boolean }) {
  return (<div className={`tile${pendente ? " pendente" : ""}`}>
    <div className="tile-valor">{valor}</div><div className="tile-rot">{rotulo}</div>
    {nota && <div className="tile-nota">{nota}</div>}
  </div>);
}

export function PainelRegional({ munis, relevo, monit, registros, onAbrir }: {
  munis: { codigo_ibge: number; nome: string }[]; relevo: Record<number, RelevoMin>; monit: Monitoramento | null;
  registros: Registro[]; onAbrir: (codigo: number) => void;
}) {
  const [ibge, setIbge] = useState<Ibge | null>(null);
  const [inst, setInst] = useState<Record<number, Instituicao[]>>({});
  const [risco, setRisco] = useState<Record<string, { setores: number; pessoas: number; edificacoes: number; por_grau: Record<string, number> }> | null>(null);
  useEffect(() => {
    fetch(dataUrl("indicadores_ibge.json")).then((r) => r.json()).then(setIbge).catch(() => setIbge(null));
    fetch(dataUrl("areas_risco_resumo.json")).then((r) => r.json()).then(setRisco).catch(() => setRisco(null));
    Promise.all(munis.map((m) => fetch(dataUrl(`${m.codigo_ibge}/instituicoes.geojson`))
      .then((r) => (r.ok ? r.json() : { features: [] })).then((g) => [m.codigo_ibge, g.features] as const)
      .catch(() => [m.codigo_ibge, []] as const)))
      .then((xs) => setInst(Object.fromEntries(xs)));
  }, [munis]);

  const cem = monit?.fontes.cemaden.dados?.estacoes ?? [];
  const ana = monit?.fontes.ana.dados?.estacoes ?? [];
  const prev = monit?.fontes.previsao.dados?.municipios ?? [];
  const abertos = registros.filter((r) => r.situacao === "aberto");
  const todasInst = Object.values(inst).flat();
  const emergencia = todasInst.filter((i) => ["Segurança", "Saúde"].includes(i.properties.categoria)).length;
  const abrigos = todasInst.filter((i) => i.properties.categoria === "Acolhimento").length;
  const fontesDesat = monit ? Object.values(monit.fontes).filter((f) => f.situacao !== "ok" || atualidade(f.ultima_coleta_ok) !== "recente").length : 3;
  const anaRecentes = ana.filter((e) => atualidade(e.ultima_leitura) === "recente").length;
  const pop = ibge?.municipios.reduce((s, m) => s + m.populacao, 0);
  const area = ibge?.municipios.reduce((s, m) => s + m.area_km2, 0);
  const ingremeTotal = munis.reduce((s, m) => s + (ingreme(relevo[m.codigo_ibge]) ?? 0), 0);

  const linhas = munis.map((m) => {
    const i = ibge?.municipios.find((x) => x.codigo_ibge === m.codigo_ibge);
    const cm = cem.filter((e) => e.codigo_ibge === m.codigo_ibge);
    const chuva24 = cm.map((e) => e.acumulado_mm["24hr"]).filter((v): v is number => v !== null);
    const chuva72 = cm.map((e) => e.acumulado_mm["72hr"]).filter((v): v is number => v !== null);
    const p = prev.find((x) => x.codigo_ibge === m.codigo_ibge);
    const prev72 = p ? p.horaria.filter((h) => Date.parse(h.t) > Date.now()).slice(0, 72).reduce((s, h) => s + h.chuva_mm, 0) : null;
    const rajada = p ? Math.max(...p.horaria.filter((h) => Date.parse(h.t) > Date.now()).slice(0, 72).map((h) => h.rajada_kmh ?? 0)) : null;
    const ing = ingreme(relevo[m.codigo_ibge]);
    return {
      m, i, pluviometros: cm.length, chuva24: chuva24.length ? Math.max(...chuva24) : null,
      chuva72: chuva72.length ? Math.max(...chuva72) : null, prev72, rajada,
      anaNo: ana.filter((e) => e.codigo_ibge === m.codigo_ibge).length,
      inst: inst[m.codigo_ibge]?.length ?? null, abertos: abertos.filter((r) => r.codigo_ibge === m.codigo_ibge),
      ingreme: ing, ingremePct: ing !== null && relevo[m.codigo_ibge]
        ? (100 * ing) / relevo[m.codigo_ibge].classes.reduce((s, c) => s + c.area_km2, 0) : null,
    };
  });

  const exportarCsv = () => {
    const cab = ["codigo_ibge", "municipio", "populacao_2022", "area_km2", "densidade", "pluviometros_cemaden",
      "chuva_24h_max_mm", "chuva_72h_max_mm", "previsao_72h_mm_modelo", "rajada_max_72h_kmh_modelo", "estacoes_ana_no_municipio",
      "instituicoes_osm", "area_decliv_maior_45pct_km2", "registros_campo_abertos"];
    const linhasCsv = linhas.map((l) => [l.m.codigo_ibge, l.m.nome, l.i?.populacao, l.i?.area_km2, l.i?.densidade_hab_km2,
      l.pluviometros, l.chuva24, l.chuva72, l.prev72?.toFixed(1), l.rajada?.toFixed(0), l.anaNo, l.inst,
      l.ingreme?.toFixed(2), l.abertos.length].map((v) => (v ?? "")).join(";"));
    baixarArquivo(`painel-regional-${new Date().toISOString().slice(0, 16).replace(":", "h")}.csv`,
      "﻿" + [cab.join(";"), ...linhasCsv].join("\n") + `\n\nGerado em;${new Date().toISOString()}\n` +
      `Fontes;IBGE Censo 2022; CEMADEN; ANA; Open-Meteo (modelo, não oficial); OSM; Copernicus GLO-30\n`, "text/csv");
  };

  return (<div className="painel">
    <div className="painel-cab">
      <div><h1>Central regional</h1>
        <p className="muted">Todos os números abaixo são calculados a partir dos dados carregados. Onde não há dado, aparece "pendente".</p></div>
      <div className="linha"><button onClick={exportarCsv}>Exportar planilha (CSV)</button>
        <button onClick={() => window.print()}>Imprimir / PDF</button></div>
    </div>

    <h2>Painel executivo</h2>
    <div className="tiles">
      <Tile valor={n(munis.length)} rotulo="Municípios mapeados" />
      <Tile valor={pop !== undefined ? n(pop) : "—"} rotulo="População (Censo 2022)" nota="IBGE" />
      <Tile valor={area !== undefined ? `${n(area, 1)} km²` : "—"} rotulo="Área territorial" nota="IBGE" />
      <Tile valor={n(cem.length + ana.length)} rotulo="Pontos de monitoramento"
        nota={`${cem.length} CEMADEN · ${ana.length} ANA (${anaRecentes} com dado recente)`} />
      <Tile valor={n(todasInst.length)} rotulo="Estruturas públicas mapeadas" nota="OSM, não verificadas em campo" />
      <Tile valor={n(emergencia)} rotulo="Recursos de emergência" nota="segurança + saúde (OSM)" />
      <Tile valor={n(abrigos)} rotulo="Possíveis locais de acolhimento" nota="escolas, ginásios, centros (OSM) — não são abrigos oficiais" />
      <Tile valor={`${n(ingremeTotal, 1)} km²`} rotulo="Relevo com declividade > 45%" nota="indicador de relevo, não área de risco mapeada" />
      {risco ? <Tile valor={n(Object.values(risco).reduce((s, r) => s + r.setores, 0))} rotulo="Setores de risco geológico (SGB)"
        nota={`${n(Object.values(risco).reduce((s, r) => s + r.pessoas, 0))} pessoas e ${n(Object.values(risco).reduce((s, r) => s + r.edificacoes, 0))} edificações estimadas pelo SGB · ${Object.values(risco).filter((r) => r.setores).length} de ${munis.length} municípios mapeados`} />
        : <Tile valor="pendente" pendente rotulo="Áreas de risco oficiais" nota="rode scripts/fetch_sgb_risco.py" />}
      <Tile valor="pendente" pendente rotulo="Alertas oficiais" nota="integração Defesa Civil RS / INMET pendente" />
      <Tile valor={n(lerExecucoes().length)} rotulo="Simulações executadas" nota="estimativas HAND, neste aparelho" />
      <Tile valor={n(abertos.length)} rotulo="Registros de campo em aberto"
        nota={`${abertos.filter((r) => r.requer_providencia).length} requerem providência · neste aparelho`} />
      <Tile valor={n(fontesDesat)} rotulo="Fontes de monitoramento não recentes" nota="de 3 integradas" pendente={fontesDesat > 0} />
    </div>

    <h2>Comparação entre municípios</h2>
    <div className="tabela-rolagem"><table className="comparacao"><thead><tr>
      <th>Município</th><th>População</th><th>Área (km²)</th><th>Chuva 24 h<br /><span className="tag tag-obs">OBS.</span></th>
      <th>Chuva 72 h<br /><span className="tag tag-obs">OBS.</span></th><th>Chuva prevista 72 h<br /><span className="tag tag-prev">MODELO</span></th>
      <th>Rajada máx. 72 h<br /><span className="tag tag-prev">MODELO</span></th>
      <th>Estações ANA</th><th>Setores de risco (SGB)</th><th>Estruturas (OSM)</th><th>Declividade &gt; 45%</th><th>Campo em aberto</th><th></th>
    </tr></thead><tbody>
      {linhas.map((l) => (<tr key={l.m.codigo_ibge}>
        <td><b>{l.m.nome}</b></td>
        <td>{l.i ? n(l.i.populacao) : "—"}</td>
        <td>{l.i ? n(l.i.area_km2, 1) : "—"}</td>
        <td>{l.pluviometros ? (l.chuva24 !== null ? `${n(l.chuva24, 1)} mm` : "sem valor") : "sem pluviômetro"}</td>
        <td>{l.pluviometros ? (l.chuva72 !== null ? `${n(l.chuva72, 1)} mm` : "sem valor") : "—"}</td>
        <td>{l.prev72 !== null ? `${n(l.prev72, 1)} mm` : "—"}</td>
        <td>{l.rajada !== null ? `${n(l.rajada)} km/h` : "—"}</td>
        <td>{n(l.anaNo)}</td>
        <td>{risco?.[l.m.codigo_ibge] ? (risco[l.m.codigo_ibge].setores ? <>{risco[l.m.codigo_ibge].setores} <span className="muted">
          ({risco[l.m.codigo_ibge].pessoas} pess.)</span></> : "não mapeado") : "—"}</td>
        <td>{l.inst ?? "—"}</td>
        <td>{l.ingreme !== null ? <>{n(l.ingreme, 1)} km² <span className="muted">({n(l.ingremePct!, 0)}%)</span>
          <span className="trilho"><span style={{ width: `${l.ingremePct}%`, background: "#fc8d59" }} /></span></> : "—"}</td>
        <td>{l.abertos.length ? l.abertos.map((r) => <span key={r.id} title={`${r.natureza} — ${CONDICOES[r.condicao].rotulo}`}
          style={{ color: CONDICOES[r.condicao].cor }}>{CONDICOES[r.condicao].icone} </span>) : "0"}</td>
        <td><button onClick={() => onAbrir(l.m.codigo_ibge)}>Abrir no mapa</button></td>
      </tr>))}
    </tbody></table></div>
    <p className="muted">Chuva observada = maior acumulado entre os pluviômetros CEMADEN do município ("sem valor": a fonte não informou).
      Previsão e rajada: modelo Open-Meteo no ponto central do município, não oficial.
      Declividade sobre modelo de superfície Copernicus 30 m.</p>

    <h2>Situação das fontes</h2>
    <table className="props"><tbody>
      {monit ? Object.entries(monit.fontes).map(([k, f]) => {
        const a = f.situacao === "ok" ? atualidade(f.ultima_coleta_ok) : "desatualizado";
        return (<tr key={k}><td>{f.nome}</td><td style={{ color: ATUALIDADE[a].cor }}>{ATUALIDADE[a].icone} {ATUALIDADE[a].rotulo}</td>
          <td>{f.ultima_coleta_ok ? new Date(f.ultima_coleta_ok).toLocaleString("pt-BR") : "—"}</td></tr>);
      }) : <tr><td>Monitoramento não carregado.</td></tr>}
      {ibge && <tr><td>{ibge.fonte.nome}</td><td>dado censitário</td><td>{new Date(ibge.fonte.obtido_em).toLocaleDateString("pt-BR")}</td></tr>}
    </tbody></table>
  </div>);
}
