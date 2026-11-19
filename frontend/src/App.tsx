import { useEffect, useMemo, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { ATUALIDADE, atualidade, corChuva, ESCALA_CHUVA, PainelMonitoramento, type EstacaoAna, type Monitoramento,
  type PontoSerie, type PrevisaoHora } from "./Monitoramento";
import { chaveHora, HORA, horaCheia, LinhaDoTempo, type Marcador } from "./LinhaDoTempo";
import { CONDICOES, FormRegistro, ListaRegistros, useRegistros, type Registro } from "./Vistorias";
import { PainelRegional } from "./PainelRegional";
import { AnaliseHistorica } from "./Historico";
import { ContatosPrefeitura } from "./Contatos";
import { calcularImpacto, CENARIO_PADRAO, desenharLamina, hidrograma, PainelSimulacao, PROFUNDIDADE, subidaEm,
  areaInundadaKm2, registrarExecucao, useFeicoes, useModeloHand, type Cenario, type Execucao, type Impacto,
  calcularAtivacoes, chuvaEm, useSetores, type Ativacao, type PassoHg } from "./Simulacao";
import { animarDeslizamento, direcaoEncosta, Tempestade } from "./Efeitos";
import { ponto as estiloPonto, rotulo } from "./Rotulos";

type Anel = [number, number][];
/** Ponto em polígono (ray casting) sobre os anéis do limite municipal. */
function dentro(lon: number, lat: number, aneis: Anel[]) {
  let d = false;
  for (const anel of aneis)
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [xi, yi] = anel[i], [xj, yj] = anel[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) d = !d;
    }
  return d;
}

interface Municipio { codigo_ibge: number; nome: string }
interface Fonte { nome: string; licenca: string; url?: string; obtido_em?: string; resolucao_espacial?: string; metodo?: string }
interface ClasseRelevo { classe: string; de_pct: number; ate_pct: number | null; cor: string; area_km2: number; fracao: number }
interface Relevo {
  codigo_ibge: number; nome: string;
  retangulo: { oeste: number; sul: number; leste: number; norte: number };
  altitude_m: { min: number; max: number; media: number };
  declividade_media_pct: number; classes: ClasseRelevo[]; fonte: Fonte;
}

type Modo = "territorial" | "monitoramento" | "simulacao" | "historico" | "regional";
const MODOS: { id: Modo; nome: string }[] = [
  { id: "territorial", nome: "1 · Realidade territorial" },
  { id: "monitoramento", nome: "2 · Monitoramento" },
  { id: "simulacao", nome: "3 · Simulação" },
  { id: "historico", nome: "4 · Análise histórica" },
  { id: "regional", nome: "Central regional" },
];
const ATUALIZA_MONIT_MS = 5 * 60 * 1000;

type Camada = "limite" | "risco" | "saude" | "prefeitura" | "declividade" | "rios" | "vias" | "edificacoes" | "instituicoes" | "campo";
const CAMADAS: { id: Camada; nome: string; cor: string }[] = [
  { id: "limite", nome: "Limites municipais (IBGE)", cor: "#4da3ff" },
  { id: "risco", nome: "Áreas de risco geológico (SGB/CPRM)", cor: "#d7301f" },
  { id: "declividade", nome: "Declividade (Copernicus 30 m)", cor: "#fc8d59" },
  { id: "rios", nome: "Cursos d’água (OSM)", cor: "#3fc1ff" },
  { id: "vias", nome: "Ruas e estradas (OSM)", cor: "#f5c451" },
  { id: "edificacoes", nome: "Edificações (OSM)", cor: "#ff8a65" },
  { id: "instituicoes", nome: "Instituições e emergência (OSM)", cor: "#e5e9f0" },
  { id: "saude", nome: "Saúde — CNES (oficial)", cor: "#ff5c70" },
  { id: "prefeitura", nome: "Órgãos municipais (sites das prefeituras)", cor: "#b392f0" },
  { id: "campo", nome: "Vistorias e ocorrências (campo)", cor: "#f0883e" },
];
const CATEGORIAS: Record<string, string> = {
  "Administração": "#c792ea", "Segurança": "#4d7cff", "Saúde": "#ff5c70",
  "Acolhimento": "#6be28a", "Infraestrutura": "#ffb84d", "Prefeitura": "#b392f0",
};
const FONTE_IBGE: Fonte = { nome: "IBGE – Malha Municipal (API de Malhas v3)", licenca: "CC BY 4.0",
  url: "https://servicodados.ibge.gov.br/api/v3/malhas/" };
const ALTURA_POR_PAVIMENTO = 3; // m, usada só para altura aproximada

const dataUrl = (p: string) => `${import.meta.env.BASE_URL}data/${p}`;
const agora = () => Cesium.JulianDate.now();

async function buscarJson<T>(caminho: string): Promise<T | null> {
  const r = await fetch(dataUrl(caminho));
  // Arquivo ainda não gerado: servidores estáticos podem devolver HTML em vez de 404.
  if (!r.ok || !(r.headers.get("content-type") ?? "").match(/json/)) return null;
  return r.json();
}

/** Extrusão das edificações, distinguindo altura real, aproximada e sem dados (seção 4.3). */
function estilizarEdificacoes(ds: Cesium.GeoJsonDataSource) {
  for (const e of ds.entities.values) {
    if (!e.polygon || !e.properties) continue;
    const p = e.properties.getValue(agora());
    const altura = parseFloat(String(p.height ?? "").replace(",", "."));
    const pav = parseFloat(p["building:levels"]);
    let h = 0, origem = "sem dados de altura", cor = Cesium.Color.LIGHTGRAY.withAlpha(0.7);
    if (altura > 0) { h = altura; origem = "real (OSM height)"; cor = Cesium.Color.fromCssColorString("#ff8a65"); }
    else if (pav > 0) { h = pav * ALTURA_POR_PAVIMENTO; origem = `aproximada (${pav} pav. × ${ALTURA_POR_PAVIMENTO} m)`;
      cor = Cesium.Color.fromCssColorString("#ffc4a8"); }
    e.properties.addProperty("altura_origem", origem);
    if (h) e.properties.addProperty("altura_m", h);
    e.polygon.material = new Cesium.ColorMaterialProperty(cor);
    e.polygon.outline = new Cesium.ConstantProperty(false);
    e.polygon.heightReference = new Cesium.ConstantProperty(Cesium.HeightReference.CLAMP_TO_GROUND);
    if (h) {
      e.polygon.extrudedHeight = new Cesium.ConstantProperty(h);
      e.polygon.extrudedHeightReference = new Cesium.ConstantProperty(Cesium.HeightReference.RELATIVE_TO_GROUND);
    }
  }
}

function estilizarInstituicoes(ds: Cesium.GeoJsonDataSource) {
  for (const e of ds.entities.values) {
    const p = e.properties?.getValue(agora());
    const cat = p?.categoria as string;
    e.billboard = undefined;
    e.point = new Cesium.PointGraphics(estiloPonto(CATEGORIAS[cat] ?? "#ffffff", { tamanho: 13, borda: "#0b1220" }));
    const nome = (p?.name as string) || (p?.tipo as string);
    if (nome) e.label = new Cesium.LabelGraphics(rotulo(nome, { distanciaMax: 3200 }));
  }
}

/** Vários órgãos no mesmo endereço: um só rótulo ("A, B (+2)") para não sobrepor textos. */
function agruparRotulos(ds: Cesium.DataSource) {
  const grupos = new Map<string, Cesium.Entity[]>();
  for (const e of ds.entities.values) {
    const p = e.position?.getValue(agora());
    if (!p || !e.label) continue;
    const g = Cesium.Cartographic.fromCartesian(p);
    const k = `${g.longitude.toFixed(6)},${g.latitude.toFixed(6)}`; // ~5 m
    grupos.set(k, [...(grupos.get(k) ?? []), e]);
  }
  for (const es of grupos.values()) {
    if (es.length < 2) continue;
    const nomes = es.map((e) => e.label!.text?.getValue(agora()) as string);
    es[0].label!.text = new Cesium.ConstantProperty(`${nomes.slice(0, 2).join(", ")}${es.length > 2 ? ` (+${es.length - 2})` : ""}`);
    es.slice(1).forEach((e) => { e.label!.show = new Cesium.ConstantProperty(false); });
  }
}

/** Setores SGB: muito alto em vermelho, alto em laranja (padrão da setorização). */
function estilizarRisco(ds: Cesium.GeoJsonDataSource) {
  for (const e of ds.entities.values) {
    if (!e.polygon || !e.properties) continue;
    const g = String(e.properties.getValue(agora()).grau_risco ?? "");
    const cor = Cesium.Color.fromCssColorString(g.startsWith("Muito") ? "#d7301f" : "#fc8d59");
    e.polygon.material = new Cesium.ColorMaterialProperty(cor.withAlpha(0.55));
    e.polygon.outline = new Cesium.ConstantProperty(false);
  }
  // Setores têm poucas dezenas de metros: um marcador no centro os mantém visíveis em qualquer zoom.
  for (const e of [...ds.entities.values]) {
    const h = e.polygon?.hierarchy?.getValue(agora()) as Cesium.PolygonHierarchy | undefined;
    if (!h || !e.properties) continue;
    const g = String(e.properties.getValue(agora()).grau_risco ?? "");
    ds.entities.add({
      position: Cesium.BoundingSphere.fromPoints(h.positions).center, properties: e.properties,
      point: estiloPonto(g.startsWith("Muito") ? "#d7301f" : "#fc8d59", { tamanho: 13 }),
      label: rotulo(g.startsWith("Muito") ? "Risco muito alto" : "Risco alto", { distanciaMax: 2500, cor: g.startsWith("Muito") ? "#ff9b8f" : "#ffc29a" }),
    });
  }
}

function contornarLimite(ds: Cesium.GeoJsonDataSource, cor: Cesium.Color) {
  // Polígonos colados ao terreno não desenham contorno: traça a borda como linha.
  for (const e of [...ds.entities.values]) {
    const h = e.polygon?.hierarchy?.getValue(agora()) as Cesium.PolygonHierarchy | undefined;
    if (!h) continue;
    ds.entities.add({ polyline: { positions: [...h.positions, h.positions[0]], width: 3, material: cor, clampToGround: true } });
  }
}

export default function App() {
  const el = useRef<HTMLDivElement>(null);
  const viewer = useRef<Cesium.Viewer>();
  // chave "camada/codigo" -> camada já carregada
  const vetores = useRef(new Map<string, Cesium.GeoJsonDataSource>());
  const imagens = useRef(new Map<string, Cesium.ImageryLayer>());
  const [munis, setMunis] = useState<Municipio[]>([]);
  const [relevo, setRelevo] = useState<Record<number, Relevo>>({});
  const [sel, setSel] = useState<number | null>(null);
  const [ativas, setAtivas] = useState<Record<Camada, boolean>>(
    { limite: true, risco: true, saude: true, prefeitura: true, declividade: false, rios: true, vias: true, edificacoes: false, instituicoes: true, campo: true });
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [procedencia, setProcedencia] = useState<Partial<Record<Camada, Fonte>>>({ limite: FONTE_IBGE });
  const [contagem, setContagem] = useState<Record<string, number>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [terreno, setTerreno] = useState(false);
  const [modo, setModo] = useState<Modo>("territorial");
  const [monit, setMonit] = useState<Monitoramento | null>(null);
  const [estacao, setEstacao] = useState<EstacaoAna | null>(null);
  const estacoesAna = useRef(new Cesium.CustomDataSource("ana"));
  const [tempo, setTempo] = useState<number | null>(null);
  const [tempoA, setTempoA] = useState<number | null>(null);
  const [corEstacao, setCorEstacao] = useState<"atualidade" | "chuva">("atualidade");

  // Simulação (Modo 3)
  const [simVisitada, setSimVisitada] = useState(false);
  const modelo = useModeloHand(dataUrl);
  const [cenario, setCenario] = useState<Cenario>(CENARIO_PADRAO);
  const [hg, setHg] = useState<PassoHg[]>([]);
  const [ativacoes, setAtivacoes] = useState<Ativacao[]>([]);
  const [efeitos, setEfeitos] = useState(true);
  const tempestade = useRef<Tempestade | null>(null);
  const deslizados = useRef(new Set<string>());
  const camadaDeslizamentos = useRef(new Cesium.CustomDataSource("deslizamentos"));
  // consultas ao terreno em fila (uma por vez), para não travar quando muitos setores ativam juntos
  const filaTerreno = useRef<Promise<unknown>>(Promise.resolve());
  const [tempoSim, setTempoSim] = useState<number | null>(null);
  const [tempoSimA, setTempoSimA] = useState<number | null>(null);
  const [impacto, setImpacto] = useState<Impacto | null>(null);
  const [executando, setExecutando] = useState(false);
  const [comparacao, setComparacao] = useState<Execucao | null>(null);
  const laminas = useRef(new Map<string, { ent: Cesium.Entity; canvas: HTMLCanvasElement[]; vez: number }>());

  // Registros de campo (vistorias e ocorrências), guardados no aparelho.
  const campo = useRegistros();
  const camadaCampo = useRef(new Cesium.CustomDataSource("campo"));
  const [abaDireita, setAbaDireita] = useState<"info" | "campo">("info");
  const [editando, setEditando] = useState<Registro | "novo" | null>(null);
  const [escolhendo, setEscolhendo] = useState(false);
  const [ponto, setPonto] = useState<{ lat: number; lon: number; precisao_m: number | null; origem: "gps" | "mapa" } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const limitesGeo = useRef(new Map<number, Anel[]>());
  const municipioDoPonto = (lat: number, lon: number) => {
    for (const [c, aneis] of limitesGeo.current) if (dentro(lon, lat, aneis)) return c;
    return null;
  };
  const escolhendoRef = useRef(false);
  escolhendoRef.current = escolhendo;

  // Índices por hora (UTC) para a linha do tempo.
  const linha = useMemo(() => {
    if (!monit) return null;
    const ana = new Map<string, Map<string, PontoSerie>>();
    let ini = Infinity;
    const marcas = new Map<number, Marcador>();
    for (const e of monit.fontes.ana.dados?.estacoes ?? []) {
      const m = new Map<string, PontoSerie>();
      for (const p of e.serie_horaria ?? []) {
        const t = horaCheia(Date.parse(p.t));
        m.set(chaveHora(t), p);
        ini = Math.min(ini, t);
        if ((p.chuva_mm ?? 0) >= 5) marcas.set(t, { t, tipo: "observado", rotulo: `${p.chuva_mm} mm/h em ${e.nome} (observado)` });
      }
      ana.set(e.codigo, m);
    }
    const prev = new Map<number, Map<string, PrevisaoHora>>();
    const agora = horaCheia(Date.now());
    let fim = agora;
    for (const p of monit.fontes.previsao.dados?.municipios ?? []) {
      const m = new Map<string, PrevisaoHora>();
      for (const h of p.horaria) {
        const t = Date.parse(h.t);
        if (t <= agora) continue; // o passado vem das observações, não do modelo
        m.set(chaveHora(t), h);
        fim = Math.max(fim, t);
        if (h.chuva_mm >= 5 && !marcas.has(t)) marcas.set(t, { t, tipo: "previsao", rotulo: `${h.chuva_mm} mm/h previstos (modelo)` });
      }
      prev.set(p.codigo_ibge, m);
    }
    if (!isFinite(ini)) ini = agora - 48 * HORA;
    marcas.set(agora, { t: agora, tipo: "agora", rotulo: "agora" });
    // Nível na hora pedida: último registro em até 2 h antes (não extrapola).
    const nivelEm = (codigo: string, t: number) => {
      const m = ana.get(codigo);
      for (let k = 0; k <= 2 && m; k++) { const p = m.get(chaveHora(t - k * HORA)); if (p) return p; }
      return null;
    };
    return { ana, prev, inicio: ini, fim, agora, marcadores: [...marcas.values()], nivelEm };
  }, [monit]);
  useEffect(() => { if (linha && tempo === null) setTempo(linha.agora); }, [linha]);

  const visiveis = () => (sel === null ? munis : munis.filter((m) => m.codigo_ibge === sel));

  useEffect(() => {
    // Relevo real usa o plano gratuito do Cesium ion (VITE_CESIUM_TOKEN). Sem token: sem relevo.
    const token = import.meta.env.VITE_CESIUM_TOKEN as string | undefined;
    if (token) Cesium.Ion.defaultAccessToken = token;
    setTerreno(!!token);
    const v = new Cesium.Viewer(el.current!, {
      baseLayerPicker: false, geocoder: false, timeline: false, animation: false,
      infoBox: false,
      baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({})),
      terrain: token ? Cesium.Terrain.fromWorldTerrain() : undefined,
      // resolução real da tela (texto e linhas nítidos) + antisserrilhamento
      useBrowserRecommendedResolution: false, msaaSamples: 4,
    });
    v.scene.postProcessStages.fxaa.enabled = true;
    v.selectedEntityChanged.addEventListener((e) => {
      const ana = e?.id?.startsWith("ana-") ? (e.properties?.getValue(agora()).estacao as EstacaoAna) : null;
      setEstacao(ana);
      const idCampo = e?.id?.startsWith("campo-") ? e.properties?.getValue(agora())?.registro_campo : null;
      if (idCampo) window.dispatchEvent(new CustomEvent("abrir-registro", { detail: idCampo }));
      setInfo(e?.properties && !ana ? e.properties.getValue(agora()) : null);
    });
    v.dataSources.add(estacoesAna.current);
    v.dataSources.add(camadaCampo.current);
    // Marcar local no mapa: o próximo clique define as coordenadas do registro.
    new Cesium.ScreenSpaceEventHandler(v.scene.canvas).setInputAction((ev: { position: Cesium.Cartesian2 }) => {
      if (!escolhendoRef.current) return;
      const ray = v.camera.getPickRay(ev.position);
      const c = ray && v.scene.globe.pick(ray, v.scene);
      if (!c) return;
      const g = Cesium.Cartographic.fromCartesian(c);
      setPonto({ lat: Cesium.Math.toDegrees(g.latitude), lon: Cesium.Math.toDegrees(g.longitude), precisao_m: null, origem: "mapa" });
      setEscolhendo(false);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    viewer.current = v;
    if (import.meta.env.DEV) (window as unknown as { viewer: Cesium.Viewer }).viewer = v; // depuração
    (async () => {
      const lista = await buscarJson<Municipio[]>("municipios.json");
      if (!lista) throw new Error("municipios.json não encontrado");
      const rel: Record<number, Relevo> = {};
      for (const m of lista) {
        const r = await buscarJson<Relevo>(`${m.codigo_ibge}/relevo.json`);
        if (r) rel[m.codigo_ibge] = r;
      }
      setRelevo(rel);
      for (const m of lista) {
        const gj = await buscarJson<{ features: { geometry: { type: string; coordinates: unknown } }[] }>(`${m.codigo_ibge}/limite.geojson`);
        const g = gj?.features[0]?.geometry;
        if (!g) continue;
        const polis = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Anel[][];
        limitesGeo.current.set(m.codigo_ibge, polis.flat());
      }
      const primeira = Object.values(rel)[0];
      if (primeira) setProcedencia((p) => ({ ...p, declividade: primeira.fonte }));
      setMunis(lista);
    })().catch((e) => setErro(String(e)));
    return () => v.destroy();
  }, []);

  // Registros de campo aparecem automaticamente no mapa (seção 15).
  useEffect(() => {
    const ds = camadaCampo.current;
    ds.entities.removeAll();
    for (const r of campo.registros) {
      if (sel !== null && r.codigo_ibge !== sel) continue;
      const c = CONDICOES[r.condicao];
      ds.entities.add({
        id: `campo-${r.id}`, position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
        point: estiloPonto(c.cor, { tamanho: 18, alfa: r.situacao === "encerrado" ? 0.45 : 1 }),
        label: rotulo(`${c.icone} ${r.natureza}`, { distanciaMax: 8000, deslocamentoY: -16 }),
        properties: { registro_campo: r.id, tipo: r.tipo, natureza: r.natureza, condicao: c.rotulo, data_hora: r.data_hora,
          responsavel: r.responsavel, descricao: r.descricao, situacao: r.situacao },
      });
    }
    ds.show = ativas.campo;
  }, [campo.registros, sel, ativas.campo]);

  // Ponto escolhido para um registro em edição.
  useEffect(() => {
    const ds = camadaCampo.current;
    ds.entities.removeById("campo-ponto-novo");
    if (editando && ponto) ds.entities.add({ id: "campo-ponto-novo", position: Cesium.Cartesian3.fromDegrees(ponto.lon, ponto.lat),
      point: { pixelSize: 16, color: Cesium.Color.TRANSPARENT, outlineColor: Cesium.Color.fromCssColorString("#f0883e"), outlineWidth: 4,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  }, [ponto, editando]);

  useEffect(() => {
    if (viewer.current) viewer.current.canvas.style.cursor = escolhendo ? "crosshair" : "";
  }, [escolhendo]);

  useEffect(() => {
    const abrir = (ev: Event) => {
      const r = campo.registros.find((x) => x.id === (ev as CustomEvent).detail);
      if (r) { setAbaDireita("campo"); setEditando(r); setPonto(null); }
    };
    window.addEventListener("abrir-registro", abrir);
    return () => window.removeEventListener("abrir-registro", abrir);
  }, [campo.registros]);

  const irPara = (lat: number, lon: number) => viewer.current?.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1500),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 }, duration: 1.2 });

  // Monitoramento: relê o arquivo periodicamente (o coletor o atualiza no servidor).
  useEffect(() => {
    const ler = () => fetch(dataUrl("monitoramento.json"), { cache: "no-store" })
      .then((r) => (r.ok && (r.headers.get("content-type") ?? "").match(/json/) ? r.json() : null))
      .then((m) => m && setMonit(m)).catch(() => { /* mantém os últimos dados; o painel mostra a idade */ });
    ler();
    const t = setInterval(ler, ATUALIZA_MONIT_MS);
    return () => clearInterval(t);
  }, []);

  // Estações ANA no mapa, coloridas pela atualidade do último dado.
  useEffect(() => {
    const ds = estacoesAna.current;
    ds.entities.removeAll();
    for (const e of monit?.fontes.ana.dados?.estacoes ?? []) {
      const a = atualidade(e.ultima_leitura);
      ds.entities.add({
        id: `ana-${e.codigo}`, name: e.nome,
        position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat),
        point: estiloPonto(ATUALIDADE[a].cor, { tamanho: 15, borda: "#0b1220" }),
        label: rotulo(`${e.nivel_atual_cm ?? "—"} cm`, { distanciaMax: 60000 }),
        properties: { estacao: e },
      });
    }
  }, [monit]);

  // Sincroniza o mapa com a linha do tempo.
  useEffect(() => {
    if (!linha || tempo === null) return;
    const futuro = tempo > linha.agora;
    for (const ent of estacoesAna.current.entities.values) {
      const e = ent.properties!.getValue(agora()).estacao as EstacaoAna;
      const p = futuro ? null : linha.nivelEm(e.codigo, tempo);
      const ehAgora = tempo === linha.agora;
      // Hora futura: não existe observação — estação neutra, não "desatualizada".
      const cor = futuro ? "#6e7681"
        : corEstacao === "atualidade" ? ATUALIDADE[atualidade(ehAgora ? e.ultima_leitura : p ? p.t : null)].cor
        : (corChuva(p?.chuva_mm) ?? "#6e7681");
      ent.point!.color = new Cesium.ConstantProperty(
        Cesium.Color.fromCssColorString(cor).withAlpha(futuro || (corEstacao === "chuva" && !p) ? 0.3 : 1));
      ent.label!.text = new Cesium.ConstantProperty(futuro ? "" : p ? `${p.nivel_cm ?? "—"} cm` : "sem dado");
    }
    // Previsão: pinta o município pela chuva prevista na hora (só em horas futuras).
    for (const m of munis) {
      const ds = vetores.current.get(`limite/${m.codigo_ibge}`);
      if (!ds) continue;
      const h = futuro && modo === "monitoramento" ? linha.prev.get(m.codigo_ibge)?.get(chaveHora(tempo)) : undefined;
      for (const ent of ds.entities.values) {
        if (!ent.polygon) continue;
        const c = h ? Cesium.Color.fromCssColorString(corChuva(h.chuva_mm)!).withAlpha(0.55)
          : Cesium.Color.fromCssColorString("#4da3ff").withAlpha(0.05);
        ent.polygon.material = new Cesium.ColorMaterialProperty(c);
      }
    }
  }, [linha, tempo, corEstacao, modo, munis, contagem, monit]);

  useEffect(() => {
    estacoesAna.current.show = modo === "monitoramento";
    if (modo !== "monitoramento") setEstacao(null);
  }, [modo]);

  // Carrega sob demanda e mostra/oculta camadas conforme seleção.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !munis.length) return;
    let cancelado = false;
    (async () => {
      const alvo = new Set(visiveis().map((m) => m.codigo_ibge));
      const novaContagem: Record<string, number> = {};
      for (const c of CAMADAS) {
        for (const m of munis) {
          const chave = `${c.id}/${m.codigo_ibge}`;
          const mostrar = ativas[c.id] && alvo.has(m.codigo_ibge) && (modo === "territorial" || c.id === "limite"
            || (modo === "simulacao" && (c.id === "vias" || c.id === "instituicoes")));

          if (c.id === "campo") continue; // camada própria (registros do aparelho)
          if (c.id === "declividade") {
            let camada = imagens.current.get(chave);
            const r = relevo[m.codigo_ibge];
            if (mostrar && !camada && r) {
              const ret = Cesium.Rectangle.fromDegrees(r.retangulo.oeste, r.retangulo.sul, r.retangulo.leste, r.retangulo.norte);
              const prov = await Cesium.SingleTileImageryProvider.fromUrl(dataUrl(`${m.codigo_ibge}/declividade.png`), { rectangle: ret });
              if (cancelado) return;
              camada = v.imageryLayers.addImageryProvider(prov);
              imagens.current.set(chave, camada);
            }
            if (camada) camada.show = mostrar;
            continue;
          }

          let ds = vetores.current.get(chave);
          if (mostrar && !ds) {
            const gj = await buscarJson<{ fonte?: Fonte }>(`${m.codigo_ibge}/${({ risco: "areas_risco", saude: "saude_cnes" } as Record<string, string>)[c.id] ?? c.id}.geojson`);
            if (!gj) continue; // camada ainda não baixada para este município
            const cor = Cesium.Color.fromCssColorString(c.cor);
            ds = await Cesium.GeoJsonDataSource.load(gj, {
              stroke: cor, strokeWidth: c.id === "limite" ? 3 : 2,
              fill: cor.withAlpha(c.id === "limite" ? 0.05 : 0.6), clampToGround: true,
            });
            if (c.id === "limite") {
              contornarLimite(ds, cor);
              const pol = ds.entities.values.find((x) => x.polygon);
              const h = pol?.polygon?.hierarchy?.getValue(agora()) as Cesium.PolygonHierarchy | undefined;
              if (h) ds.entities.add({ position: Cesium.BoundingSphere.fromPoints(h.positions).center,
                label: rotulo(m.nome.toUpperCase(), { destaque: true, distanciaMax: 250000, deslocamentoY: 0, cor: "#cfe3ff" }) });
            }
            if (c.id === "edificacoes") estilizarEdificacoes(ds);
            if (c.id === "instituicoes" || c.id === "saude" || c.id === "prefeitura") { estilizarInstituicoes(ds); agruparRotulos(ds); }
            if (c.id === "risco") estilizarRisco(ds);
            if (cancelado) return;
            await v.dataSources.add(ds);
            vetores.current.set(chave, ds);
            if (gj.fonte && c.id !== "limite") setProcedencia((p) => ({ ...p, [c.id]: gj.fonte }));
          }
          if (ds) {
            ds.show = mostrar;
            if (mostrar) novaContagem[c.id] = (novaContagem[c.id] ?? 0) + ds.entities.values.filter((e) => e.properties && (c.id !== "risco" || e.polygon)).length;
          }
        }
      }
      if (!cancelado) setContagem(novaContagem);
    })().catch((e) => setErro(String(e)));
    return () => { cancelado = true; };
  }, [munis, relevo, sel, ativas, modo]);

  // Enquadra a seleção com a câmera inclinada, para o relevo aparecer.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !munis.length) return;
    const t = setTimeout(() => {
      const ents = visiveis().flatMap((m) => vetores.current.get(`limite/${m.codigo_ibge}`)?.entities.values ?? []);
      if (ents.length) v.flyTo(ents, { duration: 1.5, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), 0) });
    }, 600);
    return () => clearTimeout(t);
  }, [munis, sel]);

  const nomes = Object.fromEntries(munis.map((m) => [m.codigo_ibge, m.nome]));
  const munisSim = useMemo(() => (simVisitada ? munis : []), [simVisitada, munis]);
  const feicoes = useFeicoes(munisSim, dataUrl);
  const setores = useSetores(munisSim, dataUrl);
  useEffect(() => { if (modo === "simulacao") setSimVisitada(true); }, [modo]);

  const executarSimulacao = async () => {
    const rio = modelo.rios[cenario.rio];
    if (!rio || !feicoes) return;
    setExecutando(true);
    let serie = null, base = null;
    if (cenario.tipo === "historico") {
      const ev = modelo.eventos.find((e) => e.id === cenario.evento);
      if (ev) { const d = await fetch(dataUrl(`eventos/${ev.arquivo}`)).then((r) => r.json()); serie = d.serie; base = d.nivel_base_cm; }
    }
    const h = hidrograma(cenario, serie, base);
    await new Promise((r) => setTimeout(r, 0));
    const pico = Math.max(...h.map((x) => x.h));
    setHg(h);
    setAtivacoes(calcularAtivacoes(setores, h, cenario, rio));
    deslizados.current.clear();
    camadaDeslizamentos.current.entities.removeAll();
    const imp = calcularImpacto(rio, pico, feicoes);
    registrarExecucao(cenario, modelo.eventos, imp);
    setImpacto(imp);
    setTempoSim(h[0].t);
    setExecutando(false);
    const { oeste, sul, leste, norte } = rio.meta.retangulo;
    viewer.current?.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(oeste, sul, leste, norte), duration: 1.5 });
  };
  const subidaAgora = tempoSim !== null ? subidaEm(hg, tempoSim) : 0;
  const chuvaAgora = tempoSim !== null ? chuvaEm(hg, tempoSim) : { mmh: 0, acumulado: 0, ultimas6h: 0 };

  // Nuvens e chuva (ilustração) sobre a área dos rios, com intensidade do cenário.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !modelo.meta || tempestade.current) return;
    const rs = modelo.meta.rios.map((r) => r.retangulo);
    tempestade.current = new Tempestade(v, { oeste: Math.min(...rs.map((r) => r.oeste)), leste: Math.max(...rs.map((r) => r.leste)),
      sul: Math.min(...rs.map((r) => r.sul)), norte: Math.max(...rs.map((r) => r.norte)) });
    tempestade.current.mostrar(false);
    v.dataSources.add(camadaDeslizamentos.current);
  }, [modelo.meta]);
  useEffect(() => {
    const ts = tempestade.current;
    if (!ts) return;
    const ativo = modo === "simulacao" && efeitos && hg.length > 0;
    ts.mostrar(ativo);
    camadaDeslizamentos.current.show = modo === "simulacao";
    if (ativo) ts.definir(chuvaAgora.mmh, Math.min(1, 0.15 + chuvaAgora.ultimas6h / 25));
  }, [modo, efeitos, hg, tempoSim]);

  // Deslizamentos: marca setores ativados até o momento e anima a terra caindo (ilustração).
  useEffect(() => {
    const v = viewer.current;
    if (!v || tempoSim === null) return;
    const ds = camadaDeslizamentos.current;
    const novos: Ativacao[] = [];
    for (const a of ativacoes) {
      const id = `desl-${a.setor.id}`;
      if (a.t > tempoSim) {
        if (deslizados.current.delete(a.setor.id)) ds.entities.removeById(id);
        continue;
      }
      if (deslizados.current.has(a.setor.id)) continue;
      deslizados.current.add(a.setor.id);
      // marcador colado ao chão: não precisa consultar o terreno
      ds.entities.add({ id, position: Cesium.Cartesian3.fromDegrees(a.setor.lon, a.setor.lat),
        point: estiloPonto("#7a4a22", { tamanho: 16, borda: "#f0883e" }),
        label: rotulo("▲ deslizamento estimado", { distanciaMax: 9000, cor: "#ffc29a" }),
        properties: { setor_sgb: a.setor.id, municipio: a.setor.municipio, local: a.setor.local, grau_risco: a.setor.grau,
          tipologia: a.setor.tipologia, pessoas_sgb: a.setor.pessoas, motivo: a.motivo, natureza: "ESTIMATIVA" } });
      if (tempoSim - a.t <= 3 * 3.6e6) novos.push(a); // ao pular para o fim, não anima tudo de uma vez
    }
    if (!novos.length || !efeitos || modo !== "simulacao") return;
    // Anima só os 5 setores recém-ativados mais próximos da câmera (os que se consegue ver).
    const cam = v.camera.positionCartographic;
    const perto = novos.map((a) => ({ a, d: Math.hypot(a.setor.lon - Cesium.Math.toDegrees(cam.longitude), a.setor.lat - Cesium.Math.toDegrees(cam.latitude)) }))
      .sort((x, y) => x.d - y.d).slice(0, 5);
    for (const { a } of perto) {
      filaTerreno.current = filaTerreno.current.then(() => direcaoEncosta(v, a.setor.lon, a.setor.lat)).then(({ origem, direcao }) => {
        if (deslizados.current.has(a.setor.id)) animarDeslizamento(v, origem, direcao, a.setor.grau.startsWith("Muito") ? 1.4 : 1);
      });
    }
  }, [tempoSim, ativacoes]);

  // Lâmina d'água: um retângulo texturizado por rio, redesenhado a cada passo da linha do tempo.
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    for (const [id, l] of laminas.current) l.ent.show = modo === "simulacao" && id === cenario.rio && hg.length > 0;
    const rio = modelo.rios[cenario.rio];
    if (modo !== "simulacao" || !rio || !hg.length || tempoSim === null) return;
    let l = laminas.current.get(rio.meta.id);
    if (!l) {
      const { oeste, sul, leste, norte } = rio.meta.retangulo;
      const canvas = [document.createElement("canvas"), document.createElement("canvas")];
      const ent = v.entities.add({ rectangle: { coordinates: Cesium.Rectangle.fromDegrees(oeste, sul, leste, norte),
        material: new Cesium.ImageMaterialProperty({ image: canvas[0], transparent: true }),
        classificationType: Cesium.ClassificationType.TERRAIN } });
      l = { ent, canvas, vez: 0 };
      laminas.current.set(rio.meta.id, l);
    }
    l.vez = 1 - l.vez; // alterna canvas para o Cesium perceber a troca de textura
    desenharLamina(rio, subidaAgora, l.canvas[l.vez]);
    l.ent.rectangle!.material = new Cesium.ImageMaterialProperty({ image: l.canvas[l.vez], transparent: true });
    l.ent.show = true;
  }, [modo, hg, tempoSim, cenario.rio, modelo.rios]);

  // Estatísticas de relevo da seleção (município ou soma da região).
  const rels = visiveis().map((m) => relevo[m.codigo_ibge]).filter(Boolean);
  const classes = rels.length ? rels[0].classes.map((c, i) => {
    const area = rels.reduce((s, r) => s + r.classes[i].area_km2, 0);
    return { ...c, area_km2: area };
  }) : [];
  const areaTotal = classes.reduce((s, c) => s + c.area_km2, 0);

  return (
    <div className="app">
      <div className="top"><h1>Gêmeos Digitais Regionais</h1>
        <nav className="modos">{MODOS.map((m) => (
          <button key={m.id} className={modo === m.id ? "on" : ""} onClick={() => setModo(m.id)}>{m.nome}</button>))}</nav>
        <span className="muted" style={{ marginLeft: "auto" }}>
          Relevo 3D: {terreno ? "Cesium World Terrain" : "desligado (sem token)"}</span></div>
      {modo === "regional" && (
        <PainelRegional munis={munis} relevo={relevo} monit={monit} registros={campo.registros}
          onAbrir={(c) => { setSel(c); setModo("territorial"); }} />)}
      {modo === "historico" && (
        <AnaliseHistorica munis={munis} eventosAna={modelo.eventos}
          onSimular={(id) => {
            const ev = modelo.eventos.find((e) => e.id === id);
            if (ev) setCenario({ ...cenario, tipo: "historico", rio: ev.rio, evento: id });
            setModo("simulacao");
          }} />)}
      <div className="main" style={modo === "regional" || modo === "historico" ? { display: "none" } : undefined}>
        <div className="side">
          <h2>Municípios</h2>
          <button className={sel === null ? "on" : ""} onClick={() => setSel(null)}>Região (todos)</button>
          {munis.map((m) => (
            <button key={m.codigo_ibge} className={sel === m.codigo_ibge ? "on" : ""}
              onClick={() => setSel(m.codigo_ibge)}>{m.nome}</button>
          ))}
          {modo === "monitoramento" && (<>
            <h2 style={{ marginTop: 16 }}>Estações ANA — atualidade</h2>
            <div className="legenda">{Object.values(ATUALIDADE).map((a) => (
              <div key={a.rotulo}><span style={{ color: a.cor }}>{a.icone}</span>{a.rotulo}</div>))}</div>
            <h2 style={{ marginTop: 12 }}>Cor das estações</h2>
            <label className="layer"><input type="radio" checked={corEstacao === "atualidade"}
              onChange={() => setCorEstacao("atualidade")} />Atualidade do dado</label>
            <label className="layer"><input type="radio" checked={corEstacao === "chuva"}
              onChange={() => setCorEstacao("chuva")} />Chuva na hora (mm/h)</label>
            <h2 style={{ marginTop: 12 }}>Escala de chuva (mm/h)</h2>
            <div className="legenda">{ESCALA_CHUVA.map((c) => (
              <div key={c.rotulo}><span className="swatch" style={{ background: c.cor }} />{c.rotulo}</div>))}</div>
            <p className="muted">Rótulo = nível bruto da estação (cm) na hora da linha do tempo.
              Em horas futuras, as estações ficam cinza (não há observação) e os municípios são pintados pela
              <b> chuva prevista</b> (modelo), na mesma escala.</p>
          </>)}
          {modo === "simulacao" && (<>
            <h2 style={{ marginTop: 16 }}>Profundidade estimada</h2>
            <div className="legenda">{PROFUNDIDADE.map((p) => (
              <div key={p.rotulo}><span className="swatch" style={{ background: `rgb(${p.cor.join(",")})` }} />{p.rotulo}</div>))}</div>
            <p className="muted">Água mais transparente = leito e reservatórios em condição normal.
              Vias e instituições do OSM aparecem para referência.</p>
          </>)}
          {modo === "territorial" && <h2 style={{ marginTop: 16 }}>Camadas</h2>}
          {modo === "territorial" && CAMADAS.map((c) => (
            <label key={c.id} className="layer">
              <input type="checkbox" checked={ativas[c.id]}
                onChange={(e) => setAtivas({ ...ativas, [c.id]: e.target.checked })} />
              <span className="swatch" style={{ background: c.cor }} />{c.nome}
              {ativas[c.id] && contagem[c.id] !== undefined && <span className="muted">({contagem[c.id]})</span>}
            </label>
          ))}
          {modo === "territorial" && ativas.instituicoes && (<div className="legenda">
            {Object.entries(CATEGORIAS).map(([k, cor]) => (
              <div key={k}><span className="dot" style={{ background: cor }} />{k}</div>))}
          </div>)}
          {modo === "territorial" && ativas.risco && (<div className="legenda">
            <div><span className="swatch" style={{ background: "#d7301f" }} />Risco muito alto (SGB)</div>
            <div><span className="swatch" style={{ background: "#fc8d59" }} />Risco alto (SGB)</div>
          </div>)}
          {modo === "territorial" && ativas.edificacoes && (<div className="legenda">
            <div><span className="swatch" style={{ background: "#ff8a65" }} />Altura real</div>
            <div><span className="swatch" style={{ background: "#ffc4a8" }} />Altura aproximada (pavimentos)</div>
            <div><span className="swatch" style={{ background: "#d3d3d3" }} />Sem dados de altura (plana)</div>
          </div>)}
          {erro && <p className="muted">Erro: {erro}</p>}
        </div>
        <div className="map"><div ref={el} />
          {modo === "simulacao" && efeitos && hg.length > 0 && <div className="selo-ilustracao">
            Nuvens, chuva e terra caindo: ilustração visual · Água e setores ativados: estimativa</div>}
          {escolhendo && <div className="faixa">Clique no mapa para marcar o local do registro ·
            <button onClick={() => setEscolhendo(false)}>cancelar</button></div>}
        </div>
        <div className="side right">
          {modo === "simulacao" ? (
            <PainelSimulacao modelo={modelo} cenario={cenario} setCenario={setCenario} impacto={impacto}
              impactoAgora={modelo.rios[cenario.rio] && hg.length ? { area_km2: areaInundadaKm2(modelo.rios[cenario.rio], subidaAgora) } : null}
              subidaAgora={subidaAgora} nomes={nomes} executar={executarSimulacao} executando={executando || (simVisitada && !feicoes)}
              comparacao={comparacao} setComparacao={setComparacao} ativacoes={ativacoes} tempo={tempoSim}
              chuvaAgora={chuvaAgora} efeitos={efeitos} setEfeitos={setEfeitos} />
          ) : modo === "monitoramento" ? (
            <PainelMonitoramento m={monit} sel={sel} estacao={estacao}
              momento={linha && tempo !== null ? { tempo, agora: linha.agora, tempoA, nivelEm: linha.nivelEm } : null}
              nomes={nomes} />
          ) : (<>
          <div className="seg abas">
            <button className={abaDireita === "info" ? "on" : ""} onClick={() => setAbaDireita("info")}>Informações</button>
            <button className={abaDireita === "campo" ? "on" : ""} onClick={() => setAbaDireita("campo")}>
              Campo ({campo.registros.filter((r) => r.situacao === "aberto").length})</button>
          </div>
          {aviso && <p className="aviso" onClick={() => setAviso(null)}>{aviso}</p>}
          {campo.erro && <p className="aviso">{campo.erro}</p>}
          {abaDireita === "campo" ? (editando ? (
            <FormRegistro key={editando === "novo" ? "novo" : editando.id} inicial={editando === "novo" ? null : editando}
              ponto={ponto} municipioDoPonto={municipioDoPonto} nomes={nomes}
              onPedirMapa={() => setEscolhendo(true)}
              onCancelar={() => { setEditando(null); setPonto(null); setEscolhendo(false); }}
              onExcluir={async (id) => { await campo.remover(id); setEditando(null); setPonto(null); setAviso("Registro excluído."); }}
              onSalvar={async (r) => {
                await campo.salvar(r); setEditando(null); setPonto(null);
                setAviso("Registro salvo neste aparelho.");
              }} />
          ) : (
            <ListaRegistros registros={campo.registros} nomes={nomes} sel={sel}
              onNovo={() => { setEditando("novo"); setPonto(null); }}
              onAbrir={(r) => { setEditando(r); setPonto(null); }}
              onIrPara={(r) => irPara(r.lat, r.lon)}
              onImportar={async (f) => {
                try { setAviso(`${await campo.importar(f)} registro(s) importado(s) ou atualizado(s).`); }
                catch (e) { setAviso(`Arquivo inválido: ${e}`); }
              }} />
          )) : (<>
          <h2>Objeto selecionado</h2>
          {info ? (<table className="props"><tbody>{Object.entries(info).map(([k, val]) => (
            <tr key={k}><td>{k}</td><td>{String(val)}</td></tr>))}</tbody></table>)
            : <p className="muted">Clique em um elemento do mapa.</p>}

          {rels.length > 0 && (<>
            <h2 style={{ marginTop: 16 }}>Relevo — {sel === null ? "região" : rels[0].nome}</h2>
            <table className="props"><tbody>
              <tr><td>Altitude mín.</td><td>{Math.min(...rels.map((r) => r.altitude_m.min)).toFixed(0)} m</td></tr>
              <tr><td>Altitude máx.</td><td>{Math.max(...rels.map((r) => r.altitude_m.max)).toFixed(0)} m</td></tr>
              {rels.length === 1 && <tr><td>Declividade média</td><td>{rels[0].declividade_media_pct}%</td></tr>}
              <tr><td>Área analisada</td><td>{areaTotal.toFixed(1)} km²</td></tr>
            </tbody></table>
            <div className="barras">
              {classes.map((c) => (
                <div key={c.classe} className="barra">
                  <span className="rot"><span className="swatch" style={{ background: c.cor }} />
                    {c.classe} <span className="muted">({c.de_pct}{c.ate_pct ? `–${c.ate_pct}` : "+"}%)</span></span>
                  <span className="val">{c.area_km2.toFixed(1)} km² · {(100 * c.area_km2 / areaTotal).toFixed(0)}%</span>
                  <span className="trilho"><span style={{ width: `${100 * c.area_km2 / areaTotal}%`, background: c.cor }} /></span>
                </div>))}
            </div>
            <p className="muted">Classes EMBRAPA. Calculado sobre modelo de superfície (inclui vegetação e
              edificações): indicativo, não substitui mapeamento geotécnico.</p>
          </>)}

          {sel !== null && <ContatosPrefeitura codigo={sel} />}

          <h2 style={{ marginTop: 16 }}>Procedência</h2>
          {CAMADAS.filter((c) => procedencia[c.id]).map((c) => {
            const f = procedencia[c.id]!;
            return (<p key={c.id} className="muted"><b>{c.nome}</b><br />{f.nome} — {f.licenca}
              {f.resolucao_espacial && <><br />Resolução: {f.resolucao_espacial}</>}
              {f.obtido_em && <><br />Obtido em {f.obtido_em}</>}</p>);
          })}
          </>)}
          </>)}
        </div>
      </div>
      {modo === "simulacao" && hg.length > 1 && tempoSim !== null && (
        <LinhaDoTempo inicio={hg[0].t} fim={hg[hg.length - 1].t} agora={hg[hg.length - 1].t} tempo={tempoSim} setTempo={setTempoSim}
          marcadores={[{ t: hg.reduce((a, b) => (b.h > a.h ? b : a)).t, tipo: "previsao", rotulo: "pico do cenário" },
            ...ativacoes.map((a) => ({ t: a.t, tipo: "observado" as const, rotulo: `deslizamento estimado: ${a.setor.local}` }))]}
          tempoA={tempoSimA} setTempoA={setTempoSimA}
          etiqueta={{ texto: cenario.tipo === "historico" ? "SIMULAÇÃO · EVENTO REAL · ESTIMATIVA" : "SIMULAÇÃO · HIPOTÉTICO · ESTIMATIVA", classe: "tag-sim" }} />)}
      {modo === "monitoramento" && linha && tempo !== null && (
        <LinhaDoTempo inicio={linha.inicio} fim={linha.fim} agora={linha.agora} tempo={tempo} setTempo={setTempo}
          marcadores={linha.marcadores} tempoA={tempoA} setTempoA={setTempoA} />)}
    </div>
  );
}
