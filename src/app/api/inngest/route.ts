import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { generateVideoFunction } from "@/inngest/functions/generate-video";

// Cada etapa do pipeline (TTS, geração de imagem, render de clipe, etc.)
// roda dentro de uma invocação desta rota. Com vídeos mais longos (mais
// cenas), algumas etapas — principalmente renderizar um clipe ou concatenar
// vários — podem demorar mais que o padrão de 10s da Vercel. Aumente aqui
// conforme o plano da Vercel (Hobby: até 60s; Pro: até 300s; Enterprise:
// até 900s).
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [generateVideoFunction],
});
