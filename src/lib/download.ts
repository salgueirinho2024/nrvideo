import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

/**
 * Baixa um arquivo remoto (ex: Vercel Blob) para um caminho local temporário.
 * Necessário porque, em funções Inngest com múltiplos passos, cada passo pode
 * ser executado em uma invocação/instância diferente da função — arquivos
 * temporários de um passo anterior não sobrevivem entre passos. Por isso cada
 * etapa que precisa de um arquivo gerado antes o rebaixa a partir da sua URL.
 */
export async function downloadToTemp(
  url: string,
  extension: string
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Falha ao baixar arquivo (${res.status}): ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const outPath = path.join(os.tmpdir(), `dl-${nanoid(8)}.${extension}`);
  await fs.writeFile(outPath, buffer);
  return outPath;
}
