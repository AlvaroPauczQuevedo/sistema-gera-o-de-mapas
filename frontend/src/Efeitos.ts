import * as Cesium from "cesium";

/* ===================================================================================
 * Efeitos visuais da simulação: nuvens, chuva e deslizamentos.
 * ILUSTRAÇÃO — a intensidade segue os dados do cenário, mas a forma das partículas,
 * nuvens e da terra caindo NÃO representa a física dos fenômenos.
 * =================================================================================== */

const MAX_GOTAS_S = 1800;
let rajadasAtivas = 0;
const MAX_RAJADAS = 5;

function textura(w: number, h: number, desenhar: (c: CanvasRenderingContext2D) => void) {
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  desenhar(c.getContext("2d")!);
  return c;
}
const GOTA = textura(4, 24, (c) => {
  const g = c.createLinearGradient(0, 0, 0, 24);
  g.addColorStop(0, "rgba(200,225,255,0)"); g.addColorStop(1, "rgba(200,225,255,0.85)");
  c.fillStyle = g; c.fillRect(1, 0, 2, 24);
});
const TERRA = textura(16, 16, (c) => {
  const g = c.createRadialGradient(8, 8, 1, 8, 8, 8);
  g.addColorStop(0, "rgba(120,80,40,1)"); g.addColorStop(0.7, "rgba(95,62,30,0.9)"); g.addColorStop(1, "rgba(80,50,25,0)");
  c.fillStyle = g; c.beginPath(); c.arc(8, 8, 8, 0, Math.PI * 2); c.fill();
});

/** Pseudoaleatório determinístico (as nuvens ficam sempre no mesmo lugar). */
function rnd(semente: number) { let s = semente; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

export class Tempestade {
  private nuvens: Cesium.CloudCollection;
  private lista: Cesium.CumulusCloud[] = [];
  private chuva: Cesium.ParticleSystem;
  private caixa: Cesium.BoxEmitter;
  private intensidade = 0;
  private removerTick: () => void;

  constructor(private viewer: Cesium.Viewer, ret: { oeste: number; sul: number; leste: number; norte: number }, altitudeNuvem = 2600) {
    const cx = (ret.oeste + ret.leste) / 2, cy = (ret.sul + ret.norte) / 2;
    // Partículas avançam com o relógio do Cesium (parado por padrão quando não há widget de animação).
    // Passo fixo por quadro: com relógio de tempo real, uma aba que volta do segundo plano recebe um
    // "dt" de minutos e o sistema tenta emitir milhões de gotas de uma vez (trava o navegador).
    viewer.clock.clockStep = Cesium.ClockStep.TICK_DEPENDENT;
    viewer.clock.multiplier = 1 / 60;
    viewer.clock.shouldAnimate = true;
    this.nuvens = viewer.scene.primitives.add(new Cesium.CloudCollection({ noiseDetail: 16 }));
    const r = rnd(42);
    for (let i = 0; i < 30; i++) {
      const lon = ret.oeste - 0.05 + r() * (ret.leste - ret.oeste + 0.1);
      const lat = ret.sul - 0.03 + r() * (ret.norte - ret.sul + 0.06);
      const tam = 3500 + r() * 5000;
      this.lista.push(this.nuvens.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, altitudeNuvem + r() * 600),
        scale: new Cesium.Cartesian2(tam, tam * 0.45),
        maximumSize: new Cesium.Cartesian3(50, 16, 14), slice: 0.36 + r() * 0.1, brightness: 1, show: false,
      }));
    }
    // Chuva: caixa emissora acompanha o ponto para onde a câmera olha (visível em qualquer zoom);
    // as gotas caem na direção do centro da Terra.
    const queda = 320; // m/s — acelerado para ser visível na escala regional
    const ALT_CHUVA = 900; // m acima do terreno (vida curta = menos partículas simultâneas)
    this.caixa = new Cesium.BoxEmitter(new Cesium.Cartesian3(8000, 8000, 50));
    this.chuva = viewer.scene.primitives.add(new Cesium.ParticleSystem({
      image: GOTA, imageSize: new Cesium.Cartesian2(3, 18), sizeInMeters: false,
      startColor: Cesium.Color.WHITE.withAlpha(0.8), endColor: Cesium.Color.WHITE.withAlpha(0.6),
      minimumParticleLife: ALT_CHUVA / queda * 0.8, maximumParticleLife: ALT_CHUVA / queda,
      emissionRate: 0, lifetime: Number.MAX_VALUE, loop: true,
      emitter: this.caixa,
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(cx, cy, altitudeNuvem)),
      updateCallback: (p) => {
        const baixo = Cesium.Cartesian3.normalize(p.position, new Cesium.Cartesian3());
        Cesium.Cartesian3.multiplyByScalar(baixo, -queda, p.velocity);
      },
    }));
    // Nuvens derivam lentamente para leste.
    let ultimo = performance.now();
    this.removerTick = viewer.scene.preUpdate.addEventListener(() => {
      const agora = performance.now(), dt = (agora - ultimo) / 1000;
      ultimo = agora;
      if (!this.nuvens.show) return;
      // reposiciona a chuva sob o centro da tela, a ALT_CHUVA m do chão
      const cena = viewer.scene, tela = new Cesium.Cartesian2(cena.canvas.clientWidth / 2, cena.canvas.clientHeight / 2);
      const raio = viewer.camera.getPickRay(tela);
      const alvo = raio && cena.globe.pick(raio, cena);
      if (alvo) {
        const g = Cesium.Cartographic.fromCartesian(alvo);
        const dist = Cesium.Cartesian3.distance(viewer.camera.position, alvo);
        const lado = Math.min(60000, Math.max(2500, dist * 1.6));
        this.caixa.dimensions = new Cesium.Cartesian3(lado, lado, 50);
        this.chuva.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
          Cesium.Cartesian3.fromRadians(g.longitude, g.latitude, (g.height ?? 0) + ALT_CHUVA));
      }
      for (const n of this.lista) {
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(n.position);
        const leste = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian4());
        n.position = Cesium.Cartesian3.add(n.position,
          Cesium.Cartesian3.multiplyByScalar(new Cesium.Cartesian3(leste.x, leste.y, leste.z), 25 * dt, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      }
    });
  }

  /** Intensidade em mm/h (chuva) e cobertura de nuvens 0–1. */
  definir(mmh: number, cobertura: number) {
    this.intensidade = mmh;
    const n = Math.round(Math.min(1, cobertura) * this.lista.length);
    const brilho = Math.max(0.3, 1 - Math.min(mmh, 30) / 40); // nuvem mais escura com mais chuva
    this.lista.forEach((c, i) => { c.show = i < n; c.brightness = brilho; });
    // Teto de emissão: acima disso o navegador entra em espiral (quadro lento -> mais partículas por quadro).
    this.chuva.emissionRate = mmh < 0.05 ? 0 : Math.min(MAX_GOTAS_S, 300 + mmh * 120);
  }

  mostrar(v: boolean) {
    this.nuvens.show = v; this.chuva.show = v;
    if (!v) this.chuva.emissionRate = 0; else this.definir(this.intensidade, this.lista.filter((c) => c.show).length / this.lista.length);
  }

  destruir() {
    this.removerTick();
    this.viewer.scene.primitives.remove(this.nuvens);
    this.viewer.scene.primitives.remove(this.chuva);
  }
}

/** Direção encosta abaixo (vetor no referencial terrestre) a partir de amostras do terreno. */
export async function direcaoEncosta(viewer: Cesium.Viewer, lon: number, lat: number) {
  const d = 0.0004; // ~40 m
  const pts = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]
    .map(([x, y]) => Cesium.Cartographic.fromDegrees(lon + x, lat + y));
  let alt: Cesium.Cartographic[] = pts;
  try { alt = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, pts); } catch { /* sem relevo: usa 0 */ }
  const centro = alt[0];
  const menor = alt.slice(1).reduce((a, b) => ((b.height ?? 0) < (a.height ?? 0) ? b : a));
  const p0 = Cesium.Cartesian3.fromRadians(centro.longitude, centro.latitude, centro.height ?? 0);
  const p1 = Cesium.Cartesian3.fromRadians(menor.longitude, menor.latitude, menor.height ?? 0);
  return { origem: p0, direcao: Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(p1, p0, new Cesium.Cartesian3()), new Cesium.Cartesian3()) };
}

/** Rajada de terra descendo a encosta (ilustração). */
export function animarDeslizamento(viewer: Cesium.Viewer, origem: Cesium.Cartesian3, direcao: Cesium.Cartesian3, intensidade = 1) {
  if (rajadasAtivas >= MAX_RAJADAS) return; // evita sobrecarga quando muitos setores ativam juntos
  rajadasAtivas++;
  const sistema = viewer.scene.primitives.add(new Cesium.ParticleSystem({
    image: TERRA, sizeInMeters: true, minimumImageSize: new Cesium.Cartesian2(6, 6), maximumImageSize: new Cesium.Cartesian2(18, 18),
    startColor: Cesium.Color.fromCssColorString("#8a5a2b"), endColor: Cesium.Color.fromCssColorString("#5c3b1c").withAlpha(0.15),
    minimumParticleLife: 2.5, maximumParticleLife: 5, minimumSpeed: 4, maximumSpeed: 14,
    emissionRate: 0, lifetime: 6, loop: false,
    bursts: [new Cesium.ParticleBurst({ time: 0, minimum: 120 * intensidade, maximum: 220 * intensidade }),
      new Cesium.ParticleBurst({ time: 0.8, minimum: 80 * intensidade, maximum: 140 * intensidade })],
    emitter: new Cesium.CircleEmitter(18),
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(origem),
    updateCallback: (p, dt) => {
      const gravidade = Cesium.Cartesian3.multiplyByScalar(Cesium.Cartesian3.normalize(p.position, new Cesium.Cartesian3()), -9.8 * dt, new Cesium.Cartesian3());
      const encosta = Cesium.Cartesian3.multiplyByScalar(direcao, 22 * dt, new Cesium.Cartesian3());
      Cesium.Cartesian3.add(p.velocity, gravidade, p.velocity);
      Cesium.Cartesian3.add(p.velocity, encosta, p.velocity);
    },
  }));
  const poeira = viewer.scene.primitives.add(new Cesium.ParticleSystem({
    image: TERRA, sizeInMeters: true, minimumImageSize: new Cesium.Cartesian2(30, 30), maximumImageSize: new Cesium.Cartesian2(70, 70),
    startColor: Cesium.Color.fromCssColorString("#a07850").withAlpha(0.35), endColor: Cesium.Color.fromCssColorString("#a07850").withAlpha(0),
    minimumParticleLife: 3, maximumParticleLife: 6, minimumSpeed: 1, maximumSpeed: 4, emissionRate: 25, lifetime: 4, loop: false,
    emitter: new Cesium.CircleEmitter(30), modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(origem),
  }));
  setTimeout(() => { viewer.scene.primitives.remove(sistema); viewer.scene.primitives.remove(poeira); rajadasAtivas--; }, 9000);
}
