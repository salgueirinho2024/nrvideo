import type { HeadPose } from "./types";

const MAX_ROTATION_DEG = 2.2; // sutil de propósito — mais que isso parece "balançando"
const MAX_OFFSET_PX = 4;

/**
 * Movimento de cabeça sutil por soma de senoides com frequências não
 * múltiplas entre si (evita o padrão "robô balançando" de uma única onda) —
 * é o equivalente barato de ruído procedural (tipo Perlin) sem dependência
 * extra, suficiente para um deslocamento tão pequeno.
 */
export class HeadMotionController {
  /** FASE 2: timeline discreta por frame, para quando o compositor em
   *  camadas existir (ver README-LIPSYNC.md). */
  generate(durationSeconds: number, fps: number): HeadPose[] {
    const poses: HeadPose[] = [];
    const step = 1 / fps;
    for (let t = 0; t <= durationSeconds; t += step) {
      poses.push({ time: t, ...this.poseAt(t) });
    }
    return poses;
  }

  private poseAt(t: number) {
    const rotationDeg =
      Math.sin(t * 0.7) * MAX_ROTATION_DEG * 0.6 +
      Math.sin(t * 1.9 + 1.3) * MAX_ROTATION_DEG * 0.4;
    const offsetX = Math.sin(t * 0.5 + 0.4) * MAX_OFFSET_PX;
    const offsetY = Math.sin(t * 0.9 + 2.1) * MAX_OFFSET_PX * 0.5;
    return { rotationDeg, offsetX, offsetY };
  }

  /**
   * FASE 1 — já ligada ao render.ts: em vez de pré-renderizar frames,
   * geramos a MESMA curva de movimento como uma expressão matemática que o
   * próprio filtro `rotate` do FFmpeg calcula em tempo real por frame
   * (variável `t` = tempo em segundos, nativa do FFmpeg). Isso dá o
   * "respirar"/leve balanço de cabeça sem precisar de nenhum PNG novo nem
   * de pipeline de composição em canvas — só um filtro a mais na cadeia
   * que já existe.
   */
  buildFfmpegRotateExpr(): string {
    // Ângulo em RADIANOS (rotate do FFmpeg espera radianos, não graus).
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const a1 = toRad(MAX_ROTATION_DEG * 0.6);
    const a2 = toRad(MAX_ROTATION_DEG * 0.4);
    return `(${a1.toFixed(5)}*sin(0.7*t)+${a2.toFixed(5)}*sin(1.9*t+1.3))`;
  }
}
