import { useState } from "react";

// ---- Tipos do arquivo data/monitoramento.json (gerado por backend/scripts/collect_monitoring.py)
export interface PontoSerie { t: string; nivel_cm: number | null; chuva_mm: number | null; vazao_m3s: number | null }
export interface EstacaoAna {
  codigo: string; nome: string; rio: string | null; municipio_uf: string; operadora: string;
  lat: number; lon: number; codigo_ibge: number | null; erro: string | null;
  serie_horaria?: PontoSerie[]; ultima_leitura?: string | null; chuva_24h_mm?: number | null;
  nivel_atual_cm?: number | null; variacao_6h_cm?: number | null;
}
export interface EstacaoCemaden {
  id: number; nome: string; codigo_ibge: number; ultima_leitura: string;
  acumulado_mm: Record<string, number | null>; ultimo_valor_mm: number | null;
}
export interface PrevisaoHora { t: string; chuva_mm: number; prob_chuva_pct: number; vento_kmh: number; rajada_kmh: number; vento_dir_graus: number }
interface FonteMonit<T> {
  nome: string; tipo: "observado" | "previsao"; url: string; frequencia_min: number; licenca?: string;
  situacao: "ok" | "indisponivel"; erro?: string; consultado_em: string; ultima_coleta_ok: string | null; dados: T | null;
}
export interface Monitoramento {
  gerado_em: string;
  fontes: {
    cemaden: FonteMonit<{ estacoes: EstacaoCemaden[] }>;
    ana: FonteMonit<{ estacoes: EstacaoAna[] }>;
    previsao: FonteMonit<{ municipios: { codigo_ibge: number; horaria: PrevisaoHora[] }[] }>;
  };
}

// ---- Atualidade do dado (seção 12: nunca apresentar dado antigo como tempo real)
export type Atualidade = "recente" | "atrasado" | "desatualizado";
export const ATUALIDADE: Record<Atualidade, { cor: string; icone: string; rotulo: string }> = {
  recente: { cor: "#3fb950", icone: "●", rotulo: "Recente (até 2 h)" },
  atrasado: { cor: "#d29922", icone: "◐", rotulo: "Atrasado (2–24 h)" },
  desatualizado: { cor: "#f85149", icone: "✕", rotulo: "Desatualizado (> 24 h ou sem dado)" },
};
export function atualidade(iso?: string | null): Atualidade {
  if (!iso) return "desatualizado";
  const h = (Date.now() - Date.parse(iso)) / 3.6e6;
  return h <= 2 ? "recente" : h <= 24 ? "atrasado" : "desatualizado";
}
// Escala sequencial de intensidade de chuva (mm/h), um só matiz (azul), claro → escuro.
// O mapa de fundo é claro, então mais chuva = mais escuro.
export const ESCALA_CHUVA: { ate: number; cor: string; rotulo: string }[] = [
  { ate: 0.1, cor: "#e6edf3", rotulo: "sem chuva" },
  { ate: 1, cor: "#b6d7ff", rotulo: "0,1–1" },
  { ate: 5, cor: "#79b8ff", rotulo: "1–5" },
  { ate: 10, cor: "#388bfd", rotulo: "5–10" },
  { ate: 20, cor: "#1f6feb", rotulo: "10–20" },
  { ate: 50, cor: "#0d419d", rotulo: "20–50" },
  { ate: Infinity, cor: "#051d4d", rotulo: "> 50" },
];
export const corChuva = (mm: number | null | undefined) =>
  mm === null || mm === undefined ? null : ESCALA_CHUVA.find((c) => mm < c.ate)!.cor;

const idade = (iso?: string | null) => {
  if (!iso) return "—";
  const min = Math.round((Date.now() - Date.parse(iso)) / 6e4);
  return min < 60 ? `há ${min} min` : min < 48 * 60 ? `há ${Math.round(min / 60)} h` : `há ${Math.round(min / 1440)} dias`;
};
const hora = (iso?: string | null) => iso
  ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const mm = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v.toFixed(1)} mm`);

function Selo({ a }: { a: Atualidade }) {
  const s = ATUALIDADE[a];
  return <span className="selo" style={{ color: s.cor }}>{s.icone} <span>{s.rotulo.split(" (")[0]}</span></span>;
}

/** Barras de uma série só (chuva prevista por hora), com dica ao passar o mouse. */
function BarrasChuva({ horas, tempo }: { horas: PrevisaoHora[]; tempo: number | null }) {
  const [foco, setFoco] = useState<number | null>(null);
  const W = 268, H = 90, base = H - 14;
  const max = Math.max(5, ...horas.map((h) => h.chuva_mm));
  const bw = W / horas.length;
  const dias = horas.map((h, i) => ({ i, d: new Date(h.t) })).filter(({ d }) => d.getHours() === 0);
  const f = foco !== null ? horas[foco] : null;
  return (
    <div className="grafico">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" onMouseLeave={() => setFoco(null)}>
        <line x1={0} x2={W} y1={base} y2={base} className="eixo" />
        <text x={0} y={8} className="rot-eixo">{max.toFixed(0)} mm/h</text>
        {dias.map(({ i, d }) => (
          <g key={i}><line x1={i * bw} x2={i * bw} y1={10} y2={base} className="grade" />
            <text x={i * bw + 2} y={H - 3} className="rot-eixo">{d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</text></g>))}
        {horas.map((h, i) => {
          const alt = (h.chuva_mm / max) * (base - 12);
          return (<g key={i} onMouseEnter={() => setFoco(i)}>
            <rect x={i * bw} y={10} width={bw} height={base - 10} fill="transparent" />
            {alt > 0 && <rect x={i * bw + 0.5} y={base - alt} width={Math.max(bw - 1, 1)} height={alt}
              rx={1} fill={foco === i ? "#9ecbff" : "#58a6ff"} />}
          </g>);
        })}
        {tempo !== null && (() => {
          const i = horas.findIndex((h) => h.t.slice(0, 13) === new Date(tempo).toISOString().slice(0, 13));
          return i >= 0 ? <line x1={i * bw + bw / 2} x2={i * bw + bw / 2} y1={10} y2={base} className="cruz" /> : null;
        })()}
      </svg>
      <div className="dica">{f ? `${hora(f.t)} · ${f.chuva_mm.toFixed(1)} mm · prob. ${f.prob_chuva_pct ?? "—"}% · rajada ${f.rajada_kmh?.toFixed(0) ?? "—"} km/h`
        : "Passe o mouse sobre as barras."}</div>
    </div>
  );
}

/** Linha do nível da estação ANA (48 h), valores brutos da fonte. */
function LinhaNivel({ serie }: { serie: PontoSerie[] }) {
  const [foco, setFoco] = useState<number | null>(null);
  const pts = serie.filter((s) => s.nivel_cm !== null);
  if (pts.length < 2) return <p className="muted">Sem série de nível suficiente.</p>;
  const W = 268, H = 90, top = 12, base = H - 14;
  const vs = pts.map((p) => p.nivel_cm!);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 10) { lo -= 5; hi += 5; }
  const t0 = Date.parse(pts[0].t), t1 = Date.parse(pts[pts.length - 1].t);
  const x = (t: string) => ((Date.parse(t) - t0) / Math.max(t1 - t0, 1)) * W;
  const y = (v: number) => base - ((v - lo) / (hi - lo)) * (base - top);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.nivel_cm!).toFixed(1)}`).join("");
  const f = foco !== null ? pts[foco] : null;
  return (
    <div className="grafico">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" onMouseLeave={() => setFoco(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          pts.forEach((p, i) => { if (Math.abs(x(p.t) - px) < Math.abs(x(pts[best].t) - px)) best = i; });
          setFoco(best);
        }}>
        <line x1={0} x2={W} y1={base} y2={base} className="eixo" />
        <text x={0} y={9} className="rot-eixo">{hi.toFixed(0)} cm</text>
        <text x={0} y={base - 2} className="rot-eixo">{lo.toFixed(0)} cm</text>
        <path d={d} fill="none" stroke="#58a6ff" strokeWidth={2} strokeLinejoin="round" />
        {f && <g><line x1={x(f.t)} x2={x(f.t)} y1={top} y2={base} className="cruz" />
          <circle cx={x(f.t)} cy={y(f.nivel_cm!)} r={4} fill="#58a6ff" stroke="#111a2e" strokeWidth={2} /></g>}
        <text x={0} y={H - 3} className="rot-eixo">{hora(pts[0].t)}</text>
        <text x={W} y={H - 3} textAnchor="end" className="rot-eixo">{hora(pts[pts.length - 1].t)}</text>
      </svg>
      <div className="dica">{f ? `${hora(f.t)} · nível ${f.nivel_cm} cm · chuva ${mm(f.chuva_mm)}` : "Passe o mouse sobre a linha."}</div>
    </div>
  );
}

function StatusFontes({ m }: { m: Monitoramento }) {
  return (<table className="props"><tbody>
    {Object.entries(m.fontes).map(([k, f]) => {
      const a = f.situacao === "ok" ? atualidade(f.ultima_coleta_ok) : "desatualizado";
      return (<tr key={k}><td>{f.nome.split(" — ")[0]}<br /><span className="tag">{f.tipo === "previsao" ? "PREVISÃO" : "OBSERVADO"}</span></td>
        <td><Selo a={a} /><br />{f.situacao === "ok" ? "Conectada" : "Indisponível — exibindo últimos dados"}<br />
          <span className="muted">Coleta ok: {hora(f.ultima_coleta_ok)} ({idade(f.ultima_coleta_ok)})</span></td></tr>);
    })}
  </tbody></table>);
}

export interface Momento {
  tempo: number; agora: number; tempoA: number | null;
  nivelEm: (codigo: string, t: number) => PontoSerie | null;
}

/** Valores no momento da linha do tempo e comparação com o momento A (seção 11). */
function ValoresNoMomento({ ana, mo }: { ana: EstacaoAna[]; mo: Momento }) {
  if (mo.tempo > mo.agora) return <p className="muted">Momento futuro: não há dado observado. Veja a previsão abaixo.</p>;
  const linhas = ana.map((e) => {
    const p = mo.nivelEm(e.codigo, mo.tempo);
    const a = mo.tempoA !== null ? mo.nivelEm(e.codigo, mo.tempoA) : null;
    const delta = p?.nivel_cm != null && a?.nivel_cm != null ? p.nivel_cm - a.nivel_cm : null;
    return { e, p, delta };
  }).filter((l) => l.p);
  if (mo.tempoA !== null) linhas.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0));
  else linhas.sort((x, y) => (y.p!.chuva_mm ?? -1) - (x.p!.chuva_mm ?? -1));
  return (<>
    <table className="props"><tbody>
      <tr><td>Estação</td><td>Chuva na hora</td><td>{mo.tempoA !== null ? "Δ nível desde A" : "Nível"}</td></tr>
      {linhas.slice(0, 8).map(({ e, p, delta }) => (<tr key={e.codigo}>
        <td>{e.nome}<br /><span className="muted">{e.rio ?? ""}</span></td>
        <td>{mm(p!.chuva_mm)}</td>
        <td>{mo.tempoA !== null ? (delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(0)} cm`) : `${p!.nivel_cm ?? "—"} cm`}</td>
      </tr>))}
    </tbody></table>
    <p className="muted">{linhas.length} estações com dado nesta hora. {mo.tempoA !== null
      ? `Comparação com A = ${hora(new Date(mo.tempoA).toISOString())}, ordenado pela maior variação.`
      : "Ordenado pela maior chuva na hora."}</p>
  </>);
}

export function PainelMonitoramento({ m, sel, nomes, estacao, momento }: {
  m: Monitoramento | null; sel: number | null; nomes: Record<number, string>; estacao: EstacaoAna | null;
  momento: Momento | null;
}) {
  if (!m) return <p className="muted">Dados de monitoramento ainda não gerados.
    Rode <code>backend/scripts/collect_monitoring.py</code>.</p>;
  const cem = (m.fontes.cemaden.dados?.estacoes ?? []).filter((e) => sel === null || e.codigo_ibge === sel);
  const prev = m.fontes.previsao.dados?.municipios ?? [];
  const ana = (m.fontes.ana.dados?.estacoes ?? []);
  const anaSel = sel === null ? ana : ana.filter((e) => e.codigo_ibge === sel);
  const somaPrev = (h: PrevisaoHora[], n: number) => h.slice(0, n).reduce((s, x) => s + (x.chuva_mm ?? 0), 0);
  const prevSel = sel !== null ? prev.find((p) => p.codigo_ibge === sel) : null;
  const contagem = { recente: 0, atrasado: 0, desatualizado: 0 } as Record<Atualidade, number>;
  ana.forEach((e) => contagem[atualidade(e.ultima_leitura)]++);

  return (<>
    <h2>Situação das integrações</h2>
    <StatusFontes m={m} />

    {momento && (<>
      <h2 style={{ marginTop: 16 }}>No momento selecionado</h2>
      <ValoresNoMomento ana={(m.fontes.ana.dados?.estacoes ?? []).filter((e) => sel === null || e.codigo_ibge === sel)} mo={momento} />
    </>)}

    {estacao && (<>
      <h2 style={{ marginTop: 16 }}>Estação ANA {estacao.codigo}</h2>
      <p className="muted"><b style={{ color: "#e5e9f0" }}>{estacao.nome}</b><br />
        {estacao.rio ?? "rio não informado"} · {estacao.municipio_uf}<br />{estacao.operadora}</p>
      <table className="props"><tbody>
        <tr><td>Última leitura</td><td>{hora(estacao.ultima_leitura)} <Selo a={atualidade(estacao.ultima_leitura)} /></td></tr>
        <tr><td>Nível (bruto)</td><td>{estacao.nivel_atual_cm ?? "—"} cm</td></tr>
        <tr><td>Variação 6 h</td><td>{estacao.variacao_6h_cm ?? "—"} cm</td></tr>
        <tr><td>Chuva 24 h</td><td>{mm(estacao.chuva_24h_mm)}</td></tr>
      </tbody></table>
      <h3>Nível — últimas 48 h</h3>
      <LinhaNivel serie={estacao.serie_horaria ?? []} />
      <p className="muted">Nível conforme a ANA, na referência própria de cada estação (em barragens costuma ser a
        cota do reservatório). Não compare estações entre si. Cotas de alerta não cadastradas.</p>
      {estacao.erro && <p className="muted">Erro na coleta: {estacao.erro}</p>}
    </>)}

    <h2 style={{ marginTop: 16 }}>Chuva observada — CEMADEN <span className="tag">OBSERVADO</span></h2>
    {cem.length ? (<table className="props"><tbody>
      <tr><td>Pluviômetro</td><td>1 h</td><td>24 h</td><td>72 h</td></tr>
      {cem.map((e) => (<tr key={e.id}>
        <td>{nomes[e.codigo_ibge]}<br /><span className="muted">{e.nome}</span><br /><Selo a={atualidade(e.ultima_leitura)} /></td>
        <td>{mm(e.acumulado_mm["1hr"])}</td><td>{mm(e.acumulado_mm["24hr"])}</td><td>{mm(e.acumulado_mm["72hr"])}</td></tr>))}
    </tbody></table>) : <p className="muted">Nenhum pluviômetro CEMADEN neste município.</p>}
    <p className="muted">"—" = a fonte não informou valor no período (não é zero).</p>

    <h2 style={{ marginTop: 16 }}>Previsão de chuva <span className="tag">PREVISÃO</span></h2>
    {prevSel ? (<>
      <BarrasChuva horas={prevSel.horaria} tempo={momento?.tempo ?? null} />
      <p className="muted">Próximas 24 h: {somaPrev(prevSel.horaria, 24).toFixed(1)} mm · 72 h: {somaPrev(prevSel.horaria, 72).toFixed(1)} mm</p>
    </>) : (<table className="props"><tbody>
      <tr><td>Município</td><td>24 h</td><td>72 h</td></tr>
      {prev.map((p) => (<tr key={p.codigo_ibge}><td>{nomes[p.codigo_ibge]}</td>
        <td>{somaPrev(p.horaria, 24).toFixed(1)} mm</td><td>{somaPrev(p.horaria, 72).toFixed(1)} mm</td></tr>))}
    </tbody></table>)}
    <p className="muted">Modelo numérico (Open-Meteo), não é previsão oficial. Consulte INMET e Defesa Civil.</p>

    <h2 style={{ marginTop: 16 }}>Estações ANA {sel === null ? "na região" : "no município"}</h2>
    <p className="muted">{anaSel.length} estações{sel === null && <> · {(Object.keys(contagem) as Atualidade[]).map((k) =>
      <span key={k} style={{ marginRight: 6 }}><span style={{ color: ATUALIDADE[k].cor }}>{ATUALIDADE[k].icone}</span> {contagem[k]}</span>)}</>}.
      Clique numa estação no mapa para ver a série.</p>
    <p className="muted">Dados gerados em {hora(m.gerado_em)} ({idade(m.gerado_em)}).</p>
  </>);
}
