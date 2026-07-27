// Gera a ilustração de cada cena via Hugging Face Inference Providers
// (modelo FLUX.1-schnell, provider "fal-ai"). Usa a biblioteca oficial
// @huggingface/inference em vez de montar a URL na mão: a HF migrou o
// endpoint legado (api-inference.huggingface.co) para um sistema de
// "provedores" via router.huggingface.co, onde cada provedor tem um
// formato de requisição ligeiramente diferente — a lib cuida disso
// automaticamente (é o que a doc oficial recomenda para não quebrar quando
// o roteamento interno mudar de novo).
//
// Trocado do Gemini Image porque, na conta usada neste projeto, o modelo de
// imagem do Gemini exige billing habilitado mesmo em uso baixo (quota 0 no
// free tier) — o Hugging Face tem um free tier real, sem cartão de crédito.

import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { InferenceClient } from "@huggingface/inference";

// Modelo rápido e leve, ótimo para ilustração estilo cartoon/vetorial.
const IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell";
// Provedor que serve esse modelo com boa disponibilidade no free tier da HF.
const PROVIDER = "fal-ai";

const STYLE_SUFFIX =
  "flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters or words in the image, square composition";

const MAX_ATTEMPTS = 3;
// Backoff simples entre tentativas (ms). Cobre principalmente erros
// transitórios (429/5xx) e o modelo "esquentando" no provedor.
const RETRY_DELAY_MS = 3000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faz UMA chamada de geração de imagem via Hugging Face. Lança erro com
 * mensagem específica e acionável em cada caso de falha conhecido, para que
 * o motivo real fique visível (no log e, a partir de generate-video.ts, no
 * banco/UI) em vez de a cena simplesmente sair sem ilustração.
 */
async function callHuggingFaceImageApi(prompt: string, apiKey: string): Promise<Buffer> {
  const client = new InferenceClient(apiKey);

  let blob: Blob;
  try {
    blob = await client.textToImage(
      {
        model: IMAGE_MODEL,
        provider: PROVIDER,
        inputs: prompt,
      },
      { outputType: "blob" }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err && typeof err === "object" && "httpResponse" in err
        ? (err as { httpResponse?: { status?: number } }).httpResponse?.status
        : undefined;

    if (status === 401 || status === 403 || /unauthorized|forbidden/i.test(message)) {
      throw new Error(
        `Hugging Face recusou o token (${status ?? "auth"}). Verifique se HUGGINGFACE_API_KEY é válido e tem permissão "Make calls to Inference Providers". Detalhe: ${message}`
      );
    }
    if (status === 429 || /rate.?limit|quota/i.test(message)) {
      throw new Error(`Hugging Face: limite de quota/rate atingido. Detalhe: ${message}`);
    }
    if (status === 503 || /loading|warm(ing)? ?up/i.test(message)) {
      throw new Error(`Hugging Face: modelo ainda carregando no provedor. Detalhe: ${message}`);
    }
    throw new Error(`Hugging Face Image API falhou (${status ?? "sem status"}): ${message}`);
  }

  const arrayBuffer = await blob.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error("Hugging Face retornou uma imagem vazia para a cena.");
  }
  return Buffer.from(arrayBuffer);
}

/**
 * Gera uma imagem PNG (cartoon) para uma cena com base num prompt visual,
 * salva em um arquivo temporário e retorna o caminho local.
 *
 * Faz até MAX_ATTEMPTS tentativas antes de desistir, pois falhas transitórias
 * (modelo carregando, quota momentânea) são comuns e não devem derrubar a
 * ilustração da cena inteira na primeira tentativa.
 */
export async function generateSceneImage(imagePrompt: string): Promise<string> {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "HUGGINGFACE_API_KEY não configurada no ambiente onde o worker roda (verifique as env vars do projeto/Inngest)."
    );
  }

  const prompt = imagePrompt.toLowerCase().includes("cartoon")
    ? imagePrompt
    : `${imagePrompt}. ${STYLE_SUFFIX}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buffer = await callHuggingFaceImageApi(prompt, apiKey);
      const outPath = path.join(os.tmpdir(), `scene-img-${nanoid(8)}.png`);
      await fs.writeFile(outPath, buffer);
      return outPath;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `generateSceneImage: tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${message}`
      );
      // Token ausente/inválido não se resolve tentando de novo.
      if (message.includes("HUGGINGFACE_API_KEY") || message.includes("recusou o token")) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Falha desconhecida ao gerar imagem da cena.");
}
