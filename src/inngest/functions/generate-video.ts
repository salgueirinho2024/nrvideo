import { inngest } from "../client";
import { db } from "@/db";
import { projects, scenes, scriptLogs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateScript } from "@/lib/gemini";
import { synthesizeSpeech } from "@/lib/tts";
import { generateSceneImage } from "@/lib/image-gen";
import { generateSlideImage } from "@/lib/slides";
import { uploadFile } from "@/lib/storage";
import { downloadToTemp } from "@/lib/download";
import { getAudioDuration, renderSceneClip, concatFinalVideo } from "@/lib/render";
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

      const result = await generateScript(project.sourceText, project.targetMinutes);

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
            imagePrompt: s.imagePrompt,
            highlight: s.highlight,
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
    const sceneAssets: { audioUrl: string; slideUrl: string; highlight: boolean }[] = [];
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

        // --- Ilustração cartoon gerada por IA a partir do assunto da cena ---
        let sceneImagePath: string | null = null;
        let imageError: string | null = null;
        try {
          sceneImagePath = await generateSceneImage(scene.imagePrompt ?? "");
        } catch (err) {
          // Não derruba o vídeo inteiro se a geração de imagem falhar numa
          // cena específica: o slide segue sem ilustração para essa cena.
          // O motivo fica salvo em scenes.imageError (ver abaixo) pra
          // aparecer na UI em vez de só sumir num log.
          imageError = err instanceof Error ? err.message : String(err);
          console.error(`Falha ao gerar imagem da cena ${scene.order}:`, err);
        }

        // --- Slide (imagem final composta) ---
        const slidePath = await generateSlideImage({
          sceneNumber: scene.order,
          totalScenes: script.sceneIds.length,
          screenText: scene.screenText,
          narrationText: scene.narrationText,
          projectTitle: script.title,
          imagePath: sceneImagePath,
        });
        const slideUrl = await uploadFile(
          slidePath,
          `${projectId}/scene-${scene.order}-slide.png`,
          "image/png"
        );
        await fsPromises.unlink(slidePath).catch(() => undefined);
        if (sceneImagePath) {
          await fsPromises.unlink(sceneImagePath).catch(() => undefined);
        }

        await db
          .update(scenes)
          .set({
            audioUrl,
            audioDurationSeconds: Math.ceil(duration),
            slideImageUrl: slideUrl,
            imageError,
            assetsReady: true,
          })
          .where(eq(scenes.id, sceneId));

        return { audioUrl, slideUrl, highlight: scene.highlight };
      });
      sceneAssets.push(assets);
    }

    // 3. Renderizar cada cena como um clipe mp4 (imagem + áudio) e subir
    //    para o Blob — UMA etapa do Inngest por cena. Isso é o que torna
    //    vídeos longos (muitas cenas) viáveis em serverless: se a function
    //    tem um `maxDuration` limitado, renderizar tudo de uma vez numa
    //    única invocação estouraria o tempo; renderizando cena a cena, cada
    //    etapa é curta e, se falhar, o Inngest só reexecuta aquela etapa.
    await step.run("mark-rendering", async () => {
      await db
        .update(projects)
        .set({ status: "rendering", updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    });

    const clipUrls: string[] = [];
    for (let i = 0; i < sceneAssets.length; i++) {
      const asset = sceneAssets[i];
      const clipUrl = await step.run(`render-clip-scene-${i}`, async () => {
        const imagePath = await downloadToTemp(asset.slideUrl, "png");
        const audioPath = await downloadToTemp(asset.audioUrl, "mp3");

        const clipPath = await renderSceneClip(
          { imagePath, audioPath, highlight: asset.highlight },
          i
        );
        const url = await uploadFile(
          clipPath,
          `${projectId}/scene-${i}-clip.mp4`,
          "video/mp4"
        );

        await Promise.all([
          fsPromises.unlink(imagePath).catch(() => undefined),
          fsPromises.unlink(audioPath).catch(() => undefined),
          fsPromises.unlink(clipPath).catch(() => undefined),
        ]);

        return url;
      });
      clipUrls.push(clipUrl);
    }

    // 4. Concatenar os clipes já renderizados num único mp4 final ("-c
    //    copy", sem re-encode — rápido mesmo com dezenas de clipes) e subir
    //    para o Blob.
    const videoUrl = await step.run("concat-and-upload-video", async () => {
      const localClipPaths: string[] = [];
      for (const url of clipUrls) {
        localClipPaths.push(await downloadToTemp(url, "mp4"));
      }

      const finalVideoPath = await concatFinalVideo(localClipPaths);
      const url = await uploadFile(
        finalVideoPath,
        `${projectId}/final-video.mp4`,
        "video/mp4"
      );

      await Promise.all(
        localClipPaths.map((p) => fsPromises.unlink(p).catch(() => undefined))
      );
      await fsPromises.unlink(finalVideoPath).catch(() => undefined);

      return url;
    });

    // 5. Finalizar
    await step.run("finalize", async () => {
      await db
        .update(projects)
        .set({ status: "done", videoUrl, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    });

    return { projectId, videoUrl };
  }
);
