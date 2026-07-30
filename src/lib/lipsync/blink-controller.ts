import type { BlinkEvent } from "./types";

/**
 * FASE 2 — pronto em código, ainda não ligado ao render.ts.
 *
 * Piscar exige uma camada de olhos separada da boca (public/mascot/rig/
 * eyes-open.png / eyes-closed.png) para não precisar de 1 foto por
 * combinação de boca+olho. Como os assets atuais (mouth-*.png) são fotos
 * de rosto inteiro, não há hoje uma camada de olho isolada — ver
 * README-LIPSYNC.md, seção "Fase 2", para o plano de fatiamento dos
 * assets. Este controlador já gera a timeline de piscadas corretamente,
 * então quando os assets existirem, a integração é só consumir esta saída
 * no frame-compositor (também já projetado no README).
 *
 * Humanos piscam a cada 2-6s (média ~4s), com duração de 100-400ms. Um
 * intervalo fixo pareceria robótico; usamos jitter dentro de uma faixa
 * realista, com seed determinística por cena (mesma cena → mesma timeline,
 * importante para reprocessamento idempotente do Inngest).
 */
export class BlinkController {
  constructor(private seed: number = 42) {}

  generate(durationSeconds: number): BlinkEvent[] {
    const rng = this.seededRng(this.seed);
    const events: BlinkEvent[] = [];
    let t = 1 + rng() * 2;

    while (t < durationSeconds - 0.3) {
      events.push({ time: t, durationMs: 120 + rng() * 100 });
      t += 2.2 + rng() * 3.2;
    }
    return events;
  }

  private seededRng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }
}
