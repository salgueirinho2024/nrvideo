// Busca vídeos de banco (Pexels) que combinem com o tema de uma cena, para
// as poucas cenas mais fortes do roteiro (ver gemini.ts: `useStockVideo` e
// `videoSearchQuery`). Usado como alternativa à ilustração estática +
// Ken Burns (ver image-gen.ts) quando o roteirista (Gemini) decide que uma
// cena específica merece um clipe de vídeo real em vez de uma imagem parada
// — ex.: uma cena mostrando o uso de um EPI específico.
//
// Por que Pexels: tier gratuito genuíno (sem cartão), API simples, e o
// catálogo tem bastante conteúdo de "workplace safety", "construction
// worker", "ppe" etc. — tema comum o suficiente pra treinamentos de NR.
// Trade-off consciente (documentado também no README): não é geração sob
// medida — é busca num banco de vídeos reais, então a aderência ao roteiro
// específico depende do que existe no catálogo pra aquela query. Se no
// futuro for preciso vídeo gerado sob medida por IA, dá pra trocar essa
// função por uma chamada a um provedor de text-to-video sem mexer no resto
// do pipeline (mesma assinatura: query em texto -> caminho de arquivo local).

import path from "path";
import os from "os";
import fs, { promises as fsPromises } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { nanoid } from "nanoid";

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PEXELS_SEARCH_URL = "https://api.pexels.com/videos/search";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20000;
const BASE_RETRY_DELAY_MS = 2500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PexelsVideoFile {
  quality: string; // "hd" | "sd" | "hls" ...
  width: number | null;
  height: number | null;
  link: string;
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  video_files: PexelsVideoFile[];
}

interface PexelsSearchResponse {
  videos?: PexelsVideo[];
}

export interface StockVideoResult {
  path: string;
  /** ID do clipe na Pexels — usado pelo chamador (generate-video.ts) para
   *  não repetir o MESMO clipe em duas cenas do mesmo vídeo (ver
   *  `excludeIds` abaixo). */
  videoId: number;
}

/**
 * Escolhe o melhor arquivo dentro das variantes que a Pexels retorna por
 * clipe: paisagem (largura >= altura, já que o vídeo final é 16:9), e
 * resolução HD (720p-1080p) — suficiente pro composite final sem baixar
 * arquivos 4K desnecessariamente grandes/lentos.
 */
function pickBestVideoFile(files: PexelsVideoFile[]): PexelsVideoFile | null {
  const withSize = files.filter(
    (f): f is PexelsVideoFile & { width: number; height: number } =>
      typeof f.width === "number" && typeof f.height === "number"
  );
  if (withSize.length === 0) return null;

  const landscape = withSize.filter((f) => f.width >= f.height);
  const candidates = landscape.length > 0 ? landscape : withSize;

  // Teto rebaixado para 720p (era até 1920 largura, ou seja, permitia
  // Full HD): o vídeo de banco passa por decode + scale + crop + overlay
  // (com boca do mascote animada por cima) dentro do MESMO processo ffmpeg
  // em renderSceneClipVideo — decodificar 1080p nesse filtergraph mais
  // pesado foi identificado como o principal ponto de pico de memória que
  // levava a function a "ran out of available memory" na Vercel, mesmo já
  // com preset/threads reduzidos. 720p é mais que suficiente já que o
  // output final também sai em 1920x1080 via upscale no próprio scale.
  const hd = candidates.filter((f) => f.width >= 960 && f.width <= 1280);
  const pool = hd.length > 0 ? hd : candidates;

  return pool.sort((a, b) => b.width - a.width)[0];
}

/**
 * Busca na Pexels um vídeo de banco que combine com `query` (palavras-chave
 * em inglês, geradas pelo Gemini — ver gemini.ts) e baixa o arquivo pra um
 * caminho temporário. Lança erro se não conseguir (chave ausente, sem
 * resultado, falha de rede) — o chamador (generate-video.ts) trata isso
 * caindo de volta pra ilustração estática da cena, igual já faz hoje quando
 * a geração de imagem falha.
 *
 * `excludeIds`: IDs de clipes da Pexels já usados em OUTRAS cenas do MESMO
 * vídeo sendo gerado (ver generate-video.ts) — evita que duas cenas
 * diferentes do mesmo treinamento acabem mostrando o mesmo clipe de banco
 * repetido (relatado como "os vídeos... às vezes nem batem" / repetição).
 * Se todos os resultados da busca já tiverem sido usados, cai pro primeiro
 * mesmo assim (repetir é melhor que a cena ficar sem nada).
 */
export async function fetchStockVideo(
  query: string,
  excludeIds: number[] = []
): Promise<StockVideoResult> {
  if (!PEXELS_API_KEY) {
    throw new Error(
      "PEXELS_API_KEY não configurada. Crie uma chave grátis (sem cartão) em " +
        "https://www.pexels.com/api/ e configure essa variável de ambiente."
    );
  }

  const url = `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&orientation=landscape&size=medium&per_page=6`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: PEXELS_API_KEY },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Pexels: autenticação falhou (${res.status}). Confira se PEXELS_API_KEY está correta.`
        );
      }

      if (res.status === 429) {
        // Tier grátis da Pexels: 200 requisições/hora, 20.000/mês. Vale
        // esperar um pouco e tentar de novo antes de desistir da cena.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new Error("Pexels: rate limit (429) esgotou as tentativas.");
      }

      if (!res.ok) {
        throw new Error(`Pexels: busca falhou (${res.status}) para a query "${query}".`);
      }

      const data = (await res.json()) as PexelsSearchResponse;
      const videos = data.videos ?? [];
      if (videos.length === 0) {
        throw new Error(`Pexels: nenhum vídeo encontrado para a query "${query}".`);
      }

      // Prioriza resultados que ainda não foram usados em outra cena deste
      // mesmo vídeo (ver excludeIds acima); se sobrar só clipe repetido,
      // usa mesmo assim (ordem original preservada como fallback).
      const unused = videos.filter((v) => !excludeIds.includes(v.id));
      const orderedVideos = unused.length > 0 ? unused : videos;

      // Tenta os resultados em ordem até achar um com arquivo baixável.
      for (const video of orderedVideos) {
        const file = pickBestVideoFile(video.video_files ?? []);
        if (!file) continue;

        const videoController = new AbortController();
        const videoTimeout = setTimeout(() => videoController.abort(), REQUEST_TIMEOUT_MS);
        let videoRes: Response;
        try {
          videoRes = await fetch(file.link, { signal: videoController.signal });
        } finally {
          clearTimeout(videoTimeout);
        }
        if (!videoRes.ok || !videoRes.body) continue;

        // Streaming direto pro disco (não Buffer.from(arrayBuffer()) inteiro
        // em memória) — vídeos HD da Pexels passam facilmente de 20-50MB, e
        // isso empilhado com o resto do pipeline (ffmpeg etc.) era a causa
        // raiz do "ran out of available memory" na Vercel. Mesmo padrão já
        // usado em downloadToTemp (ver download.ts) e uploadFile (storage.ts).
        const outPath = path.join(os.tmpdir(), `stock-video-${nanoid(8)}.mp4`);
        try {
          await pipeline(
            Readable.fromWeb(videoRes.body as import("stream/web").ReadableStream),
            fs.createWriteStream(outPath)
          );
        } catch {
          await fsPromises.unlink(outPath).catch(() => undefined);
          continue;
        }

        const stat = await fsPromises.stat(outPath).catch(() => null);
        if (!stat || stat.size === 0) {
          await fsPromises.unlink(outPath).catch(() => undefined);
          continue;
        }

        return { path: outPath, videoId: video.id };
      }

      throw new Error(
        `Pexels: resultados encontrados para "${query}", mas nenhum arquivo de vídeo baixável.`
      );
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`fetchStockVideo: tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Falha desconhecida ao buscar vídeo de banco.");
}
