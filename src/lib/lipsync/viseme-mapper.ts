import type { VisemeShape, VisemeTimeline, MouthCue, MouthState } from "./types";

/**
 * Mapeamento 1:1 — cada um dos 9 visemas Preston Blair que o Rhubarb produz
 * tem hoje um asset de boca próprio (public/mascot/, gerado por
 * scripts/generate-mascot-visemes.mjs), então não precisamos mais colapsar
 * pra um conjunto reduzido de estados (isso era a Fase 1 antiga, com só
 * 3 bocas — closed/half/open). X e A compartilham o mesmo asset porque são
 * visualmente idênticos (lábios fechados em repouso).
 */
const SHAPE_TO_STATE: Record<VisemeShape, MouthState> = {
  X: "closed", // silêncio
  A: "closed", // P, B, M — lábios fechados
  B: "halfTeeth", // K, G, N, D, T, S, Z
  C: "chOpen", // CH, J, SH
  D: "wideOpen", // vogal A — boca bem aberta
  E: "stretchE", // vogal E — boca semi-aberta, esticada
  F: "teethLip", // F, V — dente no lábio
  G: "roundO", // vogal U/O arredondada
  H: "tongueL", // L
};

/**
 * Converte a timeline de visemas em cues de MouthState, já mesclando
 * intervalos consecutivos com o mesmo estado (menos cortes de overlay no
 * FFmpeg = filtro mais leve e menos chance de "flicker" por arredondamento
 * de ponto flutuante entre dois cues idênticos adjacentes).
 */
export function mapVisemesToMouthStates(timeline: VisemeTimeline): MouthCue[] {
  const raw: MouthCue[] = timeline.cues.map((c) => ({
    start: c.start,
    end: c.end,
    state: SHAPE_TO_STATE[c.shape],
  }));

  const merged: MouthCue[] = [];
  for (const cue of raw) {
    const last = merged[merged.length - 1];
    if (last && last.state === cue.state && Math.abs(last.end - cue.start) < 1e-3) {
      last.end = cue.end;
    } else {
      merged.push({ ...cue });
    }
  }

  // Descarta cues extremamente curtos fundindo-os no vizinho anterior —
  // evita jitter perceptível em trechos de fala muito rápida. 90ms é o
  // limiar de troca de boca que ainda é visualmente perceptível numa
  // animação; abaixo disso a troca não dá tempo de "ser vista" mesmo sem
  // fundir. Subido de 50ms pra 90ms também tem um efeito colateral bom:
  // reduz bastante o número de cues nas cenas de narração mais longa
  // (tipicamente as cenas com vídeo de banco), que é o que alimenta o
  // limite de segurança do render.ts (MAX_MOUTH_CUES_IN_FILTER).
  const MIN_DURATION = 0.09;
  const smoothed: MouthCue[] = [];
  for (const cue of merged) {
    const duration = cue.end - cue.start;
    if (duration < MIN_DURATION && smoothed.length > 0) {
      smoothed[smoothed.length - 1].end = cue.end;
    } else {
      smoothed.push(cue);
    }
  }

  return smoothed;
}
