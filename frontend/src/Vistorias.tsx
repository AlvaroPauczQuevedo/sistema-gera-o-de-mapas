import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------- Modelo (seção 15)
export type TipoRegistro = "vistoria" | "ocorrencia";
export type Condicao = "normal" | "atencao" | "risco" | "critico";
export const CONDICOES: Record<Condicao, { rotulo: string; cor: string; icone: string }> = {
  normal: { rotulo: "Sem alteração", cor: "#3fb950", icone: "✓" },
  atencao: { rotulo: "Atenção", cor: "#d29922", icone: "!" },
  risco: { rotulo: "Risco", cor: "#f0883e", icone: "▲" },
  critico: { rotulo: "Crítico / interditar", cor: "#f85149", icone: "✕" },
};
export const NATUREZAS = ["Encosta / deslizamento", "Queda de barreira", "Erosão", "Alagamento", "Inundação",
  "Via danificada", "Ponte / bueiro", "Edificação danificada", "Queda de árvore", "Rede elétrica",
  "Vendaval / granizo", "Abrigo oficial / local de acolhimento", "Outro"];
export const NATUREZA_ABRIGO = "Abrigo oficial / local de acolhimento";

export interface Acompanhamento { em: string; responsavel: string; texto: string }
export interface Registro {
  id: string; tipo: TipoRegistro; natureza: string; codigo_ibge: number | null;
  local: string; lat: number; lon: number; precisao_m: number | null; origem_coord: "gps" | "mapa";
  data_hora: string; responsavel: string; descricao: string; condicao: Condicao;
  providencias: string; requer_providencia: boolean; fotos: string[]; // data URLs JPEG
  historico: Acompanhamento[]; situacao: "aberto" | "encerrado";
  capacidade_pessoas?: number | null; // abrigos
  telefone?: string;
  criado_em: string; atualizado_em: string;
}

// ---------------------------------------------------------------- IndexedDB (offline, neste dispositivo)
const BANCO = "gemeos-campo", LOJA = "registros";
function abrir(): Promise<IDBDatabase> {
  return new Promise((ok, erro) => {
    const r = indexedDB.open(BANCO, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(LOJA, { keyPath: "id" });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
}
async function tx<T>(modo: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await abrir();
  return new Promise((ok, erro) => {
    const req = f(db.transaction(LOJA, modo).objectStore(LOJA));
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

export function useRegistros() {
  const [registros, setRegistros] = useState<Registro[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const recarregar = useCallback(() => tx<Registro[]>("readonly", (s) => s.getAll())
    .then((r) => setRegistros(r.sort((a, b) => b.data_hora.localeCompare(a.data_hora))))
    .catch((e) => setErro(`Armazenamento local indisponível: ${e}`)), []);
  useEffect(() => { recarregar(); }, [recarregar]);
  const salvar = async (r: Registro) => { await tx("readwrite", (s) => s.put(r)); await recarregar(); };
  const remover = async (id: string) => { await tx("readwrite", (s) => s.delete(id)); await recarregar(); };
  const importar = async (arquivo: File) => {
    const gj = JSON.parse(await arquivo.text());
    let n = 0;
    for (const f of gj.features ?? []) {
      const p = f.properties as Registro;
      if (!p?.id || !f.geometry?.coordinates) continue;
      const atual = registros.find((r) => r.id === p.id);
      if (atual && atual.atualizado_em >= p.atualizado_em) continue; // mantém a versão mais recente
      await tx("readwrite", (s) => s.put({ ...p, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
      n++;
    }
    await recarregar();
    return n;
  };
  return { registros, erro, salvar, remover, importar };
}

export function paraGeoJSON(rs: Registro[], comFotos = true) {
  return {
    type: "FeatureCollection",
    features: rs.map((r) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: comFotos ? r : { ...r, fotos: [], n_fotos: r.fotos.length },
    })),
    gerado_em: new Date().toISOString(),
    aviso: "Registros de campo. Dados pessoais (responsável) — tratar conforme a LGPD.",
  };
}

export function baixarArquivo(nome: string, conteudo: string, tipo: string) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nome });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reduz a foto para no máx. 1280 px (JPEG) para caber no armazenamento do celular. */
async function comprimir(arquivo: File): Promise<string> {
  const img = await createImageBitmap(arquivo);
  const k = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement("canvas"), { width: img.width * k, height: img.height * k });
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}

const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const agoraLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------- Formulário
export function FormRegistro({ inicial, ponto, municipioDoPonto, nomes, onPedirMapa, onSalvar, onCancelar, onExcluir }: {
  inicial: Registro | null; ponto: { lat: number; lon: number; precisao_m: number | null; origem: "gps" | "mapa" } | null;
  municipioDoPonto: (lat: number, lon: number) => number | null; nomes: Record<number, string>;
  onPedirMapa: () => void; onSalvar: (r: Registro) => Promise<void>; onCancelar: () => void;
  onExcluir: (id: string) => Promise<void>;
}) {
  const [r, setR] = useState<Registro>(() => inicial ?? {
    id: novoId(), tipo: "vistoria", natureza: NATUREZAS[0], codigo_ibge: null, local: "", lat: NaN, lon: NaN,
    precisao_m: null, origem_coord: "mapa", data_hora: agoraLocal(), responsavel: localStorageGet("responsavel"),
    descricao: "", condicao: "atencao", providencias: "", requer_providencia: false, fotos: [], historico: [],
    situacao: "aberto", criado_em: "", atualizado_em: "",
  });
  const [gps, setGps] = useState<string | null>(null);
  const [novoAcomp, setNovoAcomp] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [confirmaExcluir, setConfirmaExcluir] = useState(false);
  const set = <K extends keyof Registro>(k: K, v: Registro[K]) => setR((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!ponto) return;
    setR((x) => ({ ...x, lat: ponto.lat, lon: ponto.lon, precisao_m: ponto.precisao_m, origem_coord: ponto.origem,
      codigo_ibge: municipioDoPonto(ponto.lat, ponto.lon) }));
  }, [ponto]);

  const usarGps = () => {
    if (!navigator.geolocation) return setGps("GPS indisponível neste aparelho.");
    setGps("Obtendo posição…");
    navigator.geolocation.getCurrentPosition(
      (p) => { setGps(null); setR((x) => ({ ...x, lat: p.coords.latitude, lon: p.coords.longitude,
        precisao_m: Math.round(p.coords.accuracy), origem_coord: "gps",
        codigo_ibge: municipioDoPonto(p.coords.latitude, p.coords.longitude) })); },
      (e) => setGps(`Não foi possível obter o GPS: ${e.message}`), { enableHighAccuracy: true, timeout: 20000 });
  };

  const temCoord = isFinite(r.lat) && isFinite(r.lon);
  const valido = temCoord && r.responsavel.trim() && r.descricao.trim() && r.data_hora;

  const salvar = async () => {
    if (!valido) return;
    setSalvando(true);
    const agora = new Date().toISOString();
    const historico = novoAcomp.trim()
      ? [...r.historico, { em: agora, responsavel: r.responsavel, texto: novoAcomp.trim() }] : r.historico;
    localStorageSet("responsavel", r.responsavel);
    await onSalvar({ ...r, historico, data_hora: new Date(r.data_hora).toISOString(),
      criado_em: r.criado_em || agora, atualizado_em: agora });
    setSalvando(false);
  };

  return (<div className="form">
    <h2>{inicial ? "Editar registro" : "Novo registro de campo"}</h2>
    <div className="seg">{(["vistoria", "ocorrencia"] as TipoRegistro[]).map((t) => (
      <button key={t} className={r.tipo === t ? "on" : ""} onClick={() => set("tipo", t)}>{t === "vistoria" ? "Vistoria" : "Ocorrência"}</button>))}</div>

    <label>Localização *</label>
    <div className="linha">
      <button onClick={usarGps}>📍 Usar GPS</button>
      <button onClick={onPedirMapa}>🗺 Marcar no mapa</button>
    </div>
    {gps && <p className="muted">{gps}</p>}
    <p className="muted">{temCoord ? <>{r.lat.toFixed(6)}, {r.lon.toFixed(6)} · {r.origem_coord === "gps"
      ? `GPS ±${r.precisao_m ?? "?"} m` : "marcado no mapa"} · {r.codigo_ibge ? nomes[r.codigo_ibge] : "fora dos municípios cadastrados"}</>
      : "Sem coordenadas ainda."}</p>

    <label>Endereço / referência do local</label>
    <input value={r.local} onChange={(e) => set("local", e.target.value)} placeholder="Ex.: Linha Ely, km 3, próximo à ponte" />

    <div className="duas">
      <div><label>Natureza</label>
        <select value={r.natureza} onChange={(e) => set("natureza", e.target.value)}>
          {NATUREZAS.map((n) => <option key={n}>{n}</option>)}</select></div>
      <div><label>Data e hora *</label>
        <input type="datetime-local" value={r.data_hora.length > 16 ? toLocalInput(r.data_hora) : r.data_hora}
          onChange={(e) => set("data_hora", e.target.value)} /></div>
    </div>

    {r.natureza === NATUREZA_ABRIGO && (<div className="duas">
      <div><label>Capacidade (pessoas)</label><input type="number" min={0} value={r.capacidade_pessoas ?? ""}
        onChange={(e) => set("capacidade_pessoas", e.target.value === "" ? null : +e.target.value)} /></div>
      <div><label>Telefone de contato</label><input value={r.telefone ?? ""} onChange={(e) => set("telefone", e.target.value)} /></div>
    </div>)}

    <label>Responsável *</label>
    <input value={r.responsavel} onChange={(e) => set("responsavel", e.target.value)} placeholder="Nome e órgão" />

    <label>Condição encontrada</label>
    <div className="seg">{(Object.keys(CONDICOES) as Condicao[]).map((c) => (
      <button key={c} className={r.condicao === c ? "on" : ""} style={r.condicao === c ? { borderColor: CONDICOES[c].cor } : {}}
        onClick={() => set("condicao", c)}><span style={{ color: CONDICOES[c].cor }}>{CONDICOES[c].icone}</span> {CONDICOES[c].rotulo}</button>))}</div>

    <label>Descrição *</label>
    <textarea rows={4} value={r.descricao} onChange={(e) => set("descricao", e.target.value)} />

    <label className="layer"><input type="checkbox" checked={r.requer_providencia}
      onChange={(e) => set("requer_providencia", e.target.checked)} />Necessita providências</label>
    {r.requer_providencia && <textarea rows={2} value={r.providencias} placeholder="Quais providências?"
      onChange={(e) => set("providencias", e.target.value)} />}

    <label>Fotografias ({r.fotos.length})</label>
    <input type="file" accept="image/*" capture="environment" multiple onChange={async (e) => {
      const fs = await Promise.all(Array.from(e.target.files ?? []).map(comprimir));
      set("fotos", [...r.fotos, ...fs]);
      e.target.value = "";
    }} />
    <div className="fotos">{r.fotos.map((f, i) => (
      <div key={i}><img src={f} alt={`foto ${i + 1}`} />
        <button title="Remover foto" onClick={() => set("fotos", r.fotos.filter((_, j) => j !== i))}>✕</button></div>))}</div>

    {inicial && (<>
      <label>Situação</label>
      <div className="seg">{(["aberto", "encerrado"] as const).map((s) => (
        <button key={s} className={r.situacao === s ? "on" : ""} onClick={() => set("situacao", s)}>{s === "aberto" ? "Em aberto" : "Encerrado"}</button>))}</div>
      <label>Histórico de acompanhamento</label>
      {r.historico.length ? r.historico.map((h, i) => (
        <p key={i} className="muted">{fmt(h.em)} — {h.responsavel}: {h.texto}</p>)) : <p className="muted">Sem acompanhamentos.</p>}
    </>)}
    <label>{inicial ? "Novo acompanhamento" : "Observação inicial (opcional)"}</label>
    <textarea rows={2} value={novoAcomp} onChange={(e) => setNovoAcomp(e.target.value)} />

    <div className="linha" style={{ marginTop: 12 }}>
      <button className="primario" disabled={!valido || salvando} onClick={salvar}>{salvando ? "Salvando…" : "Salvar"}</button>
      <button onClick={onCancelar}>Cancelar</button>
      {inicial && <button className={confirmaExcluir ? "perigo" : ""}
        onClick={() => (confirmaExcluir ? onExcluir(r.id) : setConfirmaExcluir(true))}>
        {confirmaExcluir ? "Confirmar exclusão" : "Excluir"}</button>}
    </div>
    {confirmaExcluir && <p className="muted">A exclusão apaga o registro deste aparelho e não pode ser desfeita.
      Para manter o histórico, prefira marcar como "Encerrado".</p>}
    {!valido && <p className="muted">* Preencha localização, responsável, data e descrição.</p>}
    <p className="muted">Salvo neste aparelho (funciona sem internet). Use "Exportar" para enviar à coordenação.</p>
  </div>);
}

// ---------------------------------------------------------------- Lista
export function ListaRegistros({ registros, nomes, sel, onAbrir, onNovo, onImportar, onIrPara }: {
  registros: Registro[]; nomes: Record<number, string>; sel: number | null;
  onAbrir: (r: Registro) => void; onNovo: () => void; onImportar: (f: File) => void; onIrPara: (r: Registro) => void;
}) {
  const [filtro, setFiltro] = useState<"aberto" | "todos">("aberto");
  const lista = registros.filter((r) => (sel === null || r.codigo_ibge === sel) && (filtro === "todos" || r.situacao === "aberto"));
  const exportar = (comFotos: boolean) => baixarArquivo(`registros-campo-${new Date().toISOString().slice(0, 10)}.geojson`,
    JSON.stringify(paraGeoJSON(lista, comFotos)), "application/geo+json");
  const csv = () => {
    const cols: (keyof Registro)[] = ["id", "tipo", "natureza", "codigo_ibge", "local", "lat", "lon", "data_hora", "responsavel",
      "condicao", "descricao", "requer_providencia", "providencias", "situacao", "atualizado_em"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const linhas = [cols.join(";"), ...lista.map((r) => cols.map((c) => esc(c === "codigo_ibge" && r.codigo_ibge ? `${r.codigo_ibge} ${nomes[r.codigo_ibge]}` : r[c])).join(";"))];
    baixarArquivo(`registros-campo-${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + linhas.join("\n"), "text/csv");
  };
  return (<>
    <div className="linha"><button className="primario" onClick={onNovo}>+ Nova vistoria / ocorrência</button></div>
    <div className="seg" style={{ marginTop: 8 }}>
      <button className={filtro === "aberto" ? "on" : ""} onClick={() => setFiltro("aberto")}>Em aberto</button>
      <button className={filtro === "todos" ? "on" : ""} onClick={() => setFiltro("todos")}>Todos</button>
    </div>
    {lista.length ? lista.map((r) => (
      <div key={r.id} className="registro" onClick={() => onAbrir(r)}>
        <span className="cond" style={{ background: CONDICOES[r.condicao].cor }}>{CONDICOES[r.condicao].icone}</span>
        <div><b>{r.natureza}</b> <span className="tag">{r.tipo === "vistoria" ? "VISTORIA" : "OCORRÊNCIA"}</span>
          {r.situacao === "encerrado" && <span className="tag">ENCERRADO</span>}<br />
          <span className="muted">{fmt(r.data_hora)} · {r.codigo_ibge ? nomes[r.codigo_ibge] : "—"} · {r.responsavel}</span><br />
          <span className="muted">{CONDICOES[r.condicao].rotulo}{r.requer_providencia ? " · requer providência" : ""}
            {r.fotos.length ? ` · ${r.fotos.length} foto(s)` : ""}</span></div>
        <button title="Ver no mapa" onClick={(e) => { e.stopPropagation(); onIrPara(r); }}>◎</button>
      </div>)) : <p className="muted">Nenhum registro {filtro === "aberto" ? "em aberto " : ""}{sel !== null ? "neste município" : ""}.</p>}
    <h2 style={{ marginTop: 16 }}>Compartilhar</h2>
    <div className="linha">
      <button onClick={() => exportar(true)}>Exportar GeoJSON (com fotos)</button>
      <button onClick={() => exportar(false)}>GeoJSON sem fotos</button>
      <button onClick={csv}>Planilha CSV</button>
    </div>
    <label className="importar">Importar registros de outra equipe (GeoJSON)
      <input type="file" accept=".geojson,.json,application/geo+json,application/json"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportar(f); e.target.value = ""; }} /></label>
    <p className="muted">Ainda não há servidor central: os registros ficam no aparelho de quem os criou. Exporte e envie à
      coordenação, que importa e consolida (prevalece a versão editada mais recentemente).</p>
  </>);
}

function localStorageGet(k: string) { try { return localStorage.getItem(`gemeos:${k}`) ?? ""; } catch { return ""; } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(`gemeos:${k}`, v); } catch { /* sem storage */ } }
function toLocalInput(iso: string) { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
