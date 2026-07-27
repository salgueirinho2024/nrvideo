import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects, scenes } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

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
