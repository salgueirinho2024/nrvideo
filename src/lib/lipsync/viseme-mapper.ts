import type { VisemeShape, VisemeTimeline, MouthCue, MouthState } from "./types";

/**
 * Fase 1: você tem 3 assets de boca hoje (closed/half/open — ver
 * public/mascot/). Em vez de esperar por um rig em camadas com 9 bocas
 * (Fase 2, ver README-LIPSYNC.md), mapeamos os 9 visemas Preston Blair para
 * o estado mais próximo entre os 3 que já existem. Isso já é uma melhoria
 * real: a boca agora abre/fecha no tempo certo dos fonemas de verdade, em
 * vez de um ciclo artificial de 4 passos amarrado a "tem som ou não".
 */
const SHAPE_TO_STATE: Record<VisemeShape, MouthState> = {
  X: "closed", // silêncio
  A: "closed", // P, B, M — lábios fechados
  B: "half", // K, G, N, D, T, S, Z
  C: "half", // CH, J, SH
  D: "open", // vogal A — boca bem aberta
  E: "half", // vogal E — boca semi-aberta
  F: "half", // F, V — dente no lábio (mais próximo de "half" que "open")
  G: "open", // vogal U/O arredondada
  H: "half", // L
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

  // Descarta cues extremamente curtos (< 50ms) fundindo-os no vizinho
  // anterior — evita jitter perceptível em trechos de fala muito rápida.
  const MIN_DURATION = 0.05;
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
