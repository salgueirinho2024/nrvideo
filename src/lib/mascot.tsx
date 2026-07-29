// Mascote usado como bolha "falando" no canto do vídeo de treinamento.
//
// Usa fotos reais da técnica de segurança, já pré-processadas (recorte
// circular na resolução original + anel verde/branco + sombra) e salvas como
// assets estáticos em public/mascot/. Não há geração em runtime: os PNGs
// finais já saem prontos do repositório, então esta função só resolve os
// caminhos (sem chamar Satori, sem chamar nenhuma API).
//
// Apenas 2 frames: boca fechada e boca aberta. Já tivemos 3 expressões
// diferentes de boca aberta alternando, mas isso ficava "pulando" (as fotos
// tinham nível de zoom levemente diferente entre si, então o rosto mudava
// de tamanho a cada troca) — voltamos pro par simples fechado/aberto.
// A foto de boca fechada também foi reprocessada (recorte central ~86% +
// reescala) pra bater com o nível de zoom da foto de boca aberta e não dar
// esse "pulo" de tamanho ao trocar de frame.
//
// A "fala" é sincronizada com o áudio de verdade: src/lib/render.ts detecta
// os trechos de silêncio (via `silencedetect` do FFmpeg) e só alterna pro
// frame de boca aberta durante os trechos com voz — nas pausas, a boca fica
// fechada. Ver renderSceneClip em render.ts.

import path from "path";

function mascotAssetPath(file: string): string {
  return path.join(process.cwd(), "public", "mascot", file);
}

/**
 * Retorna o caminho do frame de boca fechada e o caminho do frame de boca
 * aberta. Sem processamento em runtime — os PNGs já vêm prontos do
 * repositório (ver public/mascot/).
 */
export async function getMascotFrames(): Promise<{ closedPath: string; openPath: string }> {
  return {
    closedPath: mascotAssetPath("mouth-closed.png"),
    openPath: mascotAssetPath("mouth-open.png"),
  };
}
