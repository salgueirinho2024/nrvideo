import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

// Status possíveis de um projeto de vídeo, na ordem em que acontecem
export const PROJECT_STATUS = [
  "pending", // criado, aguardando início do pipeline
  "generating_script", // Gemini gerando o roteiro
  "generating_assets", // gerando áudio (TTS) e slides de cada cena
  "rendering", // FFmpeg montando o vídeo final
  "done", // vídeo pronto
  "error", // falhou em alguma etapa
] as const;

export type ProjectStatus = (typeof PROJECT_STATUS)[number];

export const projects = pgTable("projects", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid(12)),
  title: text("title").notNull(),
  // Texto bruto da NR colado pelo usuário
  sourceText: text("source_text").notNull(),
  voice: text("voice").notNull().default("pt-BR-FranciscaNeural"),
  // Duração alvo do vídeo, em minutos (usada para calibrar quantas cenas o
  // Gemini deve gerar). Padrão de 5 min; suporta até 15 min.
  targetMinutes: integer("target_minutes").notNull().default(5),
  status: text("status").$type<ProjectStatus>().notNull().default("pending"),
  errorMessage: text("error_message"),
  // URL do vídeo final no Vercel Blob, quando pronto
  videoUrl: text("video_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const scenes = pgTable("scenes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid(12)),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  order: integer("order").notNull(),
  // Texto que será narrado (vira áudio)
  narrationText: text("narration_text").notNull(),
  // Texto curto exibido na tela (título/bullet do slide)
  screenText: text("screen_text").notNull(),
  // Descrição visual (em inglês) usada para gerar a ilustração cartoon da
  // cena via IA. Ver src/lib/image-gen.ts.
  imagePrompt: text("image_prompt").notNull().default(""),
  // Guarda o motivo da falha quando a ilustração da cena não pôde ser
  // gerada (ex: API key ausente, quota, bloqueio de safety). Fica null
  // quando a imagem foi gerada com sucesso. Ver src/lib/image-gen.ts.
  imageError: text("image_error"),
  // Marca cenas que o Gemini considerou as mais importantes do roteiro.
  // Usada em render.ts para aplicar um Ken Burns mais dinâmico (pan
  // diagonal + zoom mais forte) só nessas cenas, dando destaque visual sem
  // depender de nenhum gerador de vídeo por IA (ver src/lib/render.ts).
  highlight: boolean("highlight").notNull().default(false),
  // true para até 3 cenas do roteiro (ver src/lib/gemini.ts) que devem usar
  // um clipe de vídeo real de banco de imagens (Pexels) como fundo, em vez
  // da ilustração cartoon estática. Ver src/lib/stock-video.ts.
  useStockVideo: boolean("use_stock_video").notNull().default(false),
  // Palavras-chave (em inglês) usadas para buscar o vídeo de banco, quando
  // useStockVideo = true.
  videoSearchQuery: text("video_search_query"),
  // URL do clipe de vídeo de banco baixado para esta cena (Vercel Blob).
  // Fica null se a cena não usa vídeo de banco, ou se a busca falhou (nesse
  // caso a cena cai de volta pra ilustração estática — ver videoError).
  sceneVideoUrl: text("scene_video_url"),
  // Guarda o motivo da falha quando a busca/download do vídeo de banco não
  // deu certo (ex: sem PEXELS_API_KEY, sem resultado para a query). Fica
  // null quando não houve erro. Ver src/lib/stock-video.ts.
  videoError: text("video_error"),
  audioUrl: text("audio_url"),
  audioDurationSeconds: integer("audio_duration_seconds"),
  slideImageUrl: text("slide_image_url"),
  assetsReady: boolean("assets_ready").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Guarda o JSON bruto do roteiro retornado pelo Gemini, útil para depuração/reprocessamento
export const scriptLogs = pgTable("script_logs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid(12)),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  rawResponse: jsonb("raw_response").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
