// Mascote usado como bolha "falando" no canto do vídeo de treinamento.
//
// Usa fotos/ilustrações da personagem, já pré-processadas (recorte
// circular na resolução original + anel verde/branco + sombra) e salvas
// como assets estáticos em public/mascot/. Não há geração em runtime: os
// PNGs finais já saem prontos do repositório (gerados por
// scripts/generate-mascot-visemes.mjs), então esta função só resolve os
// caminhos.
//
// HISTÓRICO / FIX (boca "de bico" + "pulando"):
// - O par fechado/aberto usado antes (mouth-closed.png + mouth-open-1.png,
//   este último salvo como mouth-open.png) tinha o MELHOR alinhamento de
//   zoom/enquadramento entre os dois — por isso foi o par escolhido — mas a
//   foto de boca aberta em si mostrava um "O" arredondado/de bico, não uma
//   boca de fala natural (é a raiz do "tá fazendo bico" relatado).
// - Correção original: realinhamos a 2ª opção de boca aberta em cima de
//   mouth-closed.png por feature matching (ORB, região acima da boca) e
//   reescala/deslocamento (warpAffine).
//
// UPGRADE PRA 8 BOCAS (visemas): a Fase 1 usava só 3 estados (closed/
// half/open) — funcional, mas a boca não distinguia vogais entre si. Agora
// cada um dos 8 visemas visualmente distintos do Rhubarb (X/A compartilham
// asset — ver types.ts) tem seu próprio PNG, gerado com personagem e seed
// fixos (mesma cara em todas, só a boca muda — ver
// scripts/generate-mascot-visemes.mjs) e depois alinhado do mesmo jeito
// que o par closed/open original, pra não "pular" ao trocar de frame.
//
// A "fala" é sincronizada com o áudio de verdade: src/lib/lipsync/ extrai
// fonemas reais (Rhubarb Lip Sync, com fallback heurístico) e o render.ts
// só desenha a timeline que já chegou pronta — nenhuma análise de áudio
// acontece no render.ts.

import path from "path";
import type { MouthState } from "./lipsync/types";

function mascotAssetPath(file: string): string {
  return path.join(process.cwd(), "public", "mascot", file);
}

// Nome do arquivo esperado para cada um dos 8 estados de boca. Se algum
// desses arquivos ainda não existir (visemas novos, antes de rodar o
// script de geração), troque a entrada correspondente aqui por um path já
// existente como fallback temporário — nunca deixe undefined chegar no
// render.ts.
const MOUTH_ASSET_FILE: Record<MouthState, string> = {
  closed: "mouth-closed.png",
  halfTeeth: "mouth-half-teeth.png",
  chOpen: "mouth-ch-open.png",
  wideOpen: "mouth-wide-open.png",
  stretchE: "mouth-stretch-e.png",
  teethLip: "mouth-teeth-lip.png",
  roundO: "mouth-round-o.png",
  tongueL: "mouth-tongue-l.png",
};

/** Ordem fixa em que os 8 estados são declarados como input do ffmpeg e
 *  empilhados como overlay (ver render.ts) — "closed" sempre primeiro
 *  (é o estado de repouso/fallback, fica na base da pilha). */
export const MOUTH_ASSET_KEYS: MouthState[] = [
  "closed",
  "halfTeeth",
  "chOpen",
  "wideOpen",
  "stretchE",
  "teethLip",
  "roundO",
  "tongueL",
];

/**
 * Retorna os caminhos dos 8 frames de boca do mascote. Sem processamento
 * em runtime — os PNGs já vêm prontos do repositório (ver public/mascot/).
 */
export async function getMascotFrames(): Promise<Record<MouthState, string>> {
  const entries = MOUTH_ASSET_KEYS.map(
    (key) => [key, mascotAssetPath(MOUTH_ASSET_FILE[key])] as const
  );
  return Object.fromEntries(entries) as Record<MouthState, string>;
}
