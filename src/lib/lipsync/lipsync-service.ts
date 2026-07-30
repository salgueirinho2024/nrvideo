import { PhonemeService } from "./phoneme-service";
import { mapVisemesToMouthStates } from "./viseme-mapper";
import { EmotionDetector } from "./emotion-detector";
import type { LipsyncResult } from "./types";

const phonemeService = new PhonemeService();
const emotionDetector = new EmotionDetector();

/**
 * Ponto de entrada único do módulo de lip sync, chamado uma vez por cena
 * dentro do step "generate-lipsync-scene-N" do Inngest (ver
 * generate-video.ts). Produz tudo que o render.ts precisa: as cues de boca
 * (já mapeadas para os 3 assets existentes) e a emoção detectada da cena.
 */
export async function buildSceneLipsync(params: {
  sceneId: string;
  audioFilePath: string;
  narrationText: string;
  durationSeconds: number;
}): Promise<LipsyncResult> {
  const { sceneId, audioFilePath, narrationText, durationSeconds } = params;

  const visemeTimeline = await phonemeService.extractVisemes(
    audioFilePath,
    sceneId,
    durationSeconds,
    narrationText
  );

  const mouthCues = mapVisemesToMouthStates(visemeTimeline);
  const emotion = emotionDetector.detectFromText(narrationText);

  return {
    mouthCues,
    emotion,
    timelineSource: visemeTimeline.source,
    rawTimeline: visemeTimeline,
  };
}
