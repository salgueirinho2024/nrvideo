// Mascote usado como bolha "falando" no canto do vídeo de treinamento.
//
// Diferente da primeira versão (desenhada por vetor via Satori), agora usa
// duas artes reais fornecidas pelo usuário — uma técnica de segurança
// cartoon, já com boca fechada e boca aberta — pré-processadas (recorte
// circular na resolução original + anel verde/branco + sombra) e salvas como
// assets estáticos em public/mascot/. Não há geração em runtime: os dois
// PNGs finais já saem prontos do repositório, então esta função só resolve
// os caminhos (sem chamar Satori, sem chamar nenhuma API).
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
 * Retorna os caminhos dos dois frames estáticos do mascote (boca fechada /
 * boca aberta). Sem processamento em runtime — os PNGs já vêm prontos do
 * repositório (ver public/mascot/).
 */
export async function getMascotFrames(): Promise<{ closedPath: string; openPath: string }> {
  return {
    closedPath: mascotAssetPath("mouth-closed.png"),
    openPath: mascotAssetPath("mouth-open.png"),
  };
}
