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

/**
 * Confere, sem depender do ffmpeg, que a string do filter_complex não está
 * com aspas/parênteses/colchetes desbalanceados antes de mandar pro ffmpeg.
 *
 * Motivo de existir: um erro de montagem aqui NÃO dá um erro claro do lado
 * do Node — o ffmpeg só devolve algo tipo "Error applying option 'fps' to
 * filter 'zoompan': Invalid argument", que não aponta pra causa real (uma
 * aspa ou fechamento faltando lá atrás na string). Já vimos em produção um
 * filter_complex chegando com pedaços faltando (ex.: ")':d=1:" e "[closed];"
 * sumidos) e o sintoma foi exatamente essa mensagem genérica do ffmpeg,
 * horas pra descobrir a causa real. Essa checagem falha na hora, com a
 * string inteira no erro, apontando exatamente o que está desbalanceado.
 */
function assertValidFilterComplex(filterComplex: string): void {
  const quoteCount = (filterComplex.match(/'/g) || []).length;
  if (quoteCount % 2 !== 0) {
    throw new Error(
      `filterComplex malformado: número ímpar de aspas simples (${quoteCount}), ` +
        `o ffmpeg vai interpretar tudo depois da aspa órfã como parte de um valor só. ` +
        `String completa: ${filterComplex}`
    );
  }

  const bracketPairs: Array<[string, string]> = [
    ["(", ")"],
    ["[", "]"],
  ];
  for (const [open, close] of bracketPairs) {
    let depth = 0;
    for (const ch of filterComplex) {
      if (ch === open) depth++;
      else if (ch === close) depth--;
      if (depth < 0) {
        throw new Error(
          `filterComplex malformado: '${close}' aparece sem '${open}' correspondente antes dele. ` +
            `String completa: ${filterComplex}`
        );
      }
    }
    if (depth !== 0) {
      throw new Error(
        `filterComplex malformado: ${depth} '${open}' sem fechamento correspondente ('${close}'). ` +
          `String completa: ${filterComplex}`
      );
    }
  }
}

export interface RenderScene {
  imagePath: string;
  audioPath: string;
  // Cenas marcadas pelo Gemini como as mais importantes do roteiro (ver
  // src/lib/gemini.ts) recebem um Ken Burns mais dinâmico — pan diagonal +
  // zoom mais forte — em vez do zoom sutil e centralizado padrão. É a forma
  // que este projeto usa para dar destaque visual "tipo vídeo animado" a
  // cenas específicas sem depender de nenhum gerador de vídeo por IA (não
  // existe hoje um provedor de vídeo gratuito e confiável o suficiente pra
  // um pipeline automatizado — ver histórico de troca de provedor em
  // image-gen.ts para o mesmo problema com imagem).
  highlight?: boolean;
}

// --- Ken Burns padrão (todas as cenas) ---
const NORMAL_ZOOM_RATE = 0.0008;
const NORMAL_MAX_ZOOM = 1.15;

// --- Ken Burns dinâmico (só cenas com highlight = true) ---
const HIGHLIGHT_ZOOM_RATE = 0.0016;
const HIGHLIGHT_MAX_ZOOM = 1.32;
// Fração do caminho até a borda do quadro que o pan diagonal percorre no
// auge do movimento (1 = encosta na borda; menos que isso evita um corte
// bruto de conteúdo perto das bordas da ilustração).
const HIGHLIGHT_PAN_FRACTION = 0.55;
const RENDER_FPS = 30;

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
  const { closedPath, openPath } = await getMascotFrames();

  const duration = await getAudioDuration(scene.audioPath);
  const silences = await detectSilenceIntervals(scene.audioPath, duration);
  const isSpeaking = buildIsSpeakingExpr(silences);

  // Ritmo de abre/fecha ENQUANTO está falando (0/1 alternando a cada
  // MOUTH_FLAP_SECONDS). Fora dos trechos de fala, isSpeaking = 0 anula essa
  // parte e o resultado fica sempre "fechado". Só 2 estados agora (fechado
  // e aberto) — nada de alternar entre várias expressões, que é o que
  // causava aquele "pulo" de tamanho entre frames com zoom levemente
  // diferente.
  const flapToggle = `mod(floor(t/${MOUTH_FLAP_SECONDS})\\,2)`;
  const openEnable = `(${isSpeaking})*eq(${flapToggle}\\,1)`;
  const closedEnable = `1-(${openEnable})`;

  const mascotX = `W-w-${MASCOT_MARGIN}`;
  const mascotY = `${MASCOT_MARGIN}`; // canto SUPERIOR direito

  // Índices dos inputs do ffmpeg: 0 = imagem da cena, 1 = áudio,
  // 2 = boca fechada, 3 = boca aberta.
  const closedInputIdx = 2;
  const openInputIdx = 3;

  const scaleFilters =
    `[${closedInputIdx}:v]scale=${MASCOT_DISPLAY_SIZE}:${MASCOT_DISPLAY_SIZE}[closed];` +
    `[${openInputIdx}:v]scale=${MASCOT_DISPLAY_SIZE}:${MASCOT_DISPLAY_SIZE}[open];`;

  const overlayFilters =
    `[bg][closed]overlay=x=${mascotX}:y=${mascotY}:enable='gt(${closedEnable}\\,0)'[ov0];` +
    `[ov0][open]overlay=x=${mascotX}:y=${mascotY}:enable='gt(${openEnable}\\,0)'[vout];`;

  // Base do fundo: normaliza para 1920x1080 e faz upscale 2x (headroom de
  // nitidez pro zoompan cortar sem pixelizar). Comum às duas variantes.
  const bgBase =
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,scale=2880:1620,`;

  let bgZoompan: string;
  if (scene.highlight) {
    // Cena de destaque: zoom mais forte + pan diagonal. A direção alterna
    // conforme o índice da cena (par = canto inferior-direito, ímpar =
    // canto superior-esquerdo) pra não repetir sempre o mesmo movimento
    // quando há várias cenas de destaque seguidas. `shift` cresce de 0 a 1
    // ao longo da duração real da cena (frame `on` / total de frames),
    // então o pan termina de percorrer o trajeto exatamente quando a
    // narração acaba, não antes nem depois.
    const totalFrames = Math.max(1, Math.round(duration * RENDER_FPS));
    const panDirection = index % 2 === 0 ? 1 : -1;
    const shift = `min(on/${totalFrames},1)`;
    const zoomExpr = `min(zoom+${HIGHLIGHT_ZOOM_RATE},${HIGHLIGHT_MAX_ZOOM})`;
    // (iw/2-(iw/zoom/2)) é o deslocamento que centraliza o corte; multiplicar
    // por (1 + direção*fração*shift) desloca esse ponto central em direção a
    // uma das bordas conforme o vídeo avança, criando o pan.
    const xExpr = `(iw/2-(iw/zoom/2))*(1+(${panDirection})*${HIGHLIGHT_PAN_FRACTION}*${shift})`;
    const yExpr = `(ih/2-(ih/zoom/2))*(1+(${panDirection})*${HIGHLIGHT_PAN_FRACTION}*${shift})`;
    bgZoompan = `zoompan=z='${zoomExpr}':d=1:x='${xExpr}':y='${yExpr}':s=1920x1080:fps=${RENDER_FPS}[bg];`;
  } else {
    // Cena normal: zoom lento e contínuo, centralizado (comportamento original).
    bgZoompan =
      `zoompan=z='min(zoom+${NORMAL_ZOOM_RATE},${NORMAL_MAX_ZOOM})':d=1:` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=${RENDER_FPS}[bg];`;
  }

  const filterComplex =
    bgBase +
    bgZoompan +
    // Redimensiona os 2 frames do mascote (fechado e aberto) pro tamanho final da bolha.
    scaleFilters +
    // Sobrepõe boca fechada e depois boca aberta (habilitada só durante os
    // trechos de fala) no canto superior direito.
    overlayFilters;

  assertValidFilterComplex(filterComplex);

  const command = ffmpeg()
    .input(scene.imagePath)
    .inputOptions(["-loop 1"])
    .input(scene.audioPath)
    .input(closedPath)
    .inputOptions(["-loop 1"])
    .input(openPath)
    .inputOptions(["-loop 1"]);

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
