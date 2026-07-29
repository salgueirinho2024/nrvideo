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
// Duração de CADA passo do ciclo fechado → meio → aberto → meio → (repete).
// 4 passos por ciclo, então um ciclo completo dura 4x isso (~0.32s => ~3.1
// "batidas" de boca por segundo, ritmo natural de fala). Trocamos de um
// corte seco fechado/aberto (2 frames) para esse ciclo de 4 passos com um
// frame intermediário (mouth-half.png) especificamente para suavizar a
// transição — era o corte abrupto, mais que a velocidade em si, que dava a
// sensação de "pulando" relatada. Ver mascot.tsx para o porquê da troca do
// frame de boca aberta em si (também corrigia o "bico").
const MOUTH_STEP_SECONDS = 0.08;

/**
 * Confere que uma expressão de filtro do FFmpeg está com os parênteses
 * balanceados antes de mandar pro ffmpeg.
 *
 * Motivo de existir: um erro de montagem aqui NÃO dá um erro claro do lado
 * do Node — o ffmpeg só devolve algo tipo "Error applying option 'fps' to
 * filter 'zoompan': Invalid argument", que não aponta pra causa real.
 *
 * IMPORTANTE: não montamos mais o filter_complex como uma string gigante
 * com aspas simples escritas na mão (era daí que vinha o erro de "número
 * ímpar de aspas simples" / pedaços faltando). Agora passamos uma lista de
 * filtros estruturados pro fluent-ffmpeg, que monta a string e coloca as
 * aspas nos valores que precisam — sempre balanceadas.
 */
function assertBalancedExpr(name: string, expr: string): void {
  // Aspas simples aqui dentro quebrariam a citação feita pelo fluent-ffmpeg.
  if (expr.includes("'")) {
    throw new Error(
      `Expressão de filtro "${name}" não pode conter aspas simples: ${JSON.stringify(expr)}`
    );
  }
  let depth = 0;
  for (const ch of expr) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) {
      throw new Error(
        `Expressão de filtro "${name}" malformada: ')' sem '(' correspondente. ` +
          `Expressão (JSON-escaped): ${JSON.stringify(expr)}`
      );
    }
  }
  if (depth !== 0) {
    throw new Error(
      `Expressão de filtro "${name}" malformada: ${depth} '(' sem fechamento. ` +
        `Expressão (JSON-escaped): ${JSON.stringify(expr)}`
    );
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
    .map((s) => `(1-between(t,${s.start.toFixed(3)},${s.end.toFixed(3)}))`)
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
  const { closedPath, halfPath, openPath } = await getMascotFrames();

  const duration = await getAudioDuration(scene.audioPath);
  const silences = await detectSilenceIntervals(scene.audioPath, duration);
  const isSpeaking = buildIsSpeakingExpr(silences);

  // Ciclo de 4 passos ENQUANTO está falando: fechado(0) -> meio(1) ->
  // aberto(2) -> meio(3) -> fechado(0)... Fora dos trechos de fala,
  // isSpeaking = 0 zera os frames de meio/aberto e o resultado fica sempre
  // "fechado". Usar um frame intermediário (mouth-half.png) em vez de pular
  // direto de fechado pra aberto é o que suaviza a transição e tira a
  // sensação de "pulando" -- o corte seco entre 2 estados, não a velocidade
  // em si, era o problema.
  const phase = `mod(floor(t/${MOUTH_STEP_SECONDS}),4)`;
  const openEnable = `(${isSpeaking})*eq(${phase},2)`;
  const halfEnable = `(${isSpeaking})*(eq(${phase},1)+eq(${phase},3))`;
  const closedEnable = `1-(${openEnable})-(${halfEnable})`;

  const mascotX = `W-w-${MASCOT_MARGIN}`;
  const mascotY = `${MASCOT_MARGIN}`; // canto SUPERIOR direito

  // Índices dos inputs do ffmpeg: 0 = imagem da cena, 1 = áudio,
  // 2 = boca fechada, 3 = boca meio-aberta, 4 = boca aberta.
  const closedInputIdx = 2;
  const halfInputIdx = 3;
  const openInputIdx = 4;

  let zoomExpr: string;
  let xExpr: string;
  let yExpr: string;
  if (scene.highlight) {
    // Cena de destaque: zoom mais forte + pan diagonal. A direção alterna
    // conforme o índice da cena pra não repetir sempre o mesmo movimento.
    // `shift` cresce de 0 a 1 ao longo da duração real da cena, então o pan
    // termina exatamente quando a narração acaba.
    const totalFrames = Math.max(1, Math.round(duration * RENDER_FPS));
    const panDirection = index % 2 === 0 ? 1 : -1;
    const shift = `min(on/${totalFrames},1)`;
    zoomExpr = `min(zoom+${HIGHLIGHT_ZOOM_RATE},${HIGHLIGHT_MAX_ZOOM})`;
    // (iw/2-(iw/zoom/2)) centraliza o corte; multiplicar por
    // (1 + direção*fração*shift) desloca esse centro rumo a uma das bordas.
    xExpr = `(iw/2-(iw/zoom/2))*(1+(${panDirection})*${HIGHLIGHT_PAN_FRACTION}*${shift})`;
    yExpr = `(ih/2-(ih/zoom/2))*(1+(${panDirection})*${HIGHLIGHT_PAN_FRACTION}*${shift})`;
  } else {
    // Cena normal: zoom lento e contínuo, centralizado.
    zoomExpr = `min(zoom+${NORMAL_ZOOM_RATE},${NORMAL_MAX_ZOOM})`;
    xExpr = `iw/2-(iw/zoom/2)`;
    yExpr = `ih/2-(ih/zoom/2)`;
  }

  const closedEnableExpr = `gt(${closedEnable},0)`;
  const halfEnableExpr = `gt(${halfEnable},0)`;
  const openEnableExpr = `gt(${openEnable},0)`;

  assertBalancedExpr("zoompan:z", zoomExpr);
  assertBalancedExpr("zoompan:x", xExpr);
  assertBalancedExpr("zoompan:y", yExpr);
  assertBalancedExpr("overlay:enable(closed)", closedEnableExpr);
  assertBalancedExpr("overlay:enable(half)", halfEnableExpr);
  assertBalancedExpr("overlay:enable(open)", openEnableExpr);

  // Filtros estruturados: o fluent-ffmpeg monta a string do filter_complex
  // (inclusive as aspas em volta dos valores com vírgula) — nada de
  // concatenar aspas na mão.
  const filters: ffmpeg.FilterSpecification[] = [
    {
      filter: "scale",
      options: { w: 1920, h: 1080, force_original_aspect_ratio: "decrease" },
      inputs: "0:v",
      outputs: "bg0",
    },
    {
      filter: "pad",
      options: { w: 1920, h: 1080, x: "(ow-iw)/2", y: "(oh-ih)/2" },
      inputs: "bg0",
      outputs: "bg1",
    },
    // Upscale 2x: headroom de nitidez pro zoompan cortar sem pixelizar.
    { filter: "scale", options: { w: 2880, h: 1620 }, inputs: "bg1", outputs: "bg2" },
    {
      filter: "zoompan",
      options: {
        z: zoomExpr,
        d: 1,
        x: xExpr,
        y: yExpr,
        s: "1920x1080",
        fps: RENDER_FPS,
      },
      inputs: "bg2",
      outputs: "bg",
    },
    // Os 3 frames do mascote (fechado, meio-aberto e aberto) no tamanho
    // final da bolha.
    {
      filter: "scale",
      options: { w: MASCOT_DISPLAY_SIZE, h: MASCOT_DISPLAY_SIZE },
      inputs: `${closedInputIdx}:v`,
      outputs: "closed",
    },
    {
      filter: "scale",
      options: { w: MASCOT_DISPLAY_SIZE, h: MASCOT_DISPLAY_SIZE },
      inputs: `${halfInputIdx}:v`,
      outputs: "half",
    },
    {
      filter: "scale",
      options: { w: MASCOT_DISPLAY_SIZE, h: MASCOT_DISPLAY_SIZE },
      inputs: `${openInputIdx}:v`,
      outputs: "open",
    },
    // Boca fechada e, por cima, meio-aberta e aberta (só durante os trechos
    // de fala) -- o passo intermediário é o que suaviza a transição.
    {
      filter: "overlay",
      options: { x: mascotX, y: mascotY, enable: closedEnableExpr },
      inputs: ["bg", "closed"],
      outputs: "ov0",
    },
    {
      filter: "overlay",
      options: { x: mascotX, y: mascotY, enable: halfEnableExpr },
      inputs: ["ov0", "half"],
      outputs: "ov1",
    },
    {
      filter: "overlay",
      options: { x: mascotX, y: mascotY, enable: openEnableExpr },
      inputs: ["ov1", "open"],
      outputs: "vout",
    },
  ];

  const command = ffmpeg()
    .input(scene.imagePath)
    .inputOptions(["-loop 1"])
    .input(scene.audioPath)
    .input(closedPath)
    .inputOptions(["-loop 1"])
    .input(halfPath)
    .inputOptions(["-loop 1"])
    .input(openPath)
    .inputOptions(["-loop 1"]);

  return new Promise((resolve, reject) => {
    command
      .complexFilter(filters)
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

export interface RenderVideoScene {
  // Clipe de vídeo de banco (Pexels) baixado localmente — vira o "fundo" da
  // cena, no lugar de uma imagem estática com Ken Burns. Ver stock-video.ts.
  videoPath: string;
  // PNG transparente (cabeçalho, texto, legenda, barra de progresso) gerado
  // por generateSlideImage({ transparentBackground: true, ... }) — ver
  // slides.tsx. Sobreposto por cima do vídeo de fundo.
  overlayImagePath: string;
  audioPath: string;
}

/**
 * Gera um clipe de vídeo (mp4) para UMA cena que usa um vídeo de banco real
 * como fundo (em vez de imagem estática + Ken Burns) — ver
 * RenderVideoScene. Mesma lógica de mascote falando (fechado/meio/aberto
 * sincronizado com o áudio) que renderSceneClip, só troca a origem do
 * "fundo": aqui é vídeo decodificado quadro a quadro, não uma imagem com
 * zoompan.
 *
 * Duração final = duração do áudio da narração (`-shortest` no output):
 * - Se o vídeo de banco for mais curto que a narração, `-stream_loop -1`
 *   no input faz ele repetir em loop até o áudio acabar.
 * - Se for mais longo, simplesmente é cortado no fim do áudio.
 */
export async function renderSceneClipVideo(
  scene: RenderVideoScene,
  index: number
): Promise<string> {
  const outPath = path.join(os.tmpdir(), `scene-video-${index}-${nanoid(6)}.mp4`);
  const { closedPath, halfPath, openPath } = await getMascotFrames();

  const duration = await getAudioDuration(scene.audioPath);
  const silences = await detectSilenceIntervals(scene.audioPath, duration);
  const isSpeaking = buildIsSpeakingExpr(silences);

  const phase = `mod(floor(t/${MOUTH_STEP_SECONDS}),4)`;
  const openEnable = `(${isSpeaking})*eq(${phase},2)`;
  const halfEnable = `(${isSpeaking})*(eq(${phase},1)+eq(${phase},3))`;
  const closedEnable = `1-(${openEnable})-(${halfEnable})`;

  const closedEnableExpr = `gt(${closedEnable},0)`;
  const halfEnableExpr = `gt(${halfEnable},0)`;
  const openEnableExpr = `gt(${openEnable},0)`;

  assertBalancedExpr("overlay:enable(closed)", closedEnableExpr);
  assertBalancedExpr("overlay:enable(half)", halfEnableExpr);
  assertBalancedExpr("overlay:enable(open)", openEnableExpr);

  const mascotX = `W-w-${MASCOT_MARGIN}`;
  const mascotY = `${MASCOT_MARGIN}`;

  // Índices dos inputs: 0 = vídeo de fundo (em loop), 1 = áudio da
  // narração, 2 = overlay de texto transparente, 3/4/5 = mascote.
  const overlayInputIdx = 2;
  const closedInputIdx = 3;
  const halfInputIdx = 4;
  const openInputIdx = 5;

  const filters: ffmpeg.FilterSpecification[] = [
    // Cobre o quadro 1920x1080 inteiro com o vídeo de banco: escala pelo
    // lado maior ("increase", não "decrease" como nas imagens) e corta o
    // excesso no centro — evita barras pretas quando a proporção do vídeo
    // baixado não é exatamente 16:9.
    {
      filter: "scale",
      options: { w: 1920, h: 1080, force_original_aspect_ratio: "increase" },
      inputs: "0:v",
      outputs: "bg0",
    },
    {
      filter: "crop",
      options: { w: 1920, h: 1080, x: "(iw-1920)/2", y: "(ih-1080)/2" },
      inputs: "bg0",
      outputs: "bg",
    },
    // Overlay de texto (cabeçalho/legenda/progresso), já 1920x1080 e
    // transparente onde não há elemento de UI.
    {
      filter: "overlay",
      options: { x: 0, y: 0 },
      inputs: ["bg", `${overlayInputIdx}:v`],
      outputs: "ovtext",
    },
    // Os 3 frames do mascote no tamanho final da bolha.
    {
      filter: "scale",
      options: { w: MASCOT_DISPLAY_SIZE, h: MASCOT_DISPLAY_SIZE },
      inputs: `${closedInputIdx}:v`,
      outputs: "closed",
    },
    {
      filter: "scale",
      options: { w: MASCOT_DISPLAY_SIZE, h: MASCOT_DISPLAY_SIZE },
      inputs: `${halfInputIdx}:v`,
      outputs: "half",
    },
    {
      filter: "scale",
      options: { w: MASCOT_DISPLAY_SIZE, h: MASCOT_DISPLAY_SIZE },
      inputs: `${openInputIdx}:v`,
      outputs: "open",
    },
    {
      filter: "overlay",
      options: { x: mascotX, y: mascotY, enable: closedEnableExpr },
      inputs: ["ovtext", "closed"],
      outputs: "ov0",
    },
    {
      filter: "overlay",
      options: { x: mascotX, y: mascotY, enable: halfEnableExpr },
      inputs: ["ov0", "half"],
      outputs: "ov1",
    },
    {
      filter: "overlay",
      options: { x: mascotX, y: mascotY, enable: openEnableExpr },
      inputs: ["ov1", "open"],
      outputs: "vout",
    },
  ];

  const command = ffmpeg()
    .input(scene.videoPath)
    .inputOptions(["-stream_loop -1"])
    .input(scene.audioPath)
    .input(scene.overlayImagePath)
    .inputOptions(["-loop 1"])
    .input(closedPath)
    .inputOptions(["-loop 1"])
    .input(halfPath)
    .inputOptions(["-loop 1"])
    .input(openPath)
    .inputOptions(["-loop 1"]);

  return new Promise((resolve, reject) => {
    command
      .complexFilter(filters)
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
