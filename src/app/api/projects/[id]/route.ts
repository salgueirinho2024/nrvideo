import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects, scenes } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { deleteFiles } from "@/lib/storage";

// Idem: essa rota é consultada em polling pelo front-end pra saber o status
// do projeto em tempo real, então nunca pode ser servida de cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, params.id),
    });

    if (!project) {
      return NextResponse.json({ error: "Projeto não encontrado." }, { status: 404 });
    }

    const projectScenes = await db.query.scenes.findMany({
      where: eq(scenes.projectId, params.id),
      orderBy: asc(scenes.order),
    });

    return NextResponse.json({ project, scenes: projectScenes });
  } catch (err) {
    console.error(`GET /api/projects/${params.id} falhou:`, err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Erro ao carregar o projeto.",
      },
      { status: 500 }
    );
  }
}

/**
 * Apaga um projeto: primeiro os arquivos no Cloudflare R2 (vídeo final +
 * áudio/imagem/vídeo de banco/timeline de cada cena), depois a linha do
 * projeto no banco — o `onDelete: "cascade"` do schema já cuida de apagar
 * as `scenes` e `script_logs` relacionados. A limpeza do R2 é
 * best-effort (ver deleteFiles em storage.ts): mesmo que o bucket esteja
 * indisponível, o projeto some da lista.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, params.id),
    });
    if (!project) {
      return NextResponse.json({ error: "Projeto não encontrado." }, { status: 404 });
    }

    const projectScenes = await db.query.scenes.findMany({
      where: eq(scenes.projectId, params.id),
    });

    const blobUrls = [
      project.videoUrl,
      ...projectScenes.flatMap((s) => [
        s.audioUrl,
        s.slideImageUrl,
        s.sceneVideoUrl,
        s.visemeTimelineUrl,
      ]),
    ].filter((u): u is string => Boolean(u));

    await deleteFiles(blobUrls);
    await db.delete(projects).where(eq(projects.id, params.id));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`DELETE /api/projects/${params.id} falhou:`, err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Erro ao apagar o projeto.",
      },
      { status: 500 }
    );
  }
}
