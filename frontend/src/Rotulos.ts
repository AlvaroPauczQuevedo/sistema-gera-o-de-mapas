import * as Cesium from "cesium";

/* Estilo único dos rótulos e marcadores do mapa, para leitura sobre o mapa claro e o relevo.
 * O texto é desenhado com o dobro do tamanho e reduzido à metade (scale 0.5): o Cesium rasteriza
 * rótulos em bitmap, e isso evita o efeito "borrado" em telas comuns e de alta densidade. */

const FONTE = "600 30px 'Segoe UI', system-ui, sans-serif"; // equivale a ~15 px na tela
const FUNDO = Cesium.Color.fromCssColorString("#0b1220").withAlpha(0.86);

export function rotulo(texto: string, o: { distanciaMax?: number; deslocamentoY?: number; cor?: string; destaque?: boolean } = {}):
  Cesium.LabelGraphics.ConstructorOptions {
  return {
    text: texto, font: o.destaque ? "700 34px 'Segoe UI', system-ui, sans-serif" : FONTE, scale: 0.5,
    fillColor: Cesium.Color.fromCssColorString(o.cor ?? "#ffffff"),
    showBackground: true, backgroundColor: FUNDO, backgroundPadding: new Cesium.Cartesian2(14, 9),
    style: Cesium.LabelStyle.FILL, horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, o.deslocamentoY ?? -14),
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
    // um pouco menor de longe, tamanho cheio de perto
    scaleByDistance: new Cesium.NearFarScalar(1500, 1.0, 60000, 0.75),
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, o.distanciaMax ?? 15000),
  };
}

export function ponto(cor: string, o: { tamanho?: number; borda?: string; alfa?: number } = {}): Cesium.PointGraphics.ConstructorOptions {
  return {
    pixelSize: o.tamanho ?? 14, color: Cesium.Color.fromCssColorString(cor).withAlpha(o.alfa ?? 1),
    outlineColor: Cesium.Color.fromCssColorString(o.borda ?? "#ffffff"), outlineWidth: 2.5,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
    scaleByDistance: new Cesium.NearFarScalar(1500, 1.15, 80000, 0.8),
  };
}
