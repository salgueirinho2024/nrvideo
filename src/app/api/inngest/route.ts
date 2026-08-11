import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { generateVideoFunction } from "@/inngest/functions/generate-video";

// Cada etapa do pipeline (TTS, geração de imagem, render de clipe, etc.)
// roda dentro de uma invocação desta rota. Com vídeos mais longos (mais
// cenas), algumas etapas — principalmente concat-and-upload-video, que
// baixa TODOS os clipes já renderizados antes de juntar — podem passar
// fácil de 5 minutos. Subimos para 800s (teto disponível em planos
// Pro/Enterprise com Fluid Compute, sem custo adicional de plano — é só
// configuração de limite, o billing continua por uso).
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [generateVideoFunction],
});
