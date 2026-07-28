import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "@ffprobe-installer/ffprobe";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { getMascotFrames } from "./mascot";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
}
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

// --- Mascote (bolha "falando" no canto, ver src/lib/mascot.tsx) ---
// Tamanho final da bolha sobreposta ao vídeo (px) e distância das bordas.
const MASCOT_DISPLAY_SIZE = 220;
const MASCOT_MARGIN = 40;
// Ritmo de troca entre os frames boca-fechada/boca-aberta (segundos). Não é
// lip-sync real, só um ciclo constante que dá a sensação de "falando"
// enquanto a cena tem narração.
const MASCOT_MOUTH_TOGGLE_SECONDS = 0.18;

export interface RenderScene {
  imagePath: string;
  audioPath: string;
}

/**
 * Descobre a duração (em segundos) de um arquivo de áudio usando ffprobe.
 */
export function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

/**
 * Gera um clipe de vídeo (mp4) para UMA cena: imagem estática + áudio da narração.
 * Exportada (além de usada por renderFinalVideo) para permitir que cada
 * clipe seja renderizado como uma etapa isolada e durável do Inngest —
 * essencial para vídeos longos (muitas cenas), onde renderizar tudo numa
 * única invocação de function serverless pode estourar o tempo limite.
 * Ver `generate-video.ts`.
 */
export async function renderSceneClip(scene: RenderScene, index: number): Promise<string> {
  const outPath = path.join(os.tmpdir(), `scene-${index}-${nanoid(6)}.mp4`);
  const { closedPath, openPath } = await getMascotFrames();

  // Expressão booleana (reutilizada nos dois overlays) que alterna entre
  // boca-fechada e boca-aberta a cada MASCOT_MOUTH_TOGGLE_SECONDS. A vírgula
  // dentro de mod(...) precisa ser escapada com "\," porque, dentro de uma
  // definição de filtro do FFmpeg, vírgula normalmente separa filtros — sem o
  // escape o parser quebraria a expressão em dois filtros inválidos.
  const toggle = `mod(floor(t/${MASCOT_MOUTH_TOGGLE_SECONDS})\\,2)`;
  const mascotX = `W-w-${MASCOT_MARGIN}`;
  const mascotY = `H-h-${MASCOT_MARGIN}`;

  const filterComplex =
    // Fundo: normaliza para 1920x1080, faz upscale (headroom de nitidez) e
    // aplica um zoom lento e contínuo (Ken Burns) até 1.15x, centralizado.
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,scale=2880:1620,` +
    `zoompan=z='min(zoom+0.0008,1.15)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30[bg];` +
    // Redimensiona os dois frames do mascote pro tamanho final da bolha.
    `[2:v]scale=${MASCOT_DISPLAY_SIZE}:${MASCOT_DISPLAY_SIZE}[closed];` +
    `[3:v]scale=${MASCOT_DISPLAY_SIZE}:${MASCOT_DISPLAY_SIZE}[open];` +
    // Sobrepõe um frame ou outro no canto inferior direito, alternando no
    // tempo — só um dos dois fica visível (`enable`) a cada instante.
    `[bg][closed]overlay=x=${mascotX}:y=${mascotY}:enable='eq(${toggle}\\,0)'[tmp];` +
    `[tmp][open]overlay=x=${mascotX}:y=${mascotY}:enable='eq(${toggle}\\,1)'[vout]`;

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(scene.imagePath)
      .inputOptions(["-loop 1"])
      .input(scene.audioPath)
      .input(closedPath)
      .inputOptions(["-loop 1"])
      .input(openPath)
      .inputOptions(["-loop 1"])
      .complexFilter(filterComplex)
      .outputOptions([
        "-map [vout]",
        "-map 1:a",
        "-c:v libx264",
        "-c:a aac",
        "-b:a 192k",
        "-pix_fmt yuv420p",
        "-shortest",
      ])
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", reject)
      .run();
  });
}

/**
 * Concatena uma lista de clipes de vídeo mp4 (todos com mesmo codec/formato) em um único arquivo.
 * Exportada para permitir concatenar clipes já renderizados em etapas
 * anteriores (etapa final leve, sem re-encodar nada — usa "-c copy").
 */
export function concatClips(clipPaths: string[], outPath: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const listPath = path.join(os.tmpdir(), `concat-${nanoid(6)}.txt`);
    const listContent = clipPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fs.writeFile(listPath, listContent);

    ffmpeg()
      .input(listPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", reject)
      .run();
  });
}

/**
 * Renderiza o vídeo final do treinamento a partir das cenas (imagem + áudio de cada uma).
 * Retorna o caminho do arquivo mp4 final em disco (tmp).
 */
/**
 * Concatena clipes de cena já renderizados (um por etapa do Inngest) num
 * único mp4 final. Usa "-c copy" (sem re-encode), então é rápido mesmo com
 * muitos clipes — pensada para a etapa final de vídeos longos, depois que
 * cada cena já foi renderizada individualmente.
 */
export async function concatFinalVideo(clipPaths: string[]): Promise<string> {
  if (clipPaths.length === 0) {
    throw new Error("Nenhum clipe para concatenar.");
  }
  const finalPath = path.join(os.tmpdir(), `final-${nanoid(8)}.mp4`);
  await concatClips(clipPaths, finalPath);
  return finalPath;
}

export async function renderFinalVideo(scenes: RenderScene[]): Promise<string> {
  if (scenes.length === 0) {
    throw new Error("Nenhuma cena para renderizar.");
  }

  const clipPaths: string[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const clip = await renderSceneClip(scenes[i], i);
    clipPaths.push(clip);
  }

  const finalPath = path.join(os.tmpdir(), `final-${nanoid(8)}.mp4`);
  await concatClips(clipPaths, finalPath);

  // Limpeza dos clipes intermediários (best-effort)
  await Promise.all(
    clipPaths.map((p) => fs.unlink(p).catch(() => undefined))
  );

  return finalPath;
}