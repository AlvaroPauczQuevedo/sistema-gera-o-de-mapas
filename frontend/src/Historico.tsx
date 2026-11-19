import { Fragment, useEffect, useMemo, useState } from "react";
import { lerExecucoes, type EventoResumo } from "./Simulacao";
import { baixarArquivo } from "./Vistorias";

/* Modo 4 — Análise histórica (seções 17 e 28): registros oficiais de desastres (Atlas Digital / S2iD)
 * e cheias medidas pela ANA, com comparação entre o que a simulação estima e o que foi registrado. */

interface Desastre {
  protocolo: string; codigo_ibge: number; municipio: string; data: string; cobrade: string; tipologia: string; status: string;
  mortos: number; feridos: number; desabrigados: number; desalojados: number; desaparecidos: number; outros_afetados: number;
  habitacoes_danificadas: number; habitacoes_destruidas: number; obras_infra_danificadas: number; obras_infra_destruidas: number;
  danos_materiais_rs: number; prejuizo_publico_rs: number; prejuizo_privado_rs: number;
  danos_humanos: string; danos_materiais: string; prejuizos_publicos: string;
}
interface Atlas { eventos: Desastre[]; fonte: { nome: string; url: string; obtido_em: string; observacao: string } }

// Categorias fixas (a cor segue a categoria, nunca a posição). Paleta categórica de referência, passos para tema escuro.
const CATEGORIAS = [
  { id: "chuva", rotulo: "Chuvas intensas", cor: "#3987e5", tipos: ["Chuvas Intensas"] },
  { id: "enxurrada", rotulo: "Enxurradas", cor: "#d95926", tipos: ["Enxurradas"] },
  { id: "inundacao", rotulo: "Inundações e alagamentos", cor: "#199e70", tipos: ["Inundações", "Alagamentos"] },
  { id: "estiagem", rotulo: "Estiagem e seca", cor: "#c98500", tipos: ["Estiagem e Seca"] },
  { id: "vento", rotulo: "Vendavais, granizo e tornados", cor: "#d55181", tipos: ["Vendavais e Ciclones", "Granizo", "Tornado"] },
  { id: "outros", rotulo: "Outros", cor: "#6e7681", tipos: [] as string[] },
];
const categoria = (t: string) => CATEGORIAS.find((c) => c.tipos.includes(t)) ?? CATEGORIAS[CATEGORIAS.length - 1];
const n = (v: number, d = 0) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const reais = (v: number) => v ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }) : "—";
const dataBr = (iso: string) => iso.split("-").reverse().join("/");

function GraficoAnual({ eventos }: { eventos: Desastre[] }) {
  const [foco, setFoco] = useState<{ ano: number; cat: string; qtd: number; x: number; y: number } | null>(null);
  const anos = useMemo(() => {
    const min = Math.min(1991, ...eventos.map((e) => +e.data.slice(0, 4))), max = Math.max(2025, ...eventos.map((e) => +e.data.slice(0, 4)));
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }, [eventos]);
  const cont = (ano: number, cat: string) => eventos.filter((e) => +e.data.slice(0, 4) === ano && categoria(e.tipologia).id === cat).length;
  const tot = (ano: number) => eventos.filter((e) => +e.data.slice(0, 4) === ano).length;
  const max = Math.max(1, ...anos.map(tot));
  const W = 900, H = 200, base = H - 22, top = 10, bw = W / anos.length;
  const y = (v: number) => base - (v / max) * (base - top);
  const passos = Array.from({ length: max + 1 }, (_, i) => i).filter((v) => v === 0 || v === max || (max > 4 && v === Math.round(max / 2)));
  return (
    <div className="grafico-hist">
      <div className="legenda-linha">{CATEGORIAS.map((c) => (
        <span key={c.id}><span className="swatch" style={{ background: c.cor }} />{c.rotulo}</span>))}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" onMouseLeave={() => setFoco(null)}>
        {passos.map((v) => (<g key={v}><line x1={0} x2={W} y1={y(v)} y2={y(v)} className="grade" />
          <text x={2} y={y(v) - 2} className="rot-eixo">{v}</text></g>))}
        {anos.map((a, i) => {
          let acc = 0;
          return (<g key={a}>
            {CATEGORIAS.map((c) => {
              const q = cont(a, c.id);
              if (!q) return null;
              const y0 = y(acc), y1 = y(acc + q);
              acc += q;
              return <rect key={c.id} x={i * bw + 2} y={y1 + 1} width={Math.max(bw - 4, 2)} height={Math.max(y0 - y1 - 2, 1)}
                rx={2} fill={c.cor} opacity={foco && (foco.ano !== a || foco.cat !== c.rotulo) ? 0.55 : 1}
                onMouseEnter={() => setFoco({ ano: a, cat: c.rotulo, qtd: q, x: i * bw, y: y1 })} />;
            })}
            {(a % 5 === 0) && <text x={i * bw + bw / 2} y={H - 6} textAnchor="middle" className="rot-eixo">{a}</text>}
          </g>);
        })}
        <line x1={0} x2={W} y1={base} y2={base} className="eixo" />
      </svg>
      <div className="dica">{foco ? `${foco.ano} · ${foco.cat}: ${foco.qtd} registro(s)` : "Registros oficiais por ano (passe o mouse sobre as barras)."}</div>
    </div>
  );
}

export function AnaliseHistorica({ munis, eventosAna, onSimular }: {
  munis: { codigo_ibge: number; nome: string }[]; eventosAna: EventoResumo[]; onSimular: (idEvento: string) => void;
}) {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [mun, setMun] = useState<number | "todos">("todos");
  const [cat, setCat] = useState<string>("todas");
  const [desde, setDesde] = useState(1991);
  const [aberto, setAberto] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/eventos/desastres_atlas.json`).then((r) => r.json()).then(setAtlas).catch(() => setAtlas(null));
  }, []);
  const filtrados = useMemo(() => (atlas?.eventos ?? []).filter((e) => (mun === "todos" || e.codigo_ibge === mun)
    && (cat === "todas" || categoria(e.tipologia).id === cat) && +e.data.slice(0, 4) >= desde).reverse(), [atlas, mun, cat, desde]);
  const soma = (k: keyof Desastre) => filtrados.reduce((s, e) => s + (e[k] as number), 0);
  const execucoes = lerExecucoes();

  // Calibração: para cada cheia medida pela ANA, os registros oficiais de até 3 dias depois do início e antes do fim.
  const calibracao = eventosAna.map((ev) => {
    const [ini, fim] = [ev.pico_em.slice(0, 10), ev.pico_em.slice(0, 10)];
    const tPico = Date.parse(ev.pico_em);
    const regs = (atlas?.eventos ?? []).filter((d) => Math.abs(Date.parse(d.data) - tPico) <= 6 * 86400000 && categoria(d.tipologia).id !== "estiagem");
    const sim = execucoes.find((x) => x.cenario.tipo === "historico" && x.cenario.evento === ev.id);
    return { ev, ini, fim, regs, sim };
  });

  const exportar = () => {
    const cols: (keyof Desastre)[] = ["data", "municipio", "tipologia", "cobrade", "status", "mortos", "feridos", "desabrigados", "desalojados",
      "desaparecidos", "habitacoes_danificadas", "habitacoes_destruidas", "obras_infra_danificadas", "obras_infra_destruidas",
      "danos_materiais_rs", "prejuizo_publico_rs", "prejuizo_privado_rs", "protocolo"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    baixarArquivo(`historico-desastres-${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + [cols.join(";"),
      ...filtrados.map((e) => cols.map((c) => esc(e[c])).join(";"))].join("\n") + `\n\nFonte;${atlas?.fonte.nome}\n`, "text/csv");
  };

  if (!atlas) return <div className="painel"><p className="muted">Base histórica não encontrada. Rode <code>backend/scripts/fetch_atlas_desastres.py</code>.</p></div>;
  return (<div className="painel">
    <div className="painel-cab">
      <div><h1>Análise histórica</h1>
        <p className="muted">{atlas.fonte.nome}. {atlas.fonte.observacao} Cheias medidas: ANA (telemetria).</p></div>
      <div className="linha"><button onClick={exportar}>Exportar registros (CSV)</button><button onClick={() => window.print()}>Imprimir / PDF</button></div>
    </div>

    <div className="filtros">
      <label>Município <select value={mun} onChange={(e) => setMun(e.target.value === "todos" ? "todos" : +e.target.value)}>
        <option value="todos">Todos</option>{munis.map((m) => <option key={m.codigo_ibge} value={m.codigo_ibge}>{m.nome}</option>)}</select></label>
      <label>Tipo <select value={cat} onChange={(e) => setCat(e.target.value)}>
        <option value="todas">Todos</option>{CATEGORIAS.map((c) => <option key={c.id} value={c.id}>{c.rotulo}</option>)}</select></label>
      <label>Desde <select value={desde} onChange={(e) => setDesde(+e.target.value)}>
        {[1991, 2000, 2010, 2013, 2020, 2023].map((a) => <option key={a}>{a}</option>)}</select></label>
    </div>

    <div className="tiles">
      <div className="tile"><div className="tile-valor">{n(filtrados.length)}</div><div className="tile-rot">registros oficiais</div></div>
      <div className="tile"><div className="tile-valor">{n(soma("mortos"))}</div><div className="tile-rot">mortos</div></div>
      <div className="tile"><div className="tile-valor">{n(soma("desabrigados"))}</div><div className="tile-rot">desabrigados</div></div>
      <div className="tile"><div className="tile-valor">{n(soma("desalojados"))}</div><div className="tile-rot">desalojados</div></div>
      <div className="tile"><div className="tile-valor">{n(soma("habitacoes_danificadas") + soma("habitacoes_destruidas"))}</div>
        <div className="tile-rot">habitações danificadas ou destruídas</div></div>
      <div className="tile"><div className="tile-valor">{reais(soma("danos_materiais_rs") + soma("prejuizo_publico_rs") + soma("prejuizo_privado_rs"))}</div>
        <div className="tile-rot">danos e prejuízos declarados</div><div className="tile-nota">valores nominais, como registrados</div></div>
    </div>

    <h2>Registros por ano</h2>
    <GraficoAnual eventos={filtrados} />

    <h2>Simulação × realidade (calibração)</h2>
    <div className="tabela-rolagem"><table className="comparacao"><thead><tr>
      <th>Cheia medida (ANA)</th><th>Subida máx.</th><th>Chuva no período</th><th>Registros oficiais ±6 dias do pico</th>
      <th>Simulado (última execução)</th><th></th></tr></thead><tbody>
      {calibracao.map(({ ev, regs, sim }) => (<tr key={ev.id}>
        <td><b>{ev.nome}</b><br /><span className="muted">pico {new Date(ev.pico_em).toLocaleString("pt-BR")}</span></td>
        <td>{n(ev.subida_max_m, 1)} m{ev.lacunas_maiores_2h.length ? " *" : ""}</td>
        <td>{n(ev.chuva_total_mm, 0)} mm</td>
        <td style={{ whiteSpace: "normal", minWidth: 260 }}>{regs.length ? regs.map((r) => (
          <div key={r.protocolo}>{r.municipio}: {r.tipologia} — {n(r.desabrigados)} desabrig., {n(r.desalojados)} desaloj.
            {r.mortos ? `, ${n(r.mortos)} mortos` : ""}{r.habitacoes_destruidas ? `, ${n(r.habitacoes_destruidas)} hab. destruídas` : ""}</div>))
          : <span className="muted">nenhum registro</span>}</td>
        <td>{sim ? <>{n(sim.area_km2, 2)} km² inundados · {sim.edificacoes} edif. · {sim.pontes} pontes</> : <span className="muted">ainda não simulado</span>}</td>
        <td><button onClick={() => onSimular(ev.id)}>Simular este evento</button></td>
      </tr>))}
    </tbody></table></div>
    <p className="muted">Use esta tabela para calibrar o fator de correção da inundação e o limiar de deslizamentos: o simulado
      deve ser coerente com o que foi oficialmente registrado. Os registros oficiais são municipais (sem localização exata) e
      somam todas as causas do evento. * série com lacuna, pico real pode ter sido maior.</p>

    <h2>Registros ({filtrados.length})</h2>
    <div className="tabela-rolagem"><table className="comparacao"><thead><tr>
      <th>Data</th><th>Município</th><th>Tipo</th><th>Mortos</th><th>Desabrig.</th><th>Desaloj.</th><th>Habitações dan./destr.</th>
      <th>Danos e prejuízos</th><th>Situação</th></tr></thead><tbody>
      {filtrados.map((e) => (<Fragment key={e.protocolo}>
        <tr className="clicavel" onClick={() => setAberto(aberto === e.protocolo ? null : e.protocolo)}>
          <td>{dataBr(e.data)}</td><td>{e.municipio}</td>
          <td><span className="swatch" style={{ background: categoria(e.tipologia).cor }} /> {e.tipologia}</td>
          <td>{n(e.mortos)}</td><td>{n(e.desabrigados)}</td><td>{n(e.desalojados)}</td>
          <td>{n(e.habitacoes_danificadas)} / {n(e.habitacoes_destruidas)}</td>
          <td>{reais(e.danos_materiais_rs + e.prejuizo_publico_rs + e.prejuizo_privado_rs)}</td>
          <td className="muted">{e.status}</td>
        </tr>
        {aberto === e.protocolo && <tr><td colSpan={9} className="detalhe">
          <b>Protocolo S2iD:</b> {e.protocolo} · COBRADE {e.cobrade}<br />
          {e.danos_humanos && <><b>Danos humanos:</b> {e.danos_humanos}<br /></>}
          {e.danos_materiais && <><b>Danos materiais:</b> {e.danos_materiais}<br /></>}
          {e.prejuizos_publicos && <><b>Prejuízos públicos:</b> {e.prejuizos_publicos}</>}
        </td></tr>}
      </Fragment>))}
    </tbody></table></div>
  </div>);
}
