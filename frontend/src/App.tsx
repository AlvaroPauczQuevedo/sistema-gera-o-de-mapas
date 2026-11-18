import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

interface Municipio { codigo_ibge: number; nome: string }
interface Fonte { nome: string; licenca: string; url?: string; obtido_em?: string }

type Camada = "limite" | "vias" | "rios" | "edificacoes";
const CAMADAS: { id: Camada; nome: string; cor: string }[] = [
  { id: "limite", nome: "Limites municipais (IBGE)", cor: "#4da3ff" },
  { id: "rios", nome: "Cursos d’água (OSM)", cor: "#3fc1ff" },
  { id: "vias", nome: "Ruas e estradas (OSM)", cor: "#f5c451" },
  { id: "edificacoes", nome: "Edificações (OSM)", cor: "#ff8a65" },
];
const FONTE_IBGE: Fonte = { nome: "IBGE – Malha Municipal (API de Malhas v3)", licenca: "CC BY 4.0",
  url: "https://servicodados.ibge.gov.br/api/v3/malhas/" };

const dataUrl = (p: string) => `${import.meta.env.BASE_URL}data/${p}`;

export default function App() {
  const el = useRef<HTMLDivElement>(null);
  const viewer = useRef<Cesium.Viewer>();
  // chave "camada/codigo" -> DataSource já carregado
  const fontes = useRef(new Map<string, Cesium.GeoJsonDataSource>());
  const [munis, setMunis] = useState<Municipio[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [ativas, setAtivas] = useState<Record<Camada, boolean>>(
    { limite: true, rios: true, vias: true, edificacoes: false });
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [procedencia, setProcedencia] = useState<Record<string, Fonte>>({});
  const [contagem, setContagem] = useState<Record<string, number>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [terreno, setTerreno] = useState(false);

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
    });
    v.selectedEntityChanged.addEventListener((e) => {
      setInfo(e?.properties ? e.properties.getValue(Cesium.JulianDate.now()) : null);
    });
    viewer.current = v;
    if (import.meta.env.DEV) (window as unknown as { viewer: Cesium.Viewer }).viewer = v; // depuração
    fetch(dataUrl("municipios.json")).then((r) => r.json()).then(setMunis).catch((e) => setErro(String(e)));
    return () => v.destroy();
  }, []);

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
          const mostrar = ativas[c.id] && alvo.has(m.codigo_ibge);
          let ds = fontes.current.get(chave);
          if (mostrar && !ds) {
            const r = await fetch(dataUrl(`${m.codigo_ibge}/${c.id}.geojson`));
            // Camada ainda não baixada: servidores estáticos podem devolver HTML em vez de 404.
            if (!r.ok || !(r.headers.get("content-type") ?? "").match(/json/)) continue;
            const gj = await r.json();
            const cor = Cesium.Color.fromCssColorString(c.cor);
            ds = await Cesium.GeoJsonDataSource.load(gj, {
              stroke: cor, strokeWidth: c.id === "limite" ? 3 : 2,
              fill: cor.withAlpha(c.id === "limite" ? 0.08 : 0.6),
              clampToGround: true,
            });
            if (c.id === "limite") {
              // Polígonos colados ao terreno não desenham contorno: traça a borda como linha.
              for (const e of ds.entities.values) {
                const h = e.polygon?.hierarchy?.getValue(Cesium.JulianDate.now()) as Cesium.PolygonHierarchy | undefined;
                if (!h) continue;
                ds.entities.add({ polyline: { positions: [...h.positions, h.positions[0]], width: 3,
                  material: cor, clampToGround: true } });
              }
            }
            if (cancelado) return;
            await v.dataSources.add(ds);
            fontes.current.set(chave, ds);
            if (gj.fonte) setProcedencia((p) => ({ ...p, [c.id]: gj.fonte }));
          }
          if (ds) {
            ds.show = mostrar;
            if (mostrar) novaContagem[c.id] = (novaContagem[c.id] ?? 0) + ds.entities.values.filter((e) => e.properties).length;
          }
        }
      }
      if (!cancelado) setContagem(novaContagem);
    })().catch((e) => setErro(String(e)));
    return () => { cancelado = true; };
  }, [munis, sel, ativas]);

  // Enquadra a seleção.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !munis.length) return;
    const t = setTimeout(() => {
      const ents = visiveis().flatMap((m) => fontes.current.get(`limite/${m.codigo_ibge}`)?.entities.values ?? []);
      if (ents.length) v.flyTo(ents, { duration: 1.5 });
    }, 500);
    return () => clearTimeout(t);
  }, [munis, sel]);

  return (
    <div className="app">
      <div className="top"><h1>Gêmeos Digitais Regionais</h1>
        <span className="muted">Modo 1 — Realidade territorial</span>
        <span className="muted" style={{ marginLeft: "auto" }}>
          Relevo: {terreno ? "Cesium World Terrain" : "desligado (sem token)"}</span></div>
      <div className="main">
        <div className="side">
          <h2>Municípios</h2>
          <button className={sel === null ? "on" : ""} onClick={() => setSel(null)}>Região (todos)</button>
          {munis.map((m) => (
            <button key={m.codigo_ibge} className={sel === m.codigo_ibge ? "on" : ""}
              onClick={() => setSel(m.codigo_ibge)}>{m.nome}</button>
          ))}
          <h2 style={{ marginTop: 16 }}>Camadas</h2>
          {CAMADAS.map((c) => (
            <label key={c.id} className="layer">
              <input type="checkbox" checked={ativas[c.id]}
                onChange={(e) => setAtivas({ ...ativas, [c.id]: e.target.checked })} />
              <span className="swatch" style={{ background: c.cor }} />{c.nome}
              {ativas[c.id] && contagem[c.id] !== undefined && <span className="muted">({contagem[c.id]})</span>}
            </label>
          ))}
          {erro && <p className="muted">Erro: {erro}</p>}
        </div>
        <div className="map"><div ref={el} /></div>
        <div className="side right">
          <h2>Objeto selecionado</h2>
          {info ? (<table className="props"><tbody>{Object.entries(info).map(([k, val]) => (
            <tr key={k}><td>{k}</td><td>{String(val)}</td></tr>))}</tbody></table>)
            : <p className="muted">Clique em um elemento do mapa.</p>}
          <h2 style={{ marginTop: 16 }}>Procedência</h2>
          {[["limite", FONTE_IBGE] as const, ...Object.entries(procedencia).filter(([k]) => k !== "limite")]
            .map(([k, f]) => (
              <p key={k} className="muted"><b>{CAMADAS.find((c) => c.id === k)?.nome}</b><br />
                {f.nome} — {f.licenca}{f.obtido_em && <><br />Obtido em {f.obtido_em}</>}</p>))}
        </div>
      </div>
    </div>
  );
}
