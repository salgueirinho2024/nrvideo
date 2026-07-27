// Detecta o formato real de uma imagem pelos magic bytes (assinatura binária
// no início do arquivo), em vez de confiar na extensão do arquivo ou em
// suposições do provedor. Necessário porque o Pollinations às vezes retorna
// JPEG mesmo quando a URL/uso esperado era PNG — se o resto do pipeline
// (slides.tsx) rotula esse buffer como PNG na data URI, o satori/resvg
// recebe bytes que não conferem com o mime declarado, falha em decodificar
// silenciosamente, e o slide é renderizado sem a ilustração, sem erro algum.

export type DetectedImageFormat = {
  mime: string;
  ext: "png" | "jpg" | "webp" | "gif";
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF_SIGNATURES = ["GIF87a", "GIF89a"];

function bufferStartsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Inspeciona os primeiros bytes do buffer e retorna o mime/extensão reais.
 * Faz fallback para PNG apenas se nenhuma assinatura conhecida bater (mantém
 * o comportamento anterior nesse caso raro, em vez de lançar erro e derrubar
 * a cena inteira por um formato não reconhecido mas potencialmente válido).
 */
export function detectImageFormat(buf: Buffer): DetectedImageFormat {
  if (bufferStartsWith(buf, PNG_SIGNATURE)) {
    return { mime: "image/png", ext: "png" };
  }
  if (bufferStartsWith(buf, JPEG_SIGNATURE)) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (
    buf.length >= 6 &&
    GIF_SIGNATURES.includes(buf.toString("ascii", 0, 6))
  ) {
    return { mime: "image/gif", ext: "gif" };
  }
  return { mime: "image/png", ext: "png" };
}
