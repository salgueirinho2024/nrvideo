import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

// O msedge-tts fala com uma API não-oficial da Microsoft (mesmo WebSocket
// usado pelo Edge/Read Aloud) — de vez em quando o servidor fecha a conexão
// no meio da síntese ("Stream closed before the synthesis completed"), sem
// relação com o nosso texto/áudio. É instabilidade da própria API gratuita,
// não um erro determinístico, então a estratégia é tentar de novo algumas
// vezes com um pequeno intervalo antes de desistir.
const TTS_MAX_ATTEMPTS = 4;
const TTS_RETRY_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function synthesizeSpeechOnce(
  text: string,
  voice: string
): Promise<string> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  // A partir do msedge-tts v2, toFile() recebe um DIRETÓRIO (não mais um
  // caminho de arquivo) e escolhe o nome do arquivo internamente.
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `tts-${nanoid(6)}-`));
  const { audioFilePath } = await tts.toFile(outDir, text);
  tts.close();

  // Garante que o arquivo realmente foi escrito com conteúdo
  const stat = await fs.stat(audioFilePath);
  if (stat.size === 0) {
    throw new Error("TTS gerou um arquivo de áudio vazio.");
  }

  return audioFilePath;
}

/**
 * Gera um arquivo de áudio MP3 a partir de um texto, usando uma voz neural
 * gratuita do Microsoft Edge (via msedge-tts). Retorna o caminho do arquivo
 * temporário gerado. Tenta novamente algumas vezes se a conexão com o
 * serviço cair no meio do caminho (instabilidade conhecida dessa API
 * gratuita/não-oficial), em vez de derrubar a cena de primeira.
 */
export async function synthesizeSpeech(
  text: string,
  voice: string
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
    try {
      return await synthesizeSpeechOnce(text, voice);
    } catch (err) {
      lastError = err;
      console.error(
        `TTS falhou na tentativa ${attempt}/${TTS_MAX_ATTEMPTS}:`,
        err instanceof Error ? err.message : err
      );
      if (attempt < TTS_MAX_ATTEMPTS) {
        await sleep(TTS_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Falha ao sintetizar áudio (TTS) após múltiplas tentativas.");
}

export const AVAILABLE_VOICES = [
  { id: "pt-BR-FranciscaNeural", label: "Francisca (feminina, PT-BR)" },
  { id: "pt-BR-AntonioNeural", label: "Antônio (masculina, PT-BR)" },
  { id: "pt-BR-BrendaNeural", label: "Brenda (feminina, PT-BR)" },
  { id: "pt-BR-DonatoNeural", label: "Donato (masculina, PT-BR)" },
];