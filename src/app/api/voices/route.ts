import { NextResponse } from "next/server";
import { AVAILABLE_VOICES } from "@/lib/tts";

export async function GET() {
  return NextResponse.json({ voices: AVAILABLE_VOICES });
}
