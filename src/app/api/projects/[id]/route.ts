import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects, scenes } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
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
}
