import { NextResponse } from "next/server";
import { db, jobs, videos } from "@/lib/db";
import { eq } from "drizzle-orm";
import { comfyHeaders, fetchOutput, findMp4Output, getComfySettings, isVerifiedMp4Response } from "@/lib/comfyui/client";
import { comfyConfig } from "@/lib/comfyui/config";
import { requireLocalHost } from "@/lib/comfyui/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const blocked = requireLocalHost(request);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
  const { jobId } = await params;
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (!job.promptId || job.status === "failed" || job.status === "completed") return NextResponse.json(publicJob(job));

  try {
    const { endpoint, token } = getComfySettings();
    const response = await fetch(new URL(`/history/${encodeURIComponent(job.promptId)}`, endpoint), { headers: comfyHeaders(token), cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`ComfyUI /history returned HTTP ${response.status}.`);
    const historyMap = await response.json() as Record<string, Record<string, unknown>>;
    const history = historyMap[job.promptId];
    if (!history) {
      const queueResponse = await fetch(new URL("/queue", endpoint), { headers: comfyHeaders(token), cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!queueResponse.ok) throw new Error(`ComfyUI /queue returned HTTP ${queueResponse.status}.`);
      const queue = await queueResponse.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
      const running = queue.queue_running?.some(item => queueItemHasPromptId(item, job.promptId!)) || false;
      const pending = queue.queue_pending?.some(item => queueItemHasPromptId(item, job.promptId!)) || false;
      if (running) {
        db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId)).run();
        db.update(videos).set({ status: "Rendering on ComfyUI", updatedAt: Date.now() }).where(eq(videos.id, job.videoId)).run();
      } else if (pending) {
        db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, jobId)).run();
        db.update(videos).set({ status: "Queued for ComfyUI", updatedAt: Date.now() }).where(eq(videos.id, job.videoId)).run();
      } else {
        const message = "ComfyUI returned neither history nor a queue entry for this prompt ID; execution status is unknown.";
        db.update(jobs).set({ status: "unknown", error: message }).where(eq(jobs.id, jobId)).run();
        db.update(videos).set({ status: "ComfyUI Status Unknown", updatedAt: Date.now() }).where(eq(videos.id, job.videoId)).run();
      }
      return NextResponse.json(publicJob(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!));
    }

    const status = history.status as { status_str?: string; completed?: boolean; messages?: unknown[] } | undefined;
    const statusText = status?.status_str?.toLowerCase();
    if (statusText === "error") {
      const detail = JSON.stringify(status?.messages || history);
      db.update(jobs).set({ status: "failed", error: detail }).where(eq(jobs.id, jobId)).run();
      db.update(videos).set({ status: "Generation Failed", updatedAt: Date.now() }).where(eq(videos.id, job.videoId)).run();
      return NextResponse.json(publicJob(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!));
    }

    const outputId = comfyConfig.expectedMp4OutputNodeId;
    const output = outputId ? findMp4Output(history, outputId) : null;
    if (output) {
      const fileResponse = await fetchOutput(output, endpoint, token);
      const verified = isVerifiedMp4Response(output, fileResponse);
      await fileResponse.body?.cancel();
      if (verified) {
        db.update(jobs).set({ status: "completed", output: JSON.stringify(output), error: null }).where(eq(jobs.id, jobId)).run();
        db.update(videos).set({ status: "Completed", updatedAt: Date.now() }).where(eq(videos.id, job.videoId)).run();
      } else if (!fileResponse.ok) {
        throw new Error(`ComfyUI output file check failed with HTTP ${fileResponse.status}.`);
      }
    } else if (status?.completed || statusText === "success") {
      const message = `ComfyUI completed, but the expected MP4 output node ${outputId || "(not configured)"} did not provide an MP4 file.`;
      db.update(jobs).set({ status: "failed", error: message }).where(eq(jobs.id, jobId)).run();
      db.update(videos).set({ status: "Generation Failed", updatedAt: Date.now() }).where(eq(videos.id, job.videoId)).run();
    } else {
      db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId)).run();
      db.update(videos).set({ status: "Rendering on ComfyUI", updatedAt: Date.now() }).where(eq(videos.id, job.videoId)).run();
    }
  } catch (error) {
    return NextResponse.json({ ...publicJob(job), pollingError: error instanceof Error ? error.message : "Could not read ComfyUI job status." }, { status: 502 });
  }
  const latest = db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
  return NextResponse.json(publicJob(latest));
}

function queueItemHasPromptId(item: unknown, promptId: string) {
  if (Array.isArray(item)) return item.some(value => value === promptId);
  return !!item && typeof item === "object" && Object.values(item).some(value => value === promptId);
}

function publicJob(job: typeof jobs.$inferSelect) {
  return { id: job.id, promptId: job.promptId, status: job.status, error: job.error, outputUrl: job.status === "completed" ? `/api/jobs/${job.id}/output` : null };
}
