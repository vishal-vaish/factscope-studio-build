export type ImageModelPreset = {
  id: string;
  name: string;
  diffusionModel: string;
  textEncoder: string;
  vae: string;
};

export type VideoModelPreset = {
  id: string;
  name: string;
  diffusionModel: string;
  textEncoder: string;
  videoVae: string;
  audioVae: string;
};

export type WorkflowModelSelection = { image: string; video: string };

export const imageModelPresets: ImageModelPreset[] = [
  {
    id: "qwen-image-2-1",
    name: "Qwen Image 2.1",
    diffusionModel: "qwen_image_2.1_int8_convrot.safetensors",
    textEncoder: "qwen3vl_8b_int8_convrot.safetensors",
    vae: "qwen_image_2.1_vae_bf16.safetensors",
  },
];

export const videoModelPresets: VideoModelPreset[] = [
  {
    id: "minimax-h3",
    name: "MiniMax H3",
    diffusionModel: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    textEncoder: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    videoVae: "minimax_h3_video_vae_int8_convrot.safetensors",
    audioVae: "minimax_h3_audio_vae_fp32.safetensors",
  },
];

export function getImageModelPreset(diffusionModel: string) {
  const preset = imageModelPresets.find(item => item.diffusionModel === diffusionModel);
  if (!preset) throw new Error(`Unknown image model preset: ${diffusionModel}`);
  return preset;
}

export function getVideoModelPreset(diffusionModel: string) {
  const preset = videoModelPresets.find(item => item.diffusionModel === diffusionModel);
  if (!preset) throw new Error(`Unknown video model preset: ${diffusionModel}`);
  return preset;
}

export function getWorkflowSupportingModels(selection: WorkflowModelSelection) {
  const image = getImageModelPreset(selection.image);
  const video = getVideoModelPreset(selection.video);
  return {
    textEncoders: [image.textEncoder, video.textEncoder],
    vaeModels: [image.vae, video.videoVae, video.audioVae],
  };
}
