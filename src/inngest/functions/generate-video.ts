import { inngest } from "../client";
import { db } from "@/db";
import { projects, scenes, scriptLogs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateScript } from "@/lib/gemini";
import { synthesizeSpeech } from "@/lib/tts";
import { generateSlideImage } from "@/lib/slides";
import { uploadFile } from "@/lib/storage";
import { downloadToTemp } from "@/lib/download";
import { getAudioDuration, renderFinalVideo } from "@/lib/render";
import { promises as fsPromises } from "fs";

export const generateVideoFunction = inngest.createFunction(
  {
    id: "generate-nr-video",
    retries: 2,
    // Se todas as tentativas falharem, marca o projeto como erro em vez de
    // deixá-lo travado indefinidamente em "generating_script"/"rendering".
    onFailure: async ({ event }) => {
      const original = event.data.event as {
        data: { projectId: string };
      };
      const projectId = original?.data?.projectId;
      if (!projectId) return;
      await db
        .update(projects)
        .set({
          status: "error",
          errorMessage:
            "Falha ao gerar o vídeo após múltiplas tentativas. Veja os logs do Inngest para detalhes.",
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));
    },
  },
  { event: "nr-video/generate.requested" },
  async ({ event, step }) => {
    const { projectId } = event.data as { projectId: string };

    // 1. Gerar roteiro com Gemini e persistir as cenas no banco
    const script = await step.run("generate-script", async () => {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) throw new Error("Projeto não encontrado.");

      await db
        .update(projects)
        .set({ status: "generating_script", updatedAt: new Date() })
        .where(eq(projects.id, projectId));

      const result = await generateScript(project.sourceText);

      await db.insert(scriptLogs).values({
        projectId,
        rawResponse: result.raw as object,
      });

      const insertedScenes = await db
        .insert(scenes)
        .values(
          result.scenes.map((s) => ({
            projectId,
            order: s.order,
            narrationText: s.narrationText,
            screenText: s.screenText,
          }))
        )
        .returning({ id: scenes.id, order: scenes.order });

      await db
        .update(projects)
        .set({
          title: result.title,
          status: "generating_assets",
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));

      return {
        title: result.title,
        voice: project.voice,
        sceneIds: insertedScenes
          .sort((a, b) => a.order - b.order)
          .map((s) => s.id),
      };
    });

    // 2. Para cada cena: gerar áudio (TTS) + slide, e enviar para o Blob
    const sceneAssets: { audioUrl: string; slideUrl: string }[] = [];
    for (let i = 0; i < script.sceneIds.length; i++) {
      const sceneId = script.sceneIds[i];
      const assets = await step.run(`generate-assets-scene-${i}`, async () => {
        const scene = await db.query.scenes.findFirst({
          where: eq(scenes.id, sceneId),
        });
        if (!scene) throw new Error(`Cena ${sceneId} não encontrada.`);

        // --- Áudio (TTS) ---
        const audioPath = await synthesizeSpeech(
          scene.narrationText,
          script.voice
        );
        const duration = await getAudioDuration(audioPath);
        const audioUrl = await uploadFile(
          audioPath,
          `${projectId}/scene-${scene.order}-audio.mp3`,
          "audio/mpeg"
        );
        await fsPromises.unlink(audioPath).catch(() => undefined);

        // --- Slide (imagem) ---
        const slidePath = await generateSlideImage({
          sceneNumber: scene.order,
          totalScenes: script.sceneIds.length,
          screenText: scene.screenText,
          projectTitle: script.title,
        });
        const slideUrl = await uploadFile(
          slidePath,
          `${projectId}/scene-${scene.order}-slide.png`,
          "image/png"
        );
        await fsPromises.unlink(slidePath).catch(() => undefined);

        await db
          .update(scenes)
          .set({
            audioUrl,
            audioDurationSeconds: Math.ceil(duration),
            slideImageUrl: slideUrl,
            assetsReady: true,
          })
          .where(eq(scenes.id, sceneId));

        return { audioUrl, slideUrl };
      });
      sceneAssets.push(assets);
    }

    // 3. Renderizar o vídeo final com FFmpeg e enviar para o Blob
    const videoUrl = await step.run("render-and-upload-video", async () => {
      await db
        .update(projects)
        .set({ status: "rendering", updatedAt: new Date() })
        .where(eq(projects.id, projectId));

      const localScenes = [];
      for (const asset of sceneAssets) {
        const imagePath = await downloadToTemp(asset.slideUrl, "png");
        const audioPath = await downloadToTemp(asset.audioUrl, "mp3");
        localScenes.push({ imagePath, audioPath });
      }

      const finalVideoPath = await renderFinalVideo(localScenes);
      const url = await uploadFile(
        finalVideoPath,
        `${projectId}/final-video.mp4`,
        "video/mp4"
      );

      // Limpeza best-effort dos arquivos temporários
      await Promise.all(
        localScenes.flatMap((s) => [
          fsPromises.unlink(s.imagePath).catch(() => undefined),
          fsPromises.unlink(s.audioPath).catch(() => undefined),
        ])
      );
      await fsPromises.unlink(finalVideoPath).catch(() => undefined);

      return url;
    });

    // 4. Finalizar
    await step.run("finalize", async () => {
      await db
        .update(projects)
        .set({ status: "done", videoUrl, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    });

    return { projectId, videoUrl };
  }
);
