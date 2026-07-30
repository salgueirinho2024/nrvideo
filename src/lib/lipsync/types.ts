// Tipos centrais do sistema de lip sync. Ver README-LIPSYNC.md para a
// arquitetura completa (Fase 1 = já ligado ao render.ts; Fase 2 = pronto em
// código, aguardando assets de rig em camadas).

/** Visemas no padrão Preston Blair — é o que o Rhubarb Lip Sync produz.
 *  9 formas cobrem qualquer fonema do português/inglês com fidelidade
 *  suficiente para animação 2D. */
export type VisemeShape = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "X";

export interface VisemeCue {
  /** tempo em segundos, relativo ao início do áudio da cena */
  start: number;
  end: number;
  shape: VisemeShape;
}

export interface VisemeTimeline {
  sceneId: string;
  durationSeconds: number;
  cues: VisemeCue[];
  /** "rhubarb" = fonemas reais extraídos do áudio; "heuristic" = fallback
   *  usado quando o binário do Rhubarb não está disponível no ambiente
   *  (ver phoneme-service.ts). Persistido para saber a qualidade real da
   *  sincronia de cada vídeo já gerado. */
  source: "rhubarb" | "heuristic";
}

/** Os 3 estados de boca que existem hoje como asset (public/mascot/).
 *  A Fase 1 mapeia os 9 visemas para esses 3 estados — upgrade real de
 *  qualidade (fonema de verdade, não só "tem som ou não") sem exigir arte
 *  nova. Ver viseme-mapper.ts. */
export type MouthState = "closed" | "half" | "open";

export interface MouthCue {
  start: number;
  end: number;
  state: MouthState;
}

export type Emotion =
  | "neutral"
  | "happy"
  | "serious"
  | "concerned"
  | "alert" // cenas de risco/perigo em normas de segurança
  | "encouraging";

export interface EmotionCue {
  start: number;
  end: number;
  emotion: Emotion;
  intensity: number; // 0..1
}

export interface BlinkEvent {
  time: number;
  durationMs: number;
}

export interface HeadPose {
  time: number;
  rotationDeg: number;
  offsetX: number;
  offsetY: number;
}

/** Resultado consolidado que generate-video.ts passa para o render.ts. */
export interface LipsyncResult {
  mouthCues: MouthCue[];
  emotion: Emotion;
  timelineSource: "rhubarb" | "heuristic";
  /** Timeline completa de visemas (não só as cues já mapeadas para os 3
   *  estados de boca) — persistida no Blob para debug/QA. Ver
   *  generate-video.ts e a API route de viseme-timeline. */
  rawTimeline: VisemeTimeline;
}
