import { useEffect, useRef, useState } from "react";

export const HORA = 3.6e6;
export const chaveHora = (ms: number) => new Date(ms).toISOString().slice(0, 13);
export const horaCheia = (ms: number) => Math.floor(ms / HORA) * HORA;

export interface Marcador { t: number; rotulo: string; tipo: "observado" | "previsao" | "agora" }

const VELOCIDADES = [0.5, 1, 2, 4];
// 1x = 1 hora de dados por segundo de reprodução.
const HORAS_POR_SEGUNDO = 1;

const fmt = (ms: number) => new Date(ms).toLocaleString("pt-BR",
  { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Controlador temporal (seção 11). Anda em passos de 1 hora entre `inicio` e `fim`.
 * O trecho até `agora` é dado OBSERVADO; depois de `agora`, PREVISÃO — sempre identificado.
 */
export function LinhaDoTempo({ inicio, fim, agora, tempo, setTempo, marcadores, tempoA, setTempoA, etiqueta }: {
  inicio: number; fim: number; agora: number; tempo: number; setTempo: (t: number) => void;
  marcadores: Marcador[]; tempoA: number | null; setTempoA: (t: number | null) => void;
  /** Quando informado, substitui OBSERVADO/PREVISÃO (ex.: simulação). */
  etiqueta?: { texto: string; classe: string };
}) {
  const [tocando, setTocando] = useState(false);
  const [vel, setVel] = useState(1);
  const [intervalo, setIntervalo] = useState<[number, number]>([inicio, fim]);
  const acumulado = useRef(0);
  const ref = useRef(tempo);
  ref.current = tempo;

  useEffect(() => setIntervalo(([a, b]) => [Math.max(a, inicio), Math.min(b, fim)]), [inicio, fim]);

  useEffect(() => {
    if (!tocando) return;
    let ultimo = performance.now(), id = 0;
    const passo = (agoraMs: number) => {
      acumulado.current += ((agoraMs - ultimo) / 1000) * HORAS_POR_SEGUNDO * vel;
      ultimo = agoraMs;
      if (acumulado.current >= 1) {
        const n = Math.floor(acumulado.current);
        acumulado.current -= n;
        const prox = ref.current + n * HORA;
        if (prox > intervalo[1]) { setTempo(intervalo[1]); setTocando(false); return; }
        setTempo(prox);
      }
      id = requestAnimationFrame(passo);
    };
    id = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(id);
  }, [tocando, vel, intervalo, setTempo]);

  const total = fim - inicio || 1;
  const pct = (t: number) => `${(100 * (t - inicio)) / total}%`;
  const limitar = (t: number) => Math.min(intervalo[1], Math.max(intervalo[0], horaCheia(t)));
  const ehPrevisao = tempo > agora;

  return (
    <div className="tl">
      <div className="tl-controles">
        <button title="Reiniciar (início do intervalo)" onClick={() => { setTempo(intervalo[0]); }}>⏮</button>
        <button title="Recuar 1 h" onClick={() => setTempo(limitar(tempo - HORA))}>◀</button>
        <button className="tl-play" title={tocando ? "Pausar" : "Reproduzir"}
          onClick={() => { if (!tocando && tempo >= intervalo[1]) setTempo(intervalo[0]); setTocando(!tocando); }}>
          {tocando ? "❚❚" : "▶"}</button>
        <button title="Parar" onClick={() => { setTocando(false); setTempo(etiqueta ? inicio : agora); }}>■</button>
        <button title="Avançar 1 h" onClick={() => setTempo(limitar(tempo + HORA))}>▶▶</button>
        <span className="tl-vel">{VELOCIDADES.map((v) => (
          <button key={v} className={vel === v ? "on" : ""} onClick={() => setVel(v)}>{String(v).replace(".", ",")}x</button>))}</span>
        <span className="tl-hora">
          {etiqueta ? <span className={`tag ${etiqueta.classe}`}>{etiqueta.texto}</span>
            : <span className={`tag ${ehPrevisao ? "tag-prev" : "tag-obs"}`}>{ehPrevisao ? "PREVISÃO" : "OBSERVADO"}</span>}
          {fmt(tempo)}
        </span>
        <span className="tl-extra">
          <button title="Usar o momento atual como início do intervalo" onClick={() => setIntervalo([tempo, Math.max(tempo, intervalo[1])])}>[ início</button>
          <button title="Usar o momento atual como fim do intervalo" onClick={() => setIntervalo([Math.min(tempo, intervalo[0]), tempo])}>fim ]</button>
          <button title="Intervalo completo" onClick={() => setIntervalo([inicio, fim])}>tudo</button>
          <button title="Fixar este momento como A para comparação" className={tempoA !== null ? "on" : ""}
            onClick={() => setTempoA(tempoA === null ? tempo : null)}>{tempoA === null ? "comparar: fixar A" : "limpar A"}</button>
        </span>
      </div>
      <div className="tl-trilho"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const mover = (x: number) => { const r = el.getBoundingClientRect(); setTempo(limitar(inicio + ((x - r.left) / r.width) * total)); };
          mover(e.clientX);
          el.onpointermove = (ev) => mover(ev.clientX);
          el.onpointerup = () => { el.onpointermove = null; };
        }}>
        {etiqueta ? <div className="tl-sim" style={{ left: 0, right: 0 }} /> : <>
          <div className="tl-obs" style={{ left: 0, width: pct(agora) }} />
          <div className="tl-prev" style={{ left: pct(agora), right: 0 }} /></>}
        <div className="tl-int" style={{ left: pct(intervalo[0]), width: `calc(${pct(intervalo[1])} - ${pct(intervalo[0])})` }} />
        {marcadores.map((m) => (
          <div key={`${m.tipo}${m.t}`} className={`tl-marca tl-marca-${m.tipo}`} style={{ left: pct(m.t) }} title={`${fmt(m.t)} — ${m.rotulo}`} />))}
        {tempoA !== null && <div className="tl-a" style={{ left: pct(tempoA) }} title={`A: ${fmt(tempoA)}`}>A</div>}
        <div className="tl-cursor" style={{ left: pct(tempo) }} />
      </div>
      <div className="tl-rotulos">
        <span>{fmt(inicio)}</span>
        <span>{etiqueta ? "◆ pico do cenário" : "◆ chuva ≥ 5 mm/h · │ agora"}</span>
        <span>{fmt(fim)}</span>
      </div>
    </div>
  );
}
