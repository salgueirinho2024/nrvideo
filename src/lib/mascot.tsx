// Mascote usado como bolha "falando" no canto do vídeo de treinamento.
//
// Usa ilustrações da personagem, já pré-processadas (recorte circular +
// anel verde/branco + sombra, RGBA de verdade) e salvas como assets
// estáticos em public/mascot/. Não há geração em runtime: os PNGs finais
// já saem prontos do repositório, então esta função só resolve os
// caminhos.
//
// PIPELINE DE GERAÇÃO (2 passos, sempre nessa ordem):
// 1. scripts/generate-mascot-visemes.mjs — gera as 8 imagens cruas via
//    Cloudflare (flux-1-schnell), personagem e seed fixos, só o prompt da
//    boca muda entre elas.
// 2. scripts/align-mascot-visemes.py — OBRIGATÓRIO depois do passo 1. As
//    imagens cruas do passo 1 NÃO saem alinhadas entre si (o modelo não
//    garante pixel-perfect mesmo com seed fixa: cabeça um pouco maior/
//    menor, deslocada, ângulo diferente) nem têm fundo transparente. Sem
//    esse passo, o render.ts troca de PNG a cada estado de boca e a
//    mascote parece "pulando"/"girando" no vídeo — não é bug de lip sync,
//    é desalinhamento das imagens-fonte. O script alinha por ECC (região
//    estável do rosto: testa/olhos/sobrancelhas/capacete, fora da boca),
//    recorta em círculo, e adiciona anel + sombra.
//
// HISTÓRICO: até a versão anterior deste arquivo, o passo 2 era descrito
// como "alinhamento manual" mas nunca foi de fato aplicado aos PNGs
// commitados (estavam como retângulo opaco, sem alpha, com a cabeça em
// posições diferentes entre os 8) — essa é a causa raiz do "mascote se
// movendo em círculos" relatado. scripts/align-mascot-visemes.py resolve
// isso de forma reprodutível (não depende de edição manual em editor de
// imagem).
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
