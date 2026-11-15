import type { Production } from "@/lib/production-schema";
import { getImageModelPreset, getVideoModelPreset, type WorkflowModelSelection } from "@/lib/comfyui/model-presets";

export type { WorkflowModelSelection } from "@/lib/comfyui/model-presets";

export function buildWorkflowContext(production: Production, models: WorkflowModelSelection, topic = production.title) {
  const image = getImageModelPreset(models.image);
  const video = getVideoModelPreset(models.video);
  return {
    format: "factscope.workflow-context.v2",
    generatedAt: new Date().toISOString(),
    production,
    title: production.title,
    topic,
    selectedModels: {
      image: { ...image, verification: "Known configuration only; installation and compatibility are unverified until checked against the connected ComfyUI /object_info." },
      video: { ...video, verification: "Known configuration only; installation and compatibility are unverified until checked against the connected ComfyUI /object_info." },
    },
    outputSpecifications: {
      title: production.title,
      topic,
      durationSeconds: production.video.durationSeconds,
      fps: production.video.fps,
      width: production.video.width,
      height: production.video.height,
      aspectRatio: production.video.aspectRatio,
      narrationLanguage: production.narration.language,
      audioLanguage: production.audio.language,
      finalFormat: "MP4",
      sceneCount: production.scenes.length,
    },
    executionCaveat: "This context does not prove that model files or custom nodes are installed. Validate every API node class, input, connection, and model against live ComfyUI /object_info before submission. Static validation does not prove a successful render.",
  };
}

export function buildWorkflowRequest(production: Production, models: WorkflowModelSelection, topic = production.title) {
  const context = buildWorkflowContext(production, models, topic);
  return `You are an expert ComfyUI workflow engineer and scientific video pipeline designer. Build one complete, connected ComfyUI master workflow for the FactScope production below, without requiring or assuming an existing reference workflow. The user has imported this complete production brief; use its actual scene data, not a summary.

GOAL
Create one end-to-end graph that processes all ${production.scenes.length} scenes as a single workflow submission and produces exactly one final MP4. Do not ask for manual per-scene jobs or split the work into separate workflows.

MODEL CONFIGURATION (filenames are configured preferences, NOT proof that files are installed)
Image model preset: ${context.selectedModels.image.name}
- Diffusion model: ${context.selectedModels.image.diffusionModel}
- Text encoder: ${context.selectedModels.image.textEncoder}
- VAE: ${context.selectedModels.image.vae}
Video model preset: ${context.selectedModels.video.name}
- Diffusion model: ${context.selectedModels.video.diffusionModel}
- Text encoder: ${context.selectedModels.video.textEncoder}
- Video VAE: ${context.selectedModels.video.videoVae}
- Audio VAE: ${context.selectedModels.video.audioVae}

TARGET
- Title: ${production.title}
- Topic: ${topic}
- Scene count: ${production.scenes.length}
- Total duration: ${production.video.durationSeconds} seconds
- Target frame rate: ${production.video.fps} FPS
- Target output: ${production.video.width} × ${production.video.height} (${production.video.aspectRatio})
- Visual style: ${production.video.visualStyle}
- Narration language: ${production.narration.language}; audio language: ${production.audio.language}
- Subtitles: ${production.audio.subtitlesEnabled ? "enabled if supported" : "not requested"}
- Background music: ${production.audio.backgroundMusic ? "requested if supported" : "not requested"}
- Final deliverable: one complete MP4

REQUIRED GRAPH
1. Load the shared image/video model, text encoder(s), VAE(s), and audio dependencies using documented ComfyUI node classes and correct input names. Reuse shared loaders where supported.
2. Generate an image for every scene from its full image prompt and negative prompt.
3. Generate image-to-video motion for every scene from its full video prompt and negative prompt, using its scene image as conditioning.
4. Preserve continuity across scenes using the supplied canonical subject description, fixed properties, continuity rules, and first/last-frame details. Use reference/identity conditioning only where supported by documented nodes and compatible model capabilities.
5. Produce narration in the requested language, using narration text from the Production JSON. Use native text-to-speech only if a real compatible node/model is known; otherwise clearly identify the missing dependency and use a supported audio-loading path only if audio inputs are actually available. Do not fabricate audio or claim unsupported speech generation.
6. Assemble every scene video in order with durations/frame counts calculated from the requested FPS and timestamps; concatenate them into one continuous timeline.
7. Combine/align narration and optional audio with the full video timeline, and connect the result to exactly one final MP4 output node.
8. Set target export FPS and resolution where supported. If native model dimensions or output nodes do not support the requested target, preserve native generation settings and explicitly identify the required upscale/resampling step or limitation rather than silently asserting support.

REAL-NODE AND HONESTY REQUIREMENTS
- Use only real, documented ComfyUI core node types or explicitly documented custom-node types. Do not invent node classes, input names, model capabilities, or installed dependencies.
- Node availability, exact inputs, model installation, hardware fit, and runtime success are unknown unless verified against authoritative documentation or a live /object_info response. Clearly label all unknowns and list required custom-node packs and model files for verification.
- If a required stage cannot be implemented with verified nodes, identify the gap instead of substituting a fake node or claiming a complete executable graph.
- The API graph must use valid API-format class_type/inputs and actual node connections. The UI graph must be editable and correspond to the same graph.
- Include every scene, prompt, narration segment, camera direction, timestamp, duration, continuity rule, and scientific constraint. Never omit or summarize scene content.
- Ensure there is one final MP4 output, not one output per scene. Do not claim the workflow was tested or executed.

RETURN
Return two complete JSON files as separate downloadable attachments, with no ellipses or omitted nodes:
1. factscope_master_workflow.json — editable ComfyUI UI-format graph with nodes, links, widgets_values, and properties.
2. factscope_master_workflow_api.json — API execution-format node map with class_type and inputs.
Also provide a concise report of node/model dependencies, what is unverified, and any unsupported requirements. Both JSON files must represent the same complete scene-by-scene workflow. JSON syntax alone does not establish executability.

COMPLETE PRODUCTION JSON (authoritative; preserve all fields and scene data)
\`\`\`json
${JSON.stringify(production, null, 2)}
\`\`\`

The companion Workflow Context JSON includes the same Production JSON, selected presets and filenames, and output specifications.`;
}
