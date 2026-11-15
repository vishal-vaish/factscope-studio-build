import { join } from "node:path";
import { existsSync } from "node:fs";

export type InputBinding = {
  nodeId: string;
  inputName: string;
  value: "imagePrompt" | "imageNegativePrompt" | "videoPrompt" | "videoNegativePrompt" | "narration" | "cameraAndContinuity" | "width" | "height" | "frameCount" | "fps";
  sceneIndex: number;
};

export type ModelBinding = { nodeId: string; inputName: string; model: "image" | "video" | "audio" };

export const comfyConfig = {
  endpoint: process.env.FACTSCOPE_COMFYUI_ENDPOINT || "http://127.0.0.1:8188",
  masterWorkflowPath: process.env.FACTSCOPE_MASTER_WORKFLOW_PATH || join(process.cwd(), "workflows", "master-six-scenes.api.json"),
  sceneCount: 6,
  sceneDurationSeconds: 5,
  totalDurationSeconds: 30,
  imageModelFilename: null as string | null,
  videoModelFilename: null as string | null,
  audio: { mode: "workflow-input" as const, modelFilename: null as string | null },
  expectedMp4OutputNodeId: null as string | null,
  bindings: [] as InputBinding[],
  modelBindings: [] as ModelBinding[],
  sequentialDependencies: [] as { fromNodeId: string; toNodeId: string; toInputName: string }[],
};

export function getWorkflowConfigurationStatus() {
  return {
    masterWorkflowPath: comfyConfig.masterWorkflowPath,
    sceneCount: comfyConfig.sceneCount,
    sceneDurationSeconds: comfyConfig.sceneDurationSeconds,
    totalDurationSeconds: comfyConfig.totalDurationSeconds,
    imageModelFilename: comfyConfig.imageModelFilename,
    videoModelFilename: comfyConfig.videoModelFilename,
    audio: comfyConfig.audio,
    expectedMp4OutputNodeId: comfyConfig.expectedMp4OutputNodeId,
    workflowFileAvailable: existsSync(/*turbopackIgnore: true*/ comfyConfig.masterWorkflowPath),
    workflowConfigured: false,
    note: "No verified master API workflow or node/model bindings are present in this repository.",
  };
}
