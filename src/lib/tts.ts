import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

/**
 * Gera um arquivo de áudio MP3 a partir de um texto, usando uma voz neural
 * gratuita do Microsoft Edge (via msedge-tts). Retorna o caminho do arquivo
 * temporário gerado.
 */
export async function synthesizeSpeech(
  text: string,
  voice: string
): Promise<string> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const outPath = path.join(os.tmpdir(), `tts-${nanoid(8)}.mp3`);
  await tts.toFile(outPath, text);
  tts.close();

  // Garante que o arquivo realmente foi escrito com conteúdo
  const stat = await fs.stat(outPath);
  if (stat.size === 0) {
    throw new Error("TTS gerou um arquivo de áudio vazio.");
  }

  return outPath;
}

export const AVAILABLE_VOICES = [
  { id: "pt-BR-FranciscaNeural", label: "Francisca (feminina, PT-BR)" },
  { id: "pt-BR-AntonioNeural", label: "Antônio (masculina, PT-BR)" },
  { id: "pt-BR-BrendaNeural", label: "Brenda (feminina, PT-BR)" },
  { id: "pt-BR-DonatoNeural", label: "Donato (masculina, PT-BR)" },
];
