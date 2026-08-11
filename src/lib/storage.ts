import { put } from "@vercel/blob";
import fs from "fs";

/**
 * Envia um arquivo local para o Vercel Blob e retorna a URL pública.
 *
 * Autenticação: desde que o Blob store esteja conectado ao projeto na Vercel,
 * o SDK (@vercel/blob >= 2.x) autentica automaticamente via OIDC usando as
 * variáveis BLOB_STORE_ID + VERCEL_OIDC_TOKEN — não é mais necessário um
 * BLOB_READ_WRITE_TOKEN estático. Isso só é obrigatório se você rodar este
 * código fora da Vercel (ex: localmente sem `vercel env pull`).
 *
 * IMPORTANTE: sobe via stream (`fs.createReadStream` + `multipart: true`) em
 * vez de `fs.readFile` + Buffer inteiro em memória. Com clipes/vídeo final
 * podendo passar de dezenas ou centenas de MB, ler o arquivo inteiro pra RAM
 * antes de cada upload (em cima de tudo que já está em memória no passo de
 * concat) foi a causa raiz do "ran out of available memory" na Vercel.
 */
export async function uploadFile(
  localPath: string,
  destName: string,
  contentType: string
): Promise<string> {
  const stream = fs.createReadStream(localPath);
  const blob = await put(destName, stream, {
    access: "public",
    contentType,
    addRandomSuffix: true,
    multipart: true,
  });
  return blob.url;
}
