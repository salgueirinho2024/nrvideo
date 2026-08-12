import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "@ffprobe-installer/ffprobe";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { getMascotFrames, MOUTH_ASSET_KEYS } from "./mascot";
import type { MouthCue, MouthState } from "./lipsync/types";
import { HeadMotionController } from "./lipsync/head-motion-controller";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
}
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

// --- Mascote alternando: "grande e falando" <-> "imagem em tela cheia" ---
// Substituiu o modo antigo de bolha pequena fixa no canto: agora a
// personagem ocupa uma faixa de tempo grande e centralizada (estilo
// "apresentador"), e nas faixas seguintes some da tela pra dar lugar à
// ilustração/vídeo de fundo sozinha — depois volta, alternando até a cena
// acabar. Reaproveita os mesmos 8 PNGs de boca (public/mascot/); só muda
// tamanho/posição/janela de tempo em que aparecem.
const BIG_CHARACTER_SIZE = 640;
// Duração de cada bloco "personagem grande" e cada bloco "só imagem".
// Cenas mais curtas que isso ficam com um único bloco de personagem (ver
// buildAlternatingSegments) — nunca corta a fala no meio pra caber um
// segmento vazio.
const CHARACTER_SEGMENT_SECONDS = 4.5;
const IMAGE_SEGMENT_SECONDS = 4.5;
// Se sobrar menos que isso no fim da cena pro próximo bloco, funde no
// bloco anterior em vez de criar um segmento minúsculo (corte muito curto
// fica mais "piscada" do que alternância de verdade).
const MIN_TAIL_SECONDS = 1.5;

interface AlternatingSegment {
  type: "character" | "image";
  start: number;
  end: number;
}

/**
 * Divide a duração da cena em blocos alternados "personagem grande" /
 * "só imagem", sempre começando com a personagem (é ela quem introduz o
 * assunto da cena). Determinístico e só depende da duração do áudio — não
 * precisa de nenhuma marcação nova vinda do roteiro (Gemini).
 */
function buildAlternatingSegments(durationSeconds: number): AlternatingSegment[] {
  const segments: AlternatingSegment[] = [];
  let t = 0;
  let type: AlternatingSegment["type"] = "character";
  while (t < durationSeconds) {
    const segLen = type === "character" ? CHARACTER_SEGMENT_SECONDS : IMAGE_SEGMENT_SECONDS;
    let end = Math.min(t + segLen, durationSeconds);
    if (durationSeconds - end < MIN_TAIL_SECONDS) end = durationSeconds;
    segments.push({ type, start: t, end });
    t = end;
    type = type === "character" ? "image" : "character";
  }
  return segments;
}

/**
 * Expressão FFmpeg "está num bloco de personagem no instante t" — soma de
 * `between(t, início, fim)` de cada segmento do tipo "character". Usada
 * como "portão" (gate) que é multiplicado pela expressão de cada boca em
 * buildMouthEnableExpressions: a boca só fica visível se (a) aquele
 * fonema está ativo E (b) o instante t cai dentro de um bloco de
 * personagem. Fora dos blocos de personagem, a expressão vira 0 pra todas
 * as bocas e a personagem simplesmente não aparece — é isso que dá lugar
 * à imagem sozinha.
 */
function buildCharacterGateExpr(segments: AlternatingSegment[]): string {
  const characterSegments = segments.filter((s) => s.type === "character");
  if (characterSegments.length === 0) return "0";
  return characterSegments
    .map((s) => `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`)
    .join("+");
}

// --- Lip sync por fonemas reais (ver src/lib/lipsync/) ---
// Substituiu a abordagem anterior de `silencedetect` + ciclo artificial de
// 4 passos. Agora cada cena chega aqui com `mouthCues`: uma timeline real
// de "closed"/"half"/"open" derivada de fonemas (Rhubarb Lip Sync, com
// fallback heurístico — ver src/lib/lipsync/phoneme-service.ts), calculada
// no step "generate-lipsync-scene-N" do Inngest. O render.ts não faz mais
// NENHUMA análise de áudio — só desenha a timeline que já chegou pronta.
//
// Limite de segurança: timelines muito longas (cenas de narração extensa,
// tipicamente as cenas com vídeo de banco — são as que o roteiro tende a
// deixar mais longas) inflam a expressão do filtro FFmpeg proporcional ao
// número de cues. ANTES, passar desse limite fazia a cena inteira cair pra
// boca sempre "closed" — na prática, a personagem "parava de falar" bem no
// meio da fala assim que a timeline ficava longa o suficiente, e isso
// batia direto nas cenas de vídeo. Agora, em vez de descartar a timeline,
// `simplifyCuesToLimit` funde cues vizinhos aos pares repetidamente até
// caber no limite — a boca continua se mexendo o tempo todo, só que com
// granularidade um pouco menor nas cenas mais longas (na prática,
// imperceptível: cues fundidos já eram trocas muito rápidas de fonema).
const MAX_MOUTH_CUES_IN_FILTER = 1400;

// Segundo limite de segurança, ortogonal ao de cima: MAX_MOUTH_CUES_IN_FILTER
// controla a QUANTIDADE de cues (trocas ao longo do tempo); este aqui
// controla a VARIEDADE de estados distintos usados na cena. Cada estado
// extra em usedStates vira uma cadeia inteira de filtro (scale+rotate+
// overlay) rodando a BIG_CHARACTER_SIZE (640px) em tela cheia no ffmpeg —
// é isso que causou o OOM de 2243MB/2048MB: a correção anterior do
// lipsync fez cenas de narração longa (as de vídeo de banco, já as mais
// sensíveis a memória) pararem de cair pra "só um estado" e passarem a
// usar os 8 possíveis. Cenas de vídeo levam um teto mais rígido porque já
// pagam o custo extra de decodificar o vídeo de fundo quadro a quadro por
// baixo dos overlays de boca.
const MAX_MOUTH_STATES_IMAGE_SCENE = 5;
const MAX_MOUTH_STATES_VIDEO_SCENE = 3;

/**
 * Funde cues adjacentes aos pares, repetidamente, até a lista caber no
 * limite — nunca zera a timeline (diferente do comportamento antigo).
 * Cada fusão mantém o estado do primeiro cue do par e estende o fim até
 * o fim do segundo, então a boca nunca "trava" num estado fixo: ela
 * continua trocando de forma ao longo da cena inteira, só que com menos
 * trocas por segundo nas cenas muito longas.
 */
function simplifyCuesToLimit(cues: MouthCue[], limit: number): MouthCue[] {
  let result = cues;
  while (result.length > limit) {
    const next: MouthCue[] = [];
    for (let i = 0; i < result.length; i += 2) {
      const a = result[i];
      const b = result[i + 1];
      next.push(b ? { start: a.start, end: b.end, state: a.state } : a);
    }
    result = next;
  }
  return result;
}

/**
 * Quando uma cena usa mais estados de boca distintos do que `maxStates`,
 * remapeia (nunca descarta) os cues dos estados menos usados — por
 * duração total somada, não por contagem de cues — pro estado MANTIDO
 * mais próximo na ordem de MOUTH_ASSET_KEYS. "closed" nunca é removido
 * (é o estado de repouso/fallback). O resultado é que a boca continua se
 * mexendo o tempo inteiro, só que com menos formas distintas nas cenas
 * pesadas — em vez de simplesmente não montar a cadeia de filtro desses
 * estados e a boca "sumir" (ficar sempre fechada) durante os trechos que
 * usavam esses fonemas, que era o efeito colateral de só cortar states
 * sem remapear.
 */
function limitMouthStates(cues: MouthCue[], maxStates: number): MouthCue[] {
  const present = new Set(cues.map((c) => c.state));
  if (present.size <= maxStates) return cues;

  const durationByState = new Map<MouthState, number>();
  for (const c of cues) {
    durationByState.set(c.state, (durationByState.get(c.state) ?? 0) + (c.end - c.start));
  }

  // Ranking dos estados não-"closed" por tempo total de tela, do mais
  // usado pro menos usado — são os primeiros (maxStates - 1) que ficam.
  const ranked = MOUTH_ASSET_KEYS.filter((s) => s !== "closed" && present.has(s)).sort(
    (a, b) => (durationByState.get(b) ?? 0) - (durationByState.get(a) ?? 0)
  );
  const kept = new Set<MouthState>(["closed", ...ranked.slice(0, Math.max(0, maxStates - 1))]);

  const indexOf = (s: MouthState) => MOUTH_ASSET_KEYS.indexOf(s);
  const nearestKept = (state: MouthState): MouthState => {
    let best: MouthState = "closed";
    let bestDist = Infinity;
    for (const k of kept) {
      const dist = Math.abs(indexOf(k) - indexOf(state));
      if (dist < bestDist) {
        bestDist = dist;
        best = k;
      }
    }
    return best;
  };

  return cues.map((c) => (kept.has(c.state) ? c : { ...c, state: nearestKept(c.state) }));
}

/** Timeline de cues realmente usada no filtro FFmpeg — depois de aplicar
 *  os dois limites de segurança acima (quantidade de cues e variedade de
 *  estados). Centralizado aqui pra getUsedMouthStates e
 *  buildMouthEnableExpressions sempre trabalharem com a MESMA lista —
 *  antes cada uma decidia isso separadamente e podiam divergir. */
function getSafeCues(cues: MouthCue[], maxStates: number): MouthCue[] {
  const trimmed =
    cues.length <= MAX_MOUTH_CUES_IN_FILTER ? cues : simplifyCuesToLimit(cues, MAX_MOUTH_CUES_IN_FILTER);
  return limitMouthStates(trimmed, maxStates);
}

const headMotion = new HeadMotionController();


/**
 * Monta, para cada um dos 8 estados de boca (MOUTH_ASSET_KEYS), a
 * expressão de filtro FFmpeg "está nesse estado no instante t": soma de
 * `between(t, início, fim)` por cue daquele estado. Valor > 0 -> `gt(...)`
 * vira o `enable` do overlay. Generalizado sobre a lista de estados (antes
 * era hardcoded pros 3 estados da Fase 1 — closed/half/open) pra não
 * precisar tocar aqui de novo se o número de bocas mudar outra vez.
 */
/**
 * Recebe a lista de estados de boca a considerar (normalmente só os que
 * aparecem de fato nas `cues` da cena — ver `getUsedMouthStates` — em vez
 * de sempre os 8 estados existentes) e monta a expressão `enable` de cada
 * um. Manter essa lista enxuta é o que evita montar 8 cadeias completas de
 * scale+rotate+overlay no filter_complex quando a cena só usa 2 ou 3
 * bocas — cada estado fora da lista simplesmente não gasta memória/CPU do
 * ffmpeg, já que nem chega a virar input/filtro.
 */
function buildMouthEnableExpressions(
  cues: MouthCue[],
  states: MouthState[],
  characterGateExpr: string,
  maxStates: number
): Record<MouthState, string> {
  const safeCues = getSafeCues(cues, maxStates);

  const sumFor = (state: MouthState): string => {
    const matching = safeCues.filter((c) => c.state === state);
    if (matching.length === 0) return "0";
    return matching
      .map((c) => `between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})`)
      .join("+");
  };

  const sums = Object.fromEntries(
    states.map((key) => [key, sumFor(key)])
  ) as Record<MouthState, string>;
  const totalSum = states.map((key) => sums[key]).join("+");

  // Portão "estamos num bloco de personagem grande agora?" — ver
  // buildCharacterGateExpr. Multiplicado em toda expressão de boca abaixo:
  // fora dos blocos de personagem, gate = 0 e nenhuma boca fica visível
  // (é isso que faz a imagem aparecer sozinha nos blocos alternados).
  const gate = `gt(${characterGateExpr},0)`;

  const exprs = {} as Record<MouthState, string>;
  for (const key of states) {
    const stateExpr =
      key === "closed"
        ? // "closed" também é o padrão de repouso: fica ativo se
          // explicitamente marcado OU se nenhum dos estados presentes cobre
          // o instante t (ex.: nenhuma cue cobre esse instante — não
          // acontece mais por causa do limite de segurança, já que
          // simplifyCuesToLimit preserva a timeline inteira em vez de
          // zerá-la).
          `gt(${sums.closed},0)+eq(${totalSum},0)`
        : `gt(${sums[key]},0)`;
    exprs[key] = `(${stateExpr})*${gate}`;
  }
  return exprs;
}

/**
 * Estados de boca que realmente aparecem nas cues dessa cena, na ordem
 * fixa de MOUTH_ASSET_KEYS, sempre incluindo "closed" (fallback de
 * repouso/default mesmo que nenhuma cue "closed" explícita exista).
 * Cenas curtas tipicamente usam só 2-4 dos 8 estados — restringir a isso
 * evita montar as cadeias de filtro (e os inputs de imagem correspondentes)
 * dos estados não usados, reduzindo bastante o consumo de memória do
 * ffmpeg por cena.
 */
function getUsedMouthStates(cues: MouthCue[], maxStates: number): MouthState[] {
  const used = new Set<MouthState>(["closed"]);
  for (const c of getSafeCues(cues, maxStates)) used.add(c.state);
  return MOUTH_ASSET_KEYS.filter((key) => used.has(key));
}

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
  /** Timeline real de boca (closed/half/open), derivada de fonemas —
   *  calculada no step "generate-lipsync-scene-N" do Inngest. Ver
   *  src/lib/lipsync/lipsync-service.ts. */
  mouthCues: MouthCue[];
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
  const mouthFrames = await getMascotFrames();

  const duration = await getAudioDuration(scene.audioPath);
  // Blocos alternados "personagem grande" <-> "só imagem" ao longo da
  // duração real do áudio (ver buildAlternatingSegments). É esse portão
  // que faz a personagem sumir/voltar — o resto da cena (Ken Burns na
  // imagem, texto) roda o tempo inteiro por baixo, sem cortes.
  const segments = buildAlternatingSegments(duration);
  const characterGateExpr = buildCharacterGateExpr(segments);
  assertBalancedExpr("character-gate", characterGateExpr);

  // Só os estados de boca que a cena realmente usa (tipicamente 2-4 dos 8) —
  // ver getUsedMouthStates. Evita montar inputs/filtros pros estados que
  // essa cena nunca precisa, principal causa do consumo alto de memória do
  // ffmpeg nessa etapa.
  const usedStates = getUsedMouthStates(scene.mouthCues, MAX_MOUTH_STATES_IMAGE_SCENE);
  const mouthEnableExpr = buildMouthEnableExpressions(
    scene.mouthCues,
    usedStates,
    characterGateExpr,
    MAX_MOUTH_STATES_IMAGE_SCENE
  );
  const rotateExpr = headMotion.buildFfmpegRotateExpr();

  // Personagem centralizada e grande enquanto "fala" (ver
  // BIG_CHARACTER_SIZE) — não é mais uma bolha fixa no canto. Some da tela
  // por completo nos blocos "image" (gate = 0 em mouthEnableExpr).
  const mascotX = `(W-w)/2`;
  const mascotY = `(H-h)/2`;

  // Índices dos inputs do ffmpeg: 0 = imagem da cena, 1 = áudio,
  // 2..N = os estados de boca usados nessa cena, na ordem de MOUTH_ASSET_KEYS.
  const MOUTH_INPUT_BASE = 2;
  const mouthInputIdx = Object.fromEntries(
    usedStates.map((key, i) => [key, MOUTH_INPUT_BASE + i])
  ) as Record<MouthState, number>;

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

  assertBalancedExpr("zoompan:z", zoomExpr);
  assertBalancedExpr("zoompan:x", xExpr);
  assertBalancedExpr("zoompan:y", yExpr);
  for (const key of usedStates) {
    assertBalancedExpr(`overlay:enable(${key})`, mouthEnableExpr[key]);
  }
  assertBalancedExpr("rotate:a", rotateExpr);

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
    // Upscale 1.25x (não mais 1.5x): headroom suficiente de nitidez pro
    // zoompan cortar sem pixelizar (zoom máximo usado é 1.32x), com bem
    // menos pixels por frame passando pelo filter graph — reduz o consumo
    // de memória/CPU do ffmpeg sem depender de aumentar a memória da
    // function na Vercel (fix de custo zero).
    { filter: "scale", options: { w: 2400, h: 1350 }, inputs: "bg1", outputs: "bg2" },
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
    // Frames de boca do mascote realmente usados nessa cena, escalados pro
    // tamanho final da bolha (ver usedStates acima).
    ...usedStates.map((key) => ({
      filter: "scale",
      options: { w: BIG_CHARACTER_SIZE, h: BIG_CHARACTER_SIZE },
      inputs: `${mouthInputIdx[key]}:v`,
      outputs: key,
    })),
    // Leve balanço de cabeça (Fase 1 — ver head-motion-controller.ts):
    // gira os 8 frames do mascote em torno do próprio centro pela mesma
    // expressão senoidal, sem precisar de PNG novo nem de compositor em
    // canvas. `c=none` preenche os cantos expostos pela rotação com
    // transparência (os PNGs do mascote já têm alpha — recorte
    // circular, ver mascot.tsx), e `ow=iw:oh=ih` mantém o tamanho do
    // canvas igual ao original (rotação pequena o suficiente pra não
    // cortar a bolha).
    ...usedStates.map((key) => ({
      filter: "rotate",
      options: { a: rotateExpr, c: "none", ow: "iw", oh: "ih" },
      inputs: key,
      outputs: `${key}R`,
    })),
    // Empilha os 8 estados em overlays sucessivos — "closed" primeiro (é a
    // base/fallback), os outros 7 por cima. Como as expressões `enable` são
    // mutuamente exclusivas (ver buildMouthEnableExpressions), só uma
    // camada fica visível em cada instante t.
    ...usedStates.map((key, i) => {
      const prevOut = i === 0 ? "bg" : "ov" + (i - 1);
      const outName = i === usedStates.length - 1 ? "vout" : "ov" + i;
      return {
        filter: "overlay",
        options: { x: mascotX, y: mascotY, enable: mouthEnableExpr[key] },
        inputs: [prevOut, `${key}R`],
        outputs: outName,
      };
    }),
  ];

  let command = ffmpeg().input(scene.imagePath).inputOptions(["-loop 1"]).input(scene.audioPath);
  for (const key of usedStates) {
    command = command.input(mouthFrames[key]).inputOptions(["-loop 1"]);
  }

  return new Promise((resolve, reject) => {
    command
      .complexFilter(filters)
      .outputOptions([
        "-map [vout]",
        "-map 1:a",
        "-c:v libx264",
        // preset "veryfast" (em vez do default "medium") e threads limitadas:
        // o preset padrão do libx264 usa buffers de lookahead bem maiores —
        // essa era outra fonte de consumo de memória do ffmpeg dentro da
        // function. Troca de custo zero (não precisa aumentar memória na
        // Vercel), só perde um pouco de eficiência de compressão.
        "-preset veryfast",
        "-threads 2",
        "-c:a aac",
        "-b:a 192k",
        // Fixo em todos os clipes (aqui, renderSceneClipVideo e
        // renderIntroClip) — necessário pro concatFinalVideo funcionar.
        // O concat final usa "-c copy" (sem re-encode); se cada clipe
        // herdar o sample rate/canais do seu áudio de origem (TTS sai em
        // 24kHz mono, o silêncio do intro em 44.1kHz estéreo), o áudio
        // concatenado fica inconsistente entre os trechos e o player toca
        // o vídeo inteiro mudo/quebrado, mesmo cada clipe individual
        // estando correto.
        "-ar 44100",
        "-ac 2",
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
  /** Timeline real de boca (fonemas via Rhubarb/heurística), a mesma usada
   *  em renderSceneClip — ver src/lib/lipsync/. */
  mouthCues: MouthCue[];
}

/**
 * Gera um clipe de vídeo (mp4) para UMA cena que usa um vídeo de banco real
 * como fundo (em vez de imagem estática + Ken Burns) — ver
 * RenderVideoScene. Mesma lógica de mascote falando de renderSceneClip
 * (timeline real de fonemas via scene.mouthCues, só os estados de boca que
 * a cena realmente usa), só troca a origem do "fundo": aqui é vídeo
 * decodificado quadro a quadro, não uma imagem com zoompan.
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

  // Duração real do áudio, usada para travar explicitamente (`-t`) o input
  // de vídeo em loop (`-stream_loop -1`) logo abaixo. Sem isso, o `-shortest`
  // no output É o único limite, mas ele só corta DEPOIS de codificar — o
  // decoder do vídeo de fundo em loop infinito pode ficar lendo/decodificando
  // adiantado (buffer de sincronismo A/V do filtergraph) sem um teto claro,
  // o que foi outra fonte de pico de memória do ffmpeg identificada nas
  // cenas com vídeo de banco. Com `-t` explícito, o decoder já sabe o
  // tamanho exato do trecho a produzir.
  const audioDurationSeconds = await getAudioDuration(scene.audioPath);
  const mouthFrames = await getMascotFrames();

  // Mesmos blocos alternados "personagem grande" <-> "só vídeo de banco"
  // usados em renderSceneClip — ver buildAlternatingSegments.
  const segments = buildAlternatingSegments(audioDurationSeconds);
  const characterGateExpr = buildCharacterGateExpr(segments);
  assertBalancedExpr("character-gate", characterGateExpr);

  // Estados de boca que a cena realmente usa (ver getUsedMouthStates em
  // renderSceneClip) — mesma timeline real de fonemas, não mais um ciclo
  // artificial baseado só em detectar silêncio. Era essa a causa do
  // lipsync "errado" nas cenas com vídeo de banco: a boca girava num ciclo
  // fixo de 4 passos (fechada/meio/aberta/meio) só quando havia áudio,
  // sem relação nenhuma com o fonema sendo falado naquele instante.
  const usedStates = getUsedMouthStates(scene.mouthCues, MAX_MOUTH_STATES_VIDEO_SCENE);
  const mouthEnableExpr = buildMouthEnableExpressions(
    scene.mouthCues,
    usedStates,
    characterGateExpr,
    MAX_MOUTH_STATES_VIDEO_SCENE
  );
  const rotateExpr = headMotion.buildFfmpegRotateExpr();

  for (const key of usedStates) {
    assertBalancedExpr(`overlay:enable(${key})`, mouthEnableExpr[key]);
  }
  assertBalancedExpr("rotate:a", rotateExpr);

  const mascotX = `(W-w)/2`;
  const mascotY = `(H-h)/2`;

  // Índices dos inputs: 0 = vídeo de fundo (em loop), 1 = áudio da
  // narração, 2 = overlay de texto transparente, 3..N = estados de boca
  // usados nessa cena (ver usedStates).
  const overlayInputIdx = 2;
  const MOUTH_INPUT_BASE = 3;
  const mouthInputIdx = Object.fromEntries(
    usedStates.map((key, i) => [key, MOUTH_INPUT_BASE + i])
  ) as Record<MouthState, number>;

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
    // Frames de boca do mascote realmente usados nessa cena.
    ...usedStates.map((key) => ({
      filter: "scale",
      options: { w: BIG_CHARACTER_SIZE, h: BIG_CHARACTER_SIZE },
      inputs: `${mouthInputIdx[key]}:v`,
      outputs: key,
    })),
    // Mesmo leve balanço de cabeça de renderSceneClip.
    ...usedStates.map((key) => ({
      filter: "rotate",
      options: { a: rotateExpr, c: "none", ow: "iw", oh: "ih" },
      inputs: key,
      outputs: `${key}R`,
    })),
    ...usedStates.map((key, i) => {
      const prevOut = i === 0 ? "ovtext" : "ov" + (i - 1);
      const outName = i === usedStates.length - 1 ? "vout" : "ov" + i;
      return {
        filter: "overlay",
        options: { x: mascotX, y: mascotY, enable: mouthEnableExpr[key] },
        inputs: [prevOut, `${key}R`],
        outputs: outName,
      };
    }),
  ];

  let command = ffmpeg()
    .input(scene.videoPath)
    .inputOptions(["-stream_loop -1", `-t ${(audioDurationSeconds + 0.5).toFixed(2)}`])
    .input(scene.audioPath)
    .input(scene.overlayImagePath)
    .inputOptions(["-loop 1"]);
  for (const key of usedStates) {
    command = command.input(mouthFrames[key]).inputOptions(["-loop 1"]);
  }

  return new Promise((resolve, reject) => {
    command
      .complexFilter(filters)
      .outputOptions([
        "-map [vout]",
        "-map 1:a",
        "-c:v libx264",
        // preset "veryfast" (em vez do default "medium") e threads limitadas:
        // o preset padrão do libx264 usa buffers de lookahead bem maiores —
        // essa era outra fonte de consumo de memória do ffmpeg dentro da
        // function. Troca de custo zero (não precisa aumentar memória na
        // Vercel), só perde um pouco de eficiência de compressão.
        "-preset veryfast",
        "-threads 1",
        // Este é o filtergraph mais pesado do pipeline (vídeo real em loop
        // decodificado quadro a quadro + overlay de texto + overlay de boca
        // do mascote com rotate) — limitar as threads do filter_complex
        // também (além das threads gerais acima) evita que o ffmpeg aloque
        // buffers de frame extras por thread de filtro rodando em paralelo,
        // outro pico de memória identificado nessas cenas especificamente
        // (eram as que geravam "ran out of available memory" na Vercel).
        "-filter_complex_threads 1",
        "-c:a aac",
        "-b:a 192k",
        // Mesmo motivo do renderSceneClip: fixar sample rate/canais pro
        // concat final ("-c copy") não misturar parâmetros de áudio
        // diferentes entre clipes.
        "-ar 44100",
        "-ac 2",
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
