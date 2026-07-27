// Gera a ilustração de cada cena chamando a Inference API do Hugging Face
// (modelo FLUX.1-schnell, provider "hf-inference"). Trocado do Gemini Image
// porque, na conta usada neste projeto, o modelo de imagem do Gemini exige
// billing habilitado mesmo em uso baixo (quota 0 no free tier) — o Hugging
// Face tem um free tier real, sem cartão de crédito, para este tipo de uso.

import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

// Modelo rápido e leve, ótimo para ilustração estilo cartoon/vetorial;
// disponível no free tier do Hugging Face via provider "hf-inference".
const IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell";
const HF_ENDPOINT = `https://api-inference.huggingface.co/models/${IMAGE_MODEL}`;

const STYLE_SUFFIX =
  "flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters or words in the image, square composition";

const MAX_ATTEMPTS = 3;
// Backoff simples entre tentativas (ms). Cobre principalmente erros
// transitórios (429/5xx) e o modelo "esquentando" (503 model loading).
const RETRY_DELAY_MS = 3000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faz UMA chamada à Inference API do Hugging Face. Lança erro com mensagem
 * específica e acionável em cada caso de falha conhecido, para que o motivo
 * real fique visível (no log e, a partir de generate-video.ts, no banco/UI)
 * em vez de a cena simplesmente sair sem ilustração.
 */
async function callHuggingFaceImageApi(prompt: string, apiKey: string): Promise<Buffer> {
  const response = await fetch(HF_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        width: 1024,
        height: 1024,
      },
    }),
  });

  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    const errText = await response.text();
    // 401/403: token inválido ou sem permissão de "Inference Providers".
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Hugging Face recusou o token (${response.status}). Verifique se HUGGINGFACE_API_KEY é válido e tem permissão "Make calls to Inference Providers". Detalhe: ${errText}`
      );
    }
    // 429: limite do free tier atingido (cota mensal de créditos).
    if (response.status === 429) {
      throw new Error(
        `Hugging Face: limite de quota/rate atingido (429). Detalhe: ${errText}`
      );
    }
    // 503: modelo "frio", ainda carregando no provider — normal na primeira
    // chamada depois de um tempo sem uso; vale tentar de novo.
    if (response.status === 503) {
      throw new Error(`Hugging Face: modelo ainda carregando (503). Detalhe: ${errText}`);
    }
    throw new Error(`Hugging Face Image API falhou (${response.status}): ${errText}`);
  }

  // Quando dá certo, a resposta é a imagem crua (bytes), não JSON.
  if (!contentType.startsWith("image/")) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Hugging Face não retornou uma imagem utilizável para a cena (content-type inesperado: ${contentType}). Detalhe: ${text.slice(0, 300)}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
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
