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
// Canto superior direito, bem maior que a versão anterior (bolha pequena no
// canto inferior) para ter presença de verdade na tela.
const MASCOT_DISPLAY_SIZE = 340;
const MASCOT_MARGIN = 36;

// --- Detecção de fala/silêncio (sincronia da boca com o áudio real) ---
// Em vez de alternar os frames boca-aberta/boca-fechada num ritmo artificial
// e constante, detectamos de verdade os trechos com voz e os trechos de
// silêncio no áudio da narração (via o filtro `silencedetect` do próprio
// FFmpeg — sem nenhuma API externa). A boca só "mexe" (alterna entre os
// frames num ritmo curto) durante os trechos com voz; nos trechos de
// silêncio, fica sempre no frame de boca fechada.
const SILENCE_NOISE_THRESHOLD_DB = -30; // abaixo disso é considerado silêncio
const SILENCE_MIN_DURATION = 0.15; // pausas menores que isso são ignoradas (evita "piscar" a boca em micro-pausas)
const MOUTH_FLAP_SECONDS = 0.16; // ritmo de abre/fecha da boca ENQUANTO está falando

// A cada quantos segundos (enquanto está falando) trocamos QUAL expressão de
// boca aberta aparece (ver getMascotFrames em mascot.tsx — várias fotos com
// expressões diferentes). Isso evita repetir sempre a mesma boca aberta e dá
// mais vida ao mascote.
const OPEN_FRAME_SWITCH_SECONDS = 2.4;

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

interface SilenceInterval {
  start: number;
  end: number;
}

/**
 * Roda o áudio da cena pelo filtro `silencedetect` do FFmpeg (sem gerar
 * nenhum arquivo de saída — só analisa) e extrai os trechos de silêncio do
 * log (stderr). Se a análise falhar por qualquer motivo, retorna lista
 * vazia (mais seguro do que travar o pipeline inteiro: nesse caso a boca
 * simplesmente fica sempre fechada nessa cena, em vez de quebrar o vídeo).
 */
function detectSilenceIntervals(audioPath: string, duration: number): Promise<SilenceInterval[]> {
  return new Promise((resolve) => {
    let log = "";
    ffmpeg(audioPath)
      .audioFilters(`silencedetect=noise=${SILENCE_NOISE_THRESHOLD_DB}dB:d=${SILENCE_MIN_DURATION}`)
      .outputOptions(["-f null"])
      .output(process.platform === "win32" ? "NUL" : "/dev/null")
      .on("stderr", (line: string) => {
        log += line + "\n";
      })
      .on("end", () => resolve(parseSilenceLog(log, duration)))
      .on("error", () => resolve([]))
      .run();
  });
}

function parseSilenceLog(log: string, duration: number): SilenceInterval[] {
  const starts = [...log.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...log.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  return starts.map((start, i) => ({
    start,
    // Se o áudio termina durante um silêncio, o FFmpeg não chega a logar o
    // "silence_end" correspondente — nesse caso, o silêncio vai até o fim.
    end: ends[i] !== undefined ? ends[i] : duration,
  }));
}

/**
 * Monta a expressão de filtro do FFmpeg que representa "não está em
 * silêncio neste instante t": para cada intervalo de silêncio, multiplica
 * por (1 - between(t, início, fim)) — o produto só é 1 quando t não cai em
 * NENHUM dos intervalos. Retorna "1" (sempre falando) se não houver
 * silêncio detectado.
 */
function buildIsSpeakingExpr(silences: SilenceInterval[]): string {
  if (silences.length === 0) return "1";
  return silences
    .map((s) => `(1-between(t\\,${s.start.toFixed(3)}\\,${s.end.toFixed(3)}))`)
    .join("*");
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
  const { closedPath, openPaths } = await getMascotFrames();

  const duration = await getAudioDuration(scene.audioPath);
  const silences = await detectSilenceIntervals(scene.audioPath, duration);
  const isSpeaking = buildIsSpeakingExpr(silences);

  // Ritmo de abre/fecha ENQUANTO está falando (0/1 alternando a cada
  // MOUTH_FLAP_SECONDS). Fora dos trechos de fala, isSpeaking = 0 anula essa
  // parte e o resultado fica sempre "fechado".
  const flapToggle = `mod(floor(t/${MOUTH_FLAP_SECONDS})\\,2)`;
  const anyOpenEnable = `(${isSpeaking})*eq(${flapToggle}\\,1)`;
  const closedEnable = `1-(${anyOpenEnable})`;

  // Enquanto a boca está "aberta", alterna qual EXPRESSÃO aparece (várias
  // fotos diferentes, ver mascot.tsx) a cada OPEN_FRAME_SWITCH_SECONDS, pra
  // não repetir sempre a mesma boca aberta.
  const openFrameIndexExpr = `mod(floor(t/${OPEN_FRAME_SWITCH_SECONDS})\\,${openPaths.length})`;
  const openEnables = openPaths.map(
    (_, i) => `(${anyOpenEnable})*eq(${openFrameIndexExpr}\\,${i})`
  );

  const mascotX = `W-w-${MASCOT_MARGIN}`;
  const mascotY = `${MASCOT_MARGIN}`; // canto SUPERIOR direito

  // Índices dos inputs do ffmpeg: 0 = imagem da cena, 1 = áudio,
  // 2 = boca fechada, 3..3+N-1 = expressões de boca aberta.
  const closedInputIdx = 2;
  const openInputIdxs = openPaths.map((_, i) => 3 + i);

  const scaleFilters =
    `[${closedInputIdx}:v]scale=${MASCOT_DISPLAY_SIZE}:${MASCOT_DISPLAY_SIZE}[closed];` +
    openInputIdxs
      .map(
        (idx, i) =>
          `[${idx}:v]scale=${MASCOT_DISPLAY_SIZE}:${MASCOT_DISPLAY_SIZE}[open${i}];`
      )
      .join("");

  const overlayFilters =
    `[bg][closed]overlay=x=${mascotX}:y=${mascotY}:enable='gt(${closedEnable}\\,0)'[ov0];` +
    openEnables
      .map((enable, i) => {
        const src = `[ov${i}]`;
        const dst = i === openEnables.length - 1 ? "[vout]" : `[ov${i + 1}]`;
        return `${src}[open${i}]overlay=x=${mascotX}:y=${mascotY}:enable='gt(${enable}\\,0)'${dst};`;
      })
      .join("");

  const filterComplex =
    // Fundo: normaliza para 1920x1080, faz upscale (headroom de nitidez) e
    // aplica um zoom lento e contínuo (Ken Burns) até 1.15x, centralizado.
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,scale=2880:1620,` +
    `zoompan=z='min(zoom+0.0008,1.15)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30[bg];` +
    // Redimensiona todos os frames do mascote (fechado + expressões abertas) pro tamanho final da bolha.
    scaleFilters +
    // Sobrepõe boca fechada, e depois cada expressão de boca aberta (cada
    // uma só habilitada durante o trecho de fala que "sorteou" ela) no canto
    // superior direito.
    overlayFilters;

  const command = ffmpeg()
    .input(scene.imagePath)
    .inputOptions(["-loop 1"])
    .input(scene.audioPath)
    .input(closedPath)
    .inputOptions(["-loop 1"]);

  for (const openPath of openPaths) {
    command.input(openPath).inputOptions(["-loop 1"]);
  }

  return new Promise((resolve, reject) => {
    command
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
