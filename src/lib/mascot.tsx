// Mascote usado como bolha "falando" no canto do vídeo de treinamento.
//
// Usa fotos reais da técnica de segurança, já pré-processadas (recorte
// circular na resolução original + anel verde/branco + sombra) e salvas como
// assets estáticos em public/mascot/. Não há geração em runtime: os PNGs
// finais já saem prontos do repositório, então esta função só resolve os
// caminhos (sem chamar Satori, sem chamar nenhuma API).
//
// HISTÓRICO / FIX (boca "de bico" + "pulando"):
// - O par fechado/aberto usado antes (mouth-closed.png + mouth-open-1.png,
//   este último salvo como mouth-open.png) tinha o MELHOR alinhamento de
//   zoom/enquadramento entre os dois — por isso foi o par escolhido — mas a
//   foto de boca aberta em si mostrava um "O" arredondado/de bico, não uma
//   boca de fala natural (é a raiz do "tá fazendo bico" relatado).
// - mouth-open-2.png / mouth-open-3.png têm uma boca aberta muito mais
//   natural (dentes visíveis, formato de fala real), mas tinham zoom/posição
//   levemente diferentes de mouth-closed.png — daí o "pulando" ao trocar de
//   frame quando alternavam 3 expressões no passado.
// - Correção: realinhamos mouth-open-2.png em cima de mouth-closed.png por
//   feature matching (ORB, região acima da boca) e reescala/deslocamento
//   (warpAffine), e o resultado alinhado virou o novo mouth-open.png — boca
//   natural, mesmo enquadramento do frame fechado.
// - Também adicionamos um 3º frame, mouth-half.png (blend 55% entre fechado
//   e o novo aberto), usado como passo intermediário na animação (ver
//   render.ts: fechado → meio → aberto → meio → fechado) em vez do corte
//   seco fechado↔aberto de antes. Isso soma ao efeito de "não pular" além do
//   alinhamento em si.
//
// A "fala" é sincronizada com o áudio de verdade: src/lib/render.ts detecta
// os trechos de silêncio (via `silencedetect` do FFmpeg) e só anima a boca
// durante os trechos com voz — nas pausas, a boca fica fechada. Ver
// renderSceneClip em render.ts.

import path from "path";

function mascotAssetPath(file: string): string {
  return path.join(process.cwd(), "public", "mascot", file);
}

/**
 * Retorna os caminhos dos 3 frames do mascote (fechado, meio-aberto,
 * aberto). Sem processamento em runtime — os PNGs já vêm prontos do
 * repositório (ver public/mascot/).
 */
export async function getMascotFrames(): Promise<{
  closedPath: string;
  halfPath: string;
  openPath: string;
}> {
  return {
    closedPath: mascotAssetPath("mouth-closed.png"),
    halfPath: mascotAssetPath("mouth-half.png"),
    openPath: mascotAssetPath("mouth-open.png"),
  };
}
