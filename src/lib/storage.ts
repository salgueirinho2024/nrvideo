import { put } from "@vercel/blob";
import { promises as fs } from "fs";

/**
 * Envia um arquivo local para o Vercel Blob e retorna a URL pública.
 *
 * Autenticação: desde que o Blob store esteja conectado ao projeto na Vercel,
 * o SDK (@vercel/blob >= 2.x) autentica automaticamente via OIDC usando as
 * variáveis BLOB_STORE_ID + VERCEL_OIDC_TOKEN — não é mais necessário um
 * BLOB_READ_WRITE_TOKEN estático. Isso só é obrigatório se você rodar este
 * código fora da Vercel (ex: localmente sem `vercel env pull`).
 */
export async function uploadFile(
  localPath: string,
  destName: string,
  contentType: string
): Promise<string> {
  const buffer = await fs.readFile(localPath);
  const blob = await put(destName, buffer, {
    access: "public",
    contentType,
    addRandomSuffix: true,
  });
  return blob.url;
}
