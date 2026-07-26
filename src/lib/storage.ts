import { put } from "@vercel/blob";
import { promises as fs } from "fs";

/**
 * Envia um arquivo local para o Vercel Blob e retorna a URL pública.
 * Requer a variável de ambiente BLOB_READ_WRITE_TOKEN (criada automaticamente
 * pela Vercel ao conectar um Blob store ao projeto).
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
