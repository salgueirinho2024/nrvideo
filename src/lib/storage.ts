import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// --- Cloudflare R2 (substituiu o Vercel Blob) ---
// R2 é compatível com a API do S3, então usamos o SDK oficial da AWS
// apontando pro endpoint da Cloudflare. Mesma conta Cloudflare já usada
// pra Workers AI (CLOUDFLARE_ACCOUNT_ID, ver image-gen.ts) — só precisa
// criar um bucket R2 + um API Token específico pra ele (são credenciais
// diferentes das do Workers AI). Motivo da troca: o Vercel Blob no plano
// Hobby tem um teto mensal de operações que, ao ser atingido, suspende o
// store inteiro até a data de reset (não é proporcional ao quanto você
// apaga) — ver aviso "You have reached your usage limits" no dashboard.
const R2_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
// URL pública do bucket, SEM barra no final — o subdomínio pub-xxx.r2.dev
// (ativado em R2 > seu bucket > Settings > Public access) ou um domínio
// customizado que você tenha ligado ao bucket.
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");

function getClient(): S3Client {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "Cloudflare R2: CLOUDFLARE_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY " +
        "não configurados. Ver .env.example."
    );
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Envia um arquivo local para o Cloudflare R2 e retorna a URL pública.
 *
 * IMPORTANTE: usa `Upload` de @aws-sdk/lib-storage (multipart em stream) em
 * vez de `fs.readFile` + Buffer inteiro em memória. Com clipes/vídeo final
 * podendo passar de dezenas ou centenas de MB, ler o arquivo inteiro pra RAM
 * antes de cada upload (em cima de tudo que já está em memória no passo de
 * concat) foi a causa raiz do "ran out of available memory" na Vercel — o
 * mesmo cuidado que já existia com o Vercel Blob (ver download.ts).
 *
 * `destName` é o "caminho" desejado (ex: `${projectId}/scene-1-audio.mp3`);
 * um sufixo aleatório é adicionado antes da extensão pra evitar colisão,
 * reproduzindo o `addRandomSuffix: true` que o Vercel Blob fazia sozinho.
 */
export async function uploadFile(
  localPath: string,
  destName: string,
  contentType: string
): Promise<string> {
  if (!R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    throw new Error(
      "Cloudflare R2: R2_BUCKET_NAME / R2_PUBLIC_URL não configurados. Ver .env.example."
    );
  }
  const ext = path.extname(destName);
  const base = destName.slice(0, destName.length - ext.length);
  const key = `${base}-${randomUUID().slice(0, 8)}${ext}`;

  const upload = new Upload({
    client: getClient(),
    params: {
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: contentType,
    },
  });
  await upload.done();
  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Apaga uma lista de arquivos do Cloudflare R2 (ex: os assets de um projeto
 * excluído), a partir das URLs públicas salvas no banco. `DeleteObjectsCommand`
 * aceita até 1000 chaves por chamada e é idempotente — chave que já não
 * existe não gera erro. Best-effort: se o bucket estiver indisponível por
 * qualquer motivo, a exclusão do projeto no banco não deve travar por causa
 * disso — só loga o problema.
 */
export async function deleteFiles(urls: string[]): Promise<void> {
  const valid = urls.filter((u): u is string => Boolean(u));
  if (valid.length === 0 || !R2_BUCKET_NAME || !R2_PUBLIC_URL) return;

  const keys = valid
    .map((u) => (u.startsWith(`${R2_PUBLIC_URL}/`) ? u.slice(R2_PUBLIC_URL.length + 1) : null))
    .filter((k): k is string => Boolean(k));
  if (keys.length === 0) return;

  try {
    const client = getClient();
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await client.send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET_NAME,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        })
      );
    }
  } catch (err) {
    console.error("Falha ao apagar arquivos do Cloudflare R2:", err);
  }
}
