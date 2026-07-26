import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { desc } from "drizzle-orm";
import { inngest } from "@/inngest/client";
import { AVAILABLE_VOICES } from "@/lib/tts";

export async function GET() {
  const allProjects = await db.query.projects.findMany({
    orderBy: desc(projects.createdAt),
  });
  return NextResponse.json({ projects: allProjects });
}

export async function POST(req: NextRequest) {
  let body: { sourceText?: string; voice?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido." },
      { status: 400 }
    );
  }

  const sourceText = body.sourceText?.trim();
  if (!sourceText || sourceText.length < 30) {
    return NextResponse.json(
      {
        error:
          "Cole o texto da NR (mínimo de 30 caracteres) para gerar o treinamento.",
      },
      { status: 400 }
    );
  }

  const voice =
    body.voice && AVAILABLE_VOICES.some((v) => v.id === body.voice)
      ? body.voice
      : AVAILABLE_VOICES[0].id;

  const [project] = await db
    .insert(projects)
    .values({
      title: "Gerando título...",
      sourceText,
      voice,
      status: "pending",
    })
    .returning({ id: projects.id });

  await inngest.send({
    name: "nr-video/generate.requested",
    data: { projectId: project.id },
  });

  return NextResponse.json({ projectId: project.id }, { status: 201 });
}
