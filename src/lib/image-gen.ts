// Gera a ilustração de cada cena via Pollinations.ai (endpoint de imagem
// gratuito, sem chave de API e sem cartão de crédito). Trocado do Hugging
// Face porque a conta usada neste projeto esgotou os créditos mensais
// gratuitos de Inference Providers, e do Gemini porque o modelo de imagem
// exige billing habilitado mesmo em uso baixo.
//
// Trade-off consciente: o Pollinations é mantido pela comunidade, sem SLA de
// disponibilidade e com moderação de conteúdo mais simples que provedores
// comerciais — mas não tem teto mensal de créditos nem exige cartão, o que
// resolve o bloqueio atual. Se no futuro for preciso mais confiabilidade,
// dá para trocar de novo por um provedor pago sem mexer no resto do
// pipeline (a função generateSceneImage mantém a mesma assinatura).

import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

const POLLINATIONS_ENDPOINT = "https://image.pollinations.ai/prompt";

const STYLE_SUFFIX =
  "flat vector cartoon illustration, bold clean outlines, simple shapes, bright and friendly color palette, corporate training illustration style, no text or letters or words in the image, square composition";

const MAX_ATTEMPTS = 3;
// Backoff simples entre tentativas (ms). Cobre principalmente erros
// transitórios (503/timeout) do serviço comunitário.
const RETRY_DELAY_MS = 3000;
// Tempo máximo de espera por tentativa: gerações de imagem no Pollinations
// podem demorar mais que uma chamada de API comum, especialmente em horários
// de pico (é um serviço gratuito compartilhado pela comunidade).
const REQUEST_TIMEOUT_MS = 45000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faz UMA chamada de geração de imagem ao Pollinations. Lança erro com
 * mensagem específica e acionável em cada caso de falha conhecido, para que
 * o motivo real fique visível (no log e, a partir de generate-video.ts, no
 * banco/UI) em vez de a cena simplesmente sair sem ilustração.
 */
async function callPollinationsImageApi(prompt: string): Promise<Buffer> {
  const url =
    `${POLLINATIONS_ENDPOINT}/${encodeURIComponent(prompt)}` +
    `?width=1024&height=1024&model=flux&nologo=true&seed=${Math.floor(Math.random() * 1_000_000)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort")) {
      throw new Error(
        `Pollinations: tempo esgotado (${REQUEST_TIMEOUT_MS / 1000}s) esperando a imagem ser gerada.`
      );
    }
    throw new Error(`Pollinations: falha de rede ao chamar a API. Detalhe: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    if (response.status === 429) {
      throw new Error(
        `Pollinations: limite de uso momentâneo atingido (429). Detalhe: ${errText}`
      );
    }
    throw new Error(`Pollinations Image API falhou (${response.status}): ${errText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Pollinations não retornou uma imagem utilizável (content-type inesperado: ${contentType}). Detalhe: ${text.slice(0, 300)}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error("Pollinations retornou uma imagem vazia para a cena.");
  }
  return Buffer.from(arrayBuffer);
}

/**
 * Gera uma imagem PNG/JPEG (cartoon) para uma cena com base num prompt
 * visual, salva em um arquivo temporário e retorna o caminho local.
 *
 * Faz até MAX_ATTEMPTS tentativas antes de desistir, pois falhas transitórias
 * (timeout em horário de pico, 5xx momentâneo) são comuns nesse serviço
 * gratuito comunitário e não devem derrubar a ilustração da cena inteira na
 * primeira tentativa.
 */
export async function generateSceneImage(imagePrompt: string): Promise<string> {
  const prompt = imagePrompt.toLowerCase().includes("cartoon")
    ? imagePrompt
    : `${imagePrompt}. ${STYLE_SUFFIX}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buffer = await callPollinationsImageApi(prompt);
      const outPath = path.join(os.tmpdir(), `scene-img-${nanoid(8)}.png`);
      await fs.writeFile(outPath, buffer);
      return outPath;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `generateSceneImage: tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${message}`
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Falha desconhecida ao gerar imagem da cena.");
}
