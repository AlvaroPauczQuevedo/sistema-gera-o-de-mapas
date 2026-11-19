import { useEffect, useMemo, useState } from "react";
import { baixarArquivo } from "./Vistorias";

/* ===================================================================================
 * Modo 3 — Simulação de inundação por ESTIMATIVA (modelo HAND simplificado).
 * A física fica nos dados (HAND calculado em backend/scripts/build_hand.py); aqui só se
 * aplica a subida do rio ao longo do tempo e se cruzam os resultados com o território.
 * =================================================================================== */

export interface RioHand {
  id: string; nome: string; arquivo: string; largura: number; altura: number;
  retangulo: { oeste: number; norte: number; leste: number; sul: number }; celula_m: [number, number];
}
interface HandMeta { rios: RioHand[]; passo_m: number; hand_max_m: number; metodo: string; gerado_em: string; fonte_relevo: string }
export interface EventoResumo {
  id: string; nome: string; rio: string; estacao: string; estacao_nome: string; nivel_base_cm: number;
  pico_cm: number; pico_em: string; subida_max_m: number; chuva_total_mm: number; lacunas_maiores_2h: [string, string][];
  arquivo: string; fonte: string;
}
interface PontoEvento { t: string; nivel_cm: number; chuva_mm: number | null }

export interface Cenario {
  tipo: "historico" | "hipotetico"; rio: string; evento?: string;
  pico_m: number; subida_h: number; descida_h: number; // hipotético: hidrograma triangular
  fator: number; // correção local da subida (calibrar com marcas de cheia / profissionais)
  chuva_total_mm: number; // hipotético: chuva distribuída antes do pico
  limiar_mm: number; // chuva acumulada que ativa setores de encosta de risco MUITO ALTO (alto: × 1,3)
}
export const CENARIO_PADRAO: Cenario = { tipo: "historico", rio: "rio_das_antas", evento: "antas-2023-09",
  pico_m: 15, subida_h: 24, descida_h: 48, fator: 1, chuva_total_mm: 150, limiar_mm: 100 };

/** Classes de profundidade (m) — azul claro a escuro. */
export const PROFUNDIDADE = [
  { ate: 0.5, cor: [190, 220, 255], rotulo: "< 0,5 m" },
  { ate: 1, cor: [130, 185, 250], rotulo: "0,5–1 m" },
  { ate: 2, cor: [70, 140, 235], rotulo: "1–2 m" },
  { ate: 5, cor: [30, 95, 200], rotulo: "2–5 m" },
  { ate: Infinity, cor: [10, 45, 130], rotulo: "> 5 m" },
] as const;
const LEITO_M = 0.5; // HAND abaixo disso = leito/reservatório (água em condição normal)

export interface RioCarregado { meta: RioHand; hand: Uint8Array; passo: number }

export function useModeloHand(dataUrl: (p: string) => string) {
  const [meta, setMeta] = useState<HandMeta | null>(null);
  const [rios, setRios] = useState<Record<string, RioCarregado>>({});
  const [eventos, setEventos] = useState<EventoResumo[]>([]);
  useEffect(() => {
    fetch(dataUrl("simulacao/hand.json")).then((r) => r.json()).then(async (m: HandMeta) => {
      setMeta(m);
      const out: Record<string, RioCarregado> = {};
      for (const r of m.rios) {
        const img = new Image();
        img.src = dataUrl(`simulacao/${r.arquivo}`);
        await img.decode();
        const c = Object.assign(document.createElement("canvas"), { width: r.largura, height: r.altura });
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, r.largura, r.altura).data;
        const hand = new Uint8Array(r.largura * r.altura);
        for (let i = 0; i < hand.length; i++) hand[i] = px[i * 4];
        out[r.id] = { meta: r, hand, passo: m.passo_m };
      }
      setRios(out);
    }).catch(() => setMeta(null));
    fetch(dataUrl("eventos/eventos.json")).then((r) => r.json()).then((e) => setEventos(e.eventos)).catch(() => setEventos([]));
  }, []);
  return { meta, rios, eventos };
}

/** HAND (m) no ponto, ou null se fora da área de influência do rio. */
export function handEm(rio: RioCarregado, lon: number, lat: number): number | null {
  const { oeste, norte, leste, sul } = rio.meta.retangulo;
  if (lon < oeste || lon >= leste || lat > norte || lat <= sul) return null;
  const c = Math.floor(((lon - oeste) / (leste - oeste)) * rio.meta.largura);
  const l = Math.floor(((norte - lat) / (norte - sul)) * rio.meta.altura);
  const v = rio.hand[l * rio.meta.largura + c];
  return v === 255 ? null : v * rio.passo;
}

export interface PassoHg { t: number; h: number; chuva: number } // chuva = mm no passo

/** Série temporal da subida (m) e da chuva (mm) do cenário. */
export function hidrograma(c: Cenario, serieEvento: PontoEvento[] | null, base_cm: number | null): PassoHg[] {
  if (c.tipo === "historico" && serieEvento && base_cm !== null)
    return serieEvento.map((p) => ({ t: Date.parse(p.t), h: Math.max(0, ((p.nivel_cm - base_cm) / 100) * c.fator), chuva: p.chuva_mm ?? 0 }));
  // Hipotético: começa na hora atual.
  const t0 = Math.floor(Date.now() / 3.6e6) * 3.6e6, passo = 15 * 60 * 1000, n = Math.ceil(((c.subida_h + c.descida_h) * 3.6e6) / passo);
  // Chuva hipotética: uniforme nos primeiros 80% do tempo até o pico.
  const passosChuva = Math.max(1, Math.round((c.subida_h * 0.8 * 3.6e6) / passo));
  return Array.from({ length: n + 1 }, (_, i) => {
    const horas = (i * passo) / 3.6e6;
    const h = horas <= c.subida_h ? (horas / c.subida_h) * c.pico_m : Math.max(0, c.pico_m * (1 - (horas - c.subida_h) / c.descida_h));
    return { t: t0 + i * passo, h: h * c.fator, chuva: i < passosChuva ? c.chuva_total_mm / passosChuva : 0 };
  });
}
/** Índice do passo vigente em t. */
export function passoEm(hg: PassoHg[], t: number) {
  let i = 0;
  while (i + 1 < hg.length && hg[i + 1].t <= t) i++;
  return i;
}
/** Chuva em mm/h no instante t e acumulados (total e últimas 6 h). */
export function chuvaEm(hg: PassoHg[], t: number) {
  if (!hg.length) return { mmh: 0, acumulado: 0, ultimas6h: 0 };
  const i = passoEm(hg, t);
  const dur = i + 1 < hg.length ? hg[i + 1].t - hg[i].t : 9e5;
  let acumulado = 0, ultimas6h = 0;
  for (let k = 0; k <= i; k++) { acumulado += hg[k].chuva; if (hg[k].t > t - 6 * 3.6e6) ultimas6h += hg[k].chuva; }
  return { mmh: (hg[i].chuva * 3.6e6) / dur, acumulado, ultimas6h };
}
export function subidaEm(hg: { t: number; h: number }[], t: number) {
  if (!hg.length) return 0;
  let i = 0;
  while (i + 1 < hg.length && hg[i + 1].t <= t) i++;
  return hg[i].h;
}

/** Desenha a lâmina d'água para a subida h (m) num canvas do tamanho do raster do rio. */
export function desenharLamina(rio: RioCarregado, h: number, canvas: HTMLCanvasElement) {
  const { largura: w, altura: a } = rio.meta;
  canvas.width = w; canvas.height = a;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, a);
  const lim = Math.round(h / rio.passo);
  for (let i = 0; i < rio.hand.length; i++) {
    const v = rio.hand[i];
    if (v === 255 || v >= lim) continue;
    const prof = h - v * rio.passo;
    const k = PROFUNDIDADE.find((p) => prof < p.ate)!;
    const o = i * 4;
    img.data[o] = k.cor[0]; img.data[o + 1] = k.cor[1]; img.data[o + 2] = k.cor[2];
    img.data[o + 3] = v * rio.passo < LEITO_M ? 110 : 210; // leito normal mais transparente
  }
  ctx.putImageData(img, 0, 0);
}

export function areaInundadaKm2(rio: RioCarregado, h: number) {
  const lim = Math.round(h / rio.passo), leito = Math.round(LEITO_M / rio.passo);
  let n = 0;
  for (const v of rio.hand) if (v !== 255 && v < lim && v >= leito) n++;
  return (n * rio.meta.celula_m[0] * rio.meta.celula_m[1]) / 1e6;
}

// ------------------------------------------------------------------ Impactos (seção 13)
type Pt = [number, number];
export interface Feicao { tipo: "edificacao" | "via" | "instituicao"; municipio: number; nome?: string; categoria?: string;
  ponte?: boolean; pontos: Pt[]; comprimento_m?: number }
export interface Impacto {
  pico_m: number; area_km2: number;
  edificacoes: { municipio: number; prof_max: number; lon: number; lat: number }[];
  vias_km: Record<number, number>; pontes: { municipio: number; nome?: string; lon: number; lat: number }[];
  instituicoes: { municipio: number; nome?: string; categoria?: string; prof: number; lon: number; lat: number }[];
}

export function calcularImpacto(rio: RioCarregado, h: number, feicoes: Feicao[]): Impacto {
  const imp: Impacto = { pico_m: h, area_km2: areaInundadaKm2(rio, h), edificacoes: [], vias_km: {}, pontes: [], instituicoes: [] };
  const prof = (lon: number, lat: number) => { const v = handEm(rio, lon, lat); return v === null || v >= h ? null : h - v; };
  for (const f of feicoes) {
    if (f.tipo === "edificacao") {
      const p = prof(...f.pontos[0]);
      if (p !== null) imp.edificacoes.push({ municipio: f.municipio, prof_max: p, lon: f.pontos[0][0], lat: f.pontos[0][1] });
    } else if (f.tipo === "instituicao") {
      const p = prof(...f.pontos[0]);
      if (p !== null) imp.instituicoes.push({ municipio: f.municipio, nome: f.nome, categoria: f.categoria, prof: p, lon: f.pontos[0][0], lat: f.pontos[0][1] });
    } else {
      let atingida = 0, algum: Pt | null = null;
      for (let i = 1; i < f.pontos.length; i++) {
        const a = f.pontos[i - 1], b = f.pontos[i];
        if (prof(...a) !== null && prof(...b) !== null) {
          atingida += Math.hypot((b[0] - a[0]) * 97000, (b[1] - a[1]) * 110600);
          algum = algum ?? a;
        }
      }
      if (atingida) imp.vias_km[f.municipio] = (imp.vias_km[f.municipio] ?? 0) + atingida / 1000;
      if (algum && f.ponte) imp.pontes.push({ municipio: f.municipio, nome: f.nome, lon: algum[0], lat: algum[1] });
    }
  }
  return imp;
}

/** Carrega edificações, vias e instituições de todos os municípios como feições simples. */
export function useFeicoes(munis: { codigo_ibge: number }[], dataUrl: (p: string) => string) {
  const [feicoes, setFeicoes] = useState<Feicao[] | null>(null);
  useEffect(() => {
    if (!munis.length) return;
    (async () => {
      const out: Feicao[] = [];
      for (const m of munis) {
        const ler = (c: string) => fetch(dataUrl(`${m.codigo_ibge}/${c}.geojson`)).then((r) => (r.ok ? r.json() : { features: [] })).catch(() => ({ features: [] }));
        const [ed, vias, inst] = await Promise.all([ler("edificacoes"), ler("vias"), ler("instituicoes")]);
        for (const f of ed.features) {
          const anel: Pt[] = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates;
          const c: Pt = [anel.reduce((s, p) => s + p[0], 0) / anel.length, anel.reduce((s, p) => s + p[1], 0) / anel.length];
          out.push({ tipo: "edificacao", municipio: m.codigo_ibge, pontos: [c] });
        }
        for (const f of vias.features) out.push({ tipo: "via", municipio: m.codigo_ibge, nome: f.properties.name,
          ponte: f.properties.bridge === "yes", pontos: f.geometry.coordinates });
        for (const f of inst.features) out.push({ tipo: "instituicao", municipio: m.codigo_ibge, nome: f.properties.name,
          categoria: f.properties.tipo, pontos: [f.geometry.coordinates] });
      }
      setFeicoes(out);
    })();
  }, [munis]);
  return feicoes;
}

// ------------------------------------------------------------------ Movimentos de massa (setores SGB)
export interface Setor { id: string; municipio: number; lon: number; lat: number; grau: string; tipologia: string;
  tipo: "encosta" | "margem"; pessoas: number; edificacoes: number; local: string }
export interface Ativacao { setor: Setor; t: number; motivo: string }

export function useSetores(munis: { codigo_ibge: number }[], dataUrl: (p: string) => string) {
  const [setores, setSetores] = useState<Setor[]>([]);
  useEffect(() => {
    if (!munis.length) return;
    Promise.all(munis.map((m) => fetch(dataUrl(`${m.codigo_ibge}/areas_risco.geojson`)).then((r) => (r.ok ? r.json() : { features: [] }))
      .catch(() => ({ features: [] })).then((g) => (g.features as { geometry: { coordinates: number[][][] }; properties: Record<string, string | null> }[])
        .map((f, i): Setor => {
          const anel = f.geometry.coordinates[0];
          const p = f.properties;
          const tip = [p.tipolo_e1, p.tipolo_e2].filter(Boolean).join(", ") || "não informada";
          return { id: `${m.codigo_ibge}-${p.num_setor ?? i}`, municipio: m.codigo_ibge,
            lon: anel.reduce((s, q) => s + q[0], 0) / anel.length, lat: anel.reduce((s, q) => s + q[1], 0) / anel.length,
            grau: p.grau_risco ?? "", tipologia: tip, tipo: /margem/i.test(tip) && !/desliza|queda|rastejo|corrida/i.test(tip) ? "margem" : "encosta",
            pessoas: parseInt(p.num_pess ?? "0") || 0, edificacoes: parseInt(p.num_edif ?? "0") || 0, local: p.local ?? "" };
        }))))
      .then((xs) => setSetores(xs.flat()));
  }, [munis]);
  return setores;
}

/** Quando cada setor seria ativado no cenário (estimativa por limiares, não modelo geotécnico). */
export function calcularAtivacoes(setores: Setor[], hg: PassoHg[], c: Cenario, rio: RioCarregado | undefined): Ativacao[] {
  const out: Ativacao[] = [];
  let acum = 0;
  const acumulados = hg.map((p) => (acum += p.chuva));
  for (const s of setores) {
    if (s.tipo === "margem") {
      const hand = rio ? handEm(rio, s.lon, s.lat) : null;
      if (hand === null) continue;
      const i = hg.findIndex((p) => p.h >= hand);
      if (i >= 0) out.push({ setor: s, t: hg[i].t, motivo: `rio subiu ${hand.toFixed(1)} m até o setor (erosão de margem)` });
    } else {
      const lim = c.limiar_mm * (s.grau.startsWith("Muito") ? 1 : 1.3);
      const i = acumulados.findIndex((a) => a >= lim);
      if (i >= 0) out.push({ setor: s, t: hg[i].t, motivo: `chuva acumulada ≥ ${lim.toFixed(0)} mm` });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ Histórico de simulações executadas
export interface Execucao { id: string; em: string; cenario: Cenario; rotulo: string; pico_m: number; area_km2: number;
  edificacoes: number; vias_km: number; pontes: number; instituicoes: number }
const CHAVE_HIST = "gemeos:simulacoes";
export function lerExecucoes(): Execucao[] { try { return JSON.parse(localStorage.getItem(CHAVE_HIST) ?? "[]"); } catch { return []; } }
function gravarExecucoes(e: Execucao[]) { try { localStorage.setItem(CHAVE_HIST, JSON.stringify(e.slice(0, 100))); } catch { /* sem storage */ } }

export function rotuloCenario(c: Cenario, eventos: EventoResumo[]) {
  const ev = eventos.find((e) => e.id === c.evento);
  return c.tipo === "historico" ? `${ev?.nome ?? "evento"}${c.fator !== 1 ? ` × ${c.fator}` : ""}`
    : `Hipotético: ${c.pico_m} m em ${c.subida_h} h${c.fator !== 1 ? ` × ${c.fator}` : ""}`;
}

/** Registra uma execução (chamado uma vez por clique em "Executar simulação"). */
export function registrarExecucao(c: Cenario, eventos: EventoResumo[], imp: Impacto): Execucao {
  const e: Execucao = { id: `${Date.now()}`, em: new Date().toISOString(), cenario: c, rotulo: rotuloCenario(c, eventos),
    pico_m: imp.pico_m, area_km2: imp.area_km2, edificacoes: imp.edificacoes.length,
    vias_km: Object.values(imp.vias_km).reduce((s, v) => s + v, 0), pontes: imp.pontes.length, instituicoes: imp.instituicoes.length };
  gravarExecucoes([e, ...lerExecucoes()]);
  return e;
}

const n = (v: number, d = 0) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

// ------------------------------------------------------------------ Painel
export function PainelSimulacao({ modelo, cenario, setCenario, impacto, impactoAgora, subidaAgora, nomes, executar, executando,
  comparacao, setComparacao, ativacoes, tempo, chuvaAgora, efeitos, setEfeitos }: {
  modelo: ReturnType<typeof useModeloHand>; cenario: Cenario; setCenario: (c: Cenario) => void;
  impacto: Impacto | null; impactoAgora: { area_km2: number } | null; subidaAgora: number;
  nomes: Record<number, string>; executar: () => void; executando: boolean;
  comparacao: Execucao | null; setComparacao: (e: Execucao | null) => void;
  ativacoes: Ativacao[]; tempo: number | null; chuvaAgora: { mmh: number; acumulado: number };
  efeitos: boolean; setEfeitos: (v: boolean) => void;
}) {
  const execucoes = useMemo(lerExecucoes, [impacto]);
  const ev = modelo.eventos.find((e) => e.id === cenario.evento);
  const set = <K extends keyof Cenario>(k: K, v: Cenario[K]) => setCenario({ ...cenario, [k]: v });
  const rotulo = impacto ? execucoes[0]?.rotulo ?? rotuloCenario(cenario, modelo.eventos) : rotuloCenario(cenario, modelo.eventos);

  const porMun = useMemo(() => {
    if (!impacto) return [];
    const ms = new Set<number>([...impacto.edificacoes.map((e) => e.municipio), ...Object.keys(impacto.vias_km).map(Number),
      ...impacto.instituicoes.map((i) => i.municipio)]);
    return [...ms].map((m) => ({ m, ed: impacto.edificacoes.filter((e) => e.municipio === m).length,
      edFundo: impacto.edificacoes.filter((e) => e.municipio === m && e.prof_max >= 1).length,
      vias: impacto.vias_km[m] ?? 0, pontes: impacto.pontes.filter((p) => p.municipio === m).length,
      inst: impacto.instituicoes.filter((i) => i.municipio === m).length }));
  }, [impacto]);

  const exportar = () => {
    if (!impacto) return;
    const feats = [
      ...impacto.edificacoes.map((e) => ({ type: "Feature", geometry: { type: "Point", coordinates: [e.lon, e.lat] },
        properties: { tipo: "edificação", municipio: nomes[e.municipio], profundidade_estimada_m: +e.prof_max.toFixed(2) } })),
      ...impacto.instituicoes.map((i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [i.lon, i.lat] },
        properties: { tipo: i.categoria, nome: i.nome, municipio: nomes[i.municipio], profundidade_estimada_m: +i.prof.toFixed(2) } })),
      ...impacto.pontes.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: { tipo: "ponte", nome: p.nome, municipio: nomes[p.municipio] } })),
    ];
    baixarArquivo(`simulacao-${cenario.rio}-${new Date().toISOString().slice(0, 10)}.geojson`, JSON.stringify({
      type: "FeatureCollection", features: feats,
      simulacao: { natureza: "ESTIMATIVA — modelo HAND simplificado, sem validação profissional", cenario, rotulo,
        subida_pico_m: impacto.pico_m, area_inundada_km2: impacto.area_km2, metodo: modelo.meta?.metodo,
        fonte_relevo: modelo.meta?.fonte_relevo, gerado_em: new Date().toISOString() },
    }), "application/geo+json");
  };

  if (!modelo.meta) return <p className="muted">Modelo HAND não encontrado. Rode <code>backend/scripts/build_hand.py</code>.</p>;
  const eventosDoRio = modelo.eventos.filter((e) => e.rio === cenario.rio);

  return (<>
    <div className="faixa-estimativa">ESTIMATIVA — modelo simplificado (HAND). Não é previsão nem resultado de HEC-RAS.</div>
    <h2>Cenário</h2>
    <div className="form">
      <label>Rio</label>
      <select value={cenario.rio} onChange={(e) => setCenario({ ...cenario, rio: e.target.value,
        evento: modelo.eventos.find((x) => x.rio === e.target.value)?.id, tipo: modelo.eventos.some((x) => x.rio === e.target.value) ? cenario.tipo : "hipotetico" })}>
        {modelo.meta.rios.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}</select>
      <div className="seg" style={{ marginTop: 8 }}>
        <button className={cenario.tipo === "historico" ? "on" : ""} disabled={!eventosDoRio.length} onClick={() => set("tipo", "historico")}>Evento histórico</button>
        <button className={cenario.tipo === "hipotetico" ? "on" : ""} onClick={() => set("tipo", "hipotetico")}>Cenário hipotético</button>
      </div>
      {cenario.tipo === "historico" ? (<>
        <label>Evento observado (ANA)</label>
        <select value={cenario.evento} onChange={(e) => set("evento", e.target.value)}>
          {eventosDoRio.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}</select>
        {ev && <p className="muted">Estação {ev.estacao} — {ev.estacao_nome}. Subida máxima registrada: <b>{n(ev.subida_max_m, 2)} m</b> em{" "}
          {new Date(ev.pico_em).toLocaleString("pt-BR")}. Chuva no período: {n(ev.chuva_total_mm, 0)} mm.
          {ev.lacunas_maiores_2h.length > 0 && <> <b>Atenção:</b> a série tem {ev.lacunas_maiores_2h.length} lacuna(s) &gt; 2 h
            (provável falha do sensor na cheia) — o pico real pode ter sido maior.</>}</p>}
      </>) : (<>
        <div className="duas">
          <div><label>Subida máxima (m)</label><input type="number" min={0.5} max={40} step={0.5} value={cenario.pico_m}
            onChange={(e) => set("pico_m", +e.target.value)} /></div>
          <div><label>Tempo até o pico (h)</label><input type="number" min={1} max={240} value={cenario.subida_h}
            onChange={(e) => set("subida_h", +e.target.value)} /></div>
        </div>
        <div className="duas">
          <div><label>Tempo de recessão (h)</label>
            <input type="number" min={1} max={480} value={cenario.descida_h} onChange={(e) => set("descida_h", +e.target.value)} /></div>
          <div><label>Chuva total (mm)</label>
            <input type="number" min={0} max={1000} step={10} value={cenario.chuva_total_mm} onChange={(e) => set("chuva_total_mm", +e.target.value)} /></div>
        </div>
        {eventosDoRio.length > 0 && <p className="muted">Referência: {eventosDoRio.map((e) => `${e.nome.split(" (")[0]}: ${n(e.subida_max_m, 1)} m`).join(" · ")}.</p>}
      </>)}
      <label>Fator de correção local da subida</label>
      <input type="number" min={0.1} max={3} step={0.05} value={cenario.fator} onChange={(e) => set("fator", +e.target.value)} />
      <p className="muted">1,0 = mesma subida da régua em todo o trecho. Ajuste com marcas de cheia ou orientação técnica.</p>
      <label>Limiar de chuva para deslizamentos (mm acumulados)</label>
      <input type="number" min={10} max={1000} step={10} value={cenario.limiar_mm} onChange={(e) => set("limiar_mm", +e.target.value)} />
      <p className="muted">Ativa setores SGB de encosta: risco muito alto ao atingir o limiar; alto a 1,3 × o limiar.
        Valor inicial ilustrativo — deve ser calibrado com o histórico de deslizamentos da região.</p>
      <label className="layer"><input type="checkbox" checked={efeitos} onChange={(e) => setEfeitos(e.target.checked)} />
        Animação de nuvens, chuva e deslizamentos (ilustração)</label>
      <div className="linha" style={{ marginTop: 10 }}>
        <button className="primario" disabled={executando} onClick={executar}>{executando ? "Calculando…" : "Executar simulação"}</button>
      </div>
    </div>

    {impacto && (<>
      <h2 style={{ marginTop: 16 }}>No momento da linha do tempo</h2>
      <table className="props"><tbody>
        <tr><td>Subida do rio</td><td>{n(subidaAgora, 2)} m</td></tr>
        <tr><td>Área inundada além do leito</td><td>{n(impactoAgora?.area_km2 ?? 0, 2)} km²</td></tr>
      </tbody></table>

      <h2 style={{ marginTop: 16 }}>Movimentos de massa <span className="tag tag-prev">ESTIMATIVA</span></h2>
      <table className="props"><tbody>
        <tr><td>Chuva agora</td><td>{n(chuvaAgora.mmh, 1)} mm/h</td></tr>
        <tr><td>Chuva acumulada</td><td>{n(chuvaAgora.acumulado, 0)} mm</td></tr>
        <tr><td>Setores SGB ativados até agora</td><td>{tempo !== null ? ativacoes.filter((a) => a.t <= tempo).length : 0} de {ativacoes.length} no cenário</td></tr>
        <tr><td>Pessoas nesses setores (SGB)</td><td>{n(ativacoes.filter((a) => tempo !== null && a.t <= tempo).reduce((s, a) => s + a.setor.pessoas, 0))}</td></tr>
      </tbody></table>
      {ativacoes.filter((a) => tempo !== null && a.t <= tempo).slice(-6).reverse().map((a) => (
        <p key={a.setor.id} className="muted"><span style={{ color: a.setor.grau.startsWith("Muito") ? "#f85149" : "#f0883e" }}>▲</span>{" "}
          {nomes[a.setor.municipio]} — {a.setor.local || "setor"} ({a.setor.tipologia}; {a.setor.pessoas} pess.) · {a.motivo}</p>))}
      <p className="muted">Só considera setores já mapeados pelo SGB (Cotiporã e Veranópolis). Ativação = o cenário atinge o
        limiar, não previsão de ruptura. A terra caindo no mapa é ilustração visual.</p>

      <h2 style={{ marginTop: 16 }}>Impacto no pico — {n(impacto.pico_m, 2)} m <span className="tag tag-prev">ESTIMATIVA</span></h2>
      <div className="tiles mini">
        <div className="tile"><div className="tile-valor">{n(impacto.area_km2, 2)} km²</div><div className="tile-rot">área inundada além do leito</div></div>
        <div className="tile"><div className="tile-valor">{n(impacto.edificacoes.length)}</div><div className="tile-rot">edificações atingidas</div>
          <div className="tile-nota">{n(impacto.edificacoes.filter((e) => e.prof_max >= 1).length)} com lâmina ≥ 1 m</div></div>
        <div className="tile"><div className="tile-valor">{n(Object.values(impacto.vias_km).reduce((s, v) => s + v, 0), 1)} km</div><div className="tile-rot">de vias alagadas</div></div>
        <div className="tile"><div className="tile-valor">{n(impacto.pontes.length)}</div><div className="tile-rot">pontes no trecho alagado</div></div>
        <div className="tile"><div className="tile-valor">{n(impacto.instituicoes.length)}</div><div className="tile-rot">instituições expostas</div></div>
      </div>
      {porMun.length > 0 && <table className="props"><tbody>
        <tr><td>Município</td><td>Edif.</td><td>≥1 m</td><td>Vias</td><td>Pontes</td><td>Inst.</td></tr>
        {porMun.map((l) => <tr key={l.m}><td>{nomes[l.m] ?? l.m}</td><td>{l.ed}</td><td>{l.edFundo}</td>
          <td>{n(l.vias, 1)} km</td><td>{l.pontes}</td><td>{l.inst}</td></tr>)}
      </tbody></table>}
      {impacto.instituicoes.length > 0 && (<><h3>Instituições expostas</h3>
        {impacto.instituicoes.map((i, k) => <p key={k} className="muted">{i.categoria}: {i.nome ?? "sem nome"} ({nomes[i.municipio]}) — ~{n(i.prof, 1)} m</p>)}</>)}
      <p className="muted">Contagens só do que existe no OpenStreetMap (cobertura incompleta). População exposta não estimada:
        falta a média de moradores por edificação. Resultados são indicativos para triagem e planejamento.</p>
      <div className="linha"><button onClick={exportar}>Exportar resultados (GeoJSON)</button>
        <button onClick={() => setComparacao(comparacao ? null : execucoes[0] ?? null)}>{comparacao ? "Limpar comparação" : "Fixar como cenário A"}</button></div>

      {comparacao && (<><h2 style={{ marginTop: 16 }}>Comparação de cenários</h2>
        <table className="props"><tbody>
          <tr><td></td><td>A</td><td>Atual</td></tr>
          <tr><td>Cenário</td><td>{comparacao.rotulo}</td><td>{rotulo}</td></tr>
          <tr><td>Subida no pico</td><td>{n(comparacao.pico_m, 2)} m</td><td>{n(impacto.pico_m, 2)} m</td></tr>
          <tr><td>Área inundada</td><td>{n(comparacao.area_km2, 2)} km²</td><td>{n(impacto.area_km2, 2)} km²</td></tr>
          <tr><td>Edificações</td><td>{comparacao.edificacoes}</td><td>{impacto.edificacoes.length}</td></tr>
          <tr><td>Vias</td><td>{n(comparacao.vias_km, 1)} km</td><td>{n(Object.values(impacto.vias_km).reduce((s, v) => s + v, 0), 1)} km</td></tr>
          <tr><td>Pontes</td><td>{comparacao.pontes}</td><td>{impacto.pontes.length}</td></tr>
          <tr><td>Instituições</td><td>{comparacao.instituicoes}</td><td>{impacto.instituicoes.length}</td></tr>
        </tbody></table></>)}
    </>)}

    <h2 style={{ marginTop: 16 }}>Simulações executadas ({execucoes.length})</h2>
    {execucoes.slice(0, 6).map((e) => <p key={e.id} className="muted">{new Date(e.em).toLocaleString("pt-BR")} — {e.rotulo}:
      {" "}{n(e.area_km2, 2)} km², {e.edificacoes} edif.</p>)}

    <h2 style={{ marginTop: 16 }}>Método e limitações</h2>
    <p className="muted">HAND (altura acima da drenagem mais próxima) sobre o Copernicus GLO-30. Inunda as células cuja altura acima
      do rio é menor que a subida; profundidade = subida − HAND. Não representa velocidade, remanso, propagação da onda nem
      operação de barragens; assume a mesma subida em todo o trecho. O relevo é de superfície (inclui vegetação e telhados).
      Para decisão, substituir por modelagem hidráulica (HEC-RAS) validada por profissional habilitado.</p>
  </>);
}
