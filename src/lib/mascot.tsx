// Mascote usado como bolha "falando" no canto do vídeo de treinamento.
//
// Usa fotos reais da técnica de segurança, já pré-processadas (recorte
// circular na resolução original + anel verde/branco + sombra) e salvas como
// assets estáticos em public/mascot/. Não há geração em runtime: os PNGs
// finais já saem prontos do repositório, então esta função só resolve os
// caminhos (sem chamar Satori, sem chamar nenhuma API).
//
// Diferente da primeira versão (1 frame fechado + 1 frame aberto), agora
// temos 1 frame de boca fechada e VÁRIOS frames de boca aberta com
// expressões diferentes — o render alterna entre eles enquanto a pessoa
// está falando, pra ficar mais natural (ver OPEN_FRAME_SWITCH_SECONDS em
// render.ts), em vez de repetir sempre a mesma boca aberta.
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
 * Retorna o caminho do frame de boca fechada e os caminhos de todos os
 * frames de boca aberta (expressões variadas). Sem processamento em
 * runtime — os PNGs já vêm prontos do repositório (ver public/mascot/).
 */
export async function getMascotFrames(): Promise<{ closedPath: string; openPaths: string[] }> {
  return {
    closedPath: mascotAssetPath("mouth-closed.png"),
    openPaths: [
      mascotAssetPath("mouth-open-1.png"),
      mascotAssetPath("mouth-open-2.png"),
      mascotAssetPath("mouth-open-3.png"),
    ],
  };
}
