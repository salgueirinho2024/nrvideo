import path from "path";
import os from "os";
import fs from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { nanoid } from "nanoid";

/**
 * Baixa um arquivo remoto (ex: Vercel Blob) para um caminho local temporário.
 * Necessário porque, em funções Inngest com múltiplos passos, cada passo pode
 * ser executado em uma invocação/instância diferente da função — arquivos
 * temporários de um passo anterior não sobrevivem entre passos. Por isso cada
 * etapa que precisa de um arquivo gerado antes o rebaixa a partir da sua URL.
 *
 * IMPORTANTE: faz streaming direto pro disco (não carrega o arquivo inteiro
 * em memória com `res.arrayBuffer()`). Vídeos de banco (Pexels) e clipes já
 * renderizados podem ter dezenas/centenas de MB — bufferizar isso inteiro na
 * RAM da function, cena após cena, foi a causa raiz de "ran out of available
 * memory" na Vercel.
 */
export async function downloadToTemp(
  url: string,
  extension: string
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Falha ao baixar arquivo (${res.status}): ${url}`);
  }
  const outPath = path.join(os.tmpdir(), `dl-${nanoid(8)}.${extension}`);
  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    fs.createWriteStream(outPath)
  );
  return outPath;
}

