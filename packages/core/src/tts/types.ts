/**
 * TTS types and constants — shared across all platforms.
 */

export type TTSEngine = "system" | "edge" | "dashscope";
export type LegacyTTSEngine = TTSEngine | "browser";

export type TTSPlayState = "stopped" | "playing" | "paused" | "loading";

export interface TTSConfig {
  engine: TTSEngine;
  /** System voice identifier (or legacy display name on older configs) */
  voiceName: string;
  /** Human-readable system voice label for UI display */
  systemVoiceLabel: string;
  /** Speech rate (0.5 - 2.0) */
  rate: number;
  /** Speech pitch (0.5 - 2.0) */
  pitch: number;
  /** Edge TTS voice ID (e.g. "zh-CN-XiaoxiaoNeural") */
  edgeVoice: string;
  /** DashScope API Key (optional, for high-quality TTS) */
  dashscopeApiKey: string;
  /** DashScope voice (e.g. "Cherry", "Ethan") */
  dashscopeVoice: string;
}

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  engine: "edge",
  voiceName: "",
  systemVoiceLabel: "",
  rate: 1.0,
  pitch: 1.0,
  edgeVoice: "zh-CN-XiaoxiaoNeural",
  dashscopeApiKey: "",
  dashscopeVoice: "Cherry",
};

export interface PersistedTTSConfig extends Partial<Omit<TTSConfig, "engine">> {
  engine?: LegacyTTSEngine | string | null;
}

export function normalizeTTSEngine(engine: LegacyTTSEngine | string | null | undefined): TTSEngine {
  if (engine === "system" || engine === "edge" || engine === "dashscope") {
    return engine;
  }
  if (engine === "browser") {
    return "system";
  }
  return DEFAULT_TTS_CONFIG.engine;
}

export function normalizeTTSConfig(config: PersistedTTSConfig | null | undefined): TTSConfig {
  return {
    ...DEFAULT_TTS_CONFIG,
    ...config,
    engine: normalizeTTSEngine(config?.engine),
    voiceName: config?.voiceName ?? DEFAULT_TTS_CONFIG.voiceName,
    systemVoiceLabel: config?.systemVoiceLabel ?? DEFAULT_TTS_CONFIG.systemVoiceLabel,
    rate: typeof config?.rate === "number" ? config.rate : DEFAULT_TTS_CONFIG.rate,
    pitch: typeof config?.pitch === "number" ? config.pitch : DEFAULT_TTS_CONFIG.pitch,
    edgeVoice: config?.edgeVoice ?? DEFAULT_TTS_CONFIG.edgeVoice,
    dashscopeApiKey: config?.dashscopeApiKey ?? DEFAULT_TTS_CONFIG.dashscopeApiKey,
    dashscopeVoice: config?.dashscopeVoice ?? DEFAULT_TTS_CONFIG.dashscopeVoice,
  };
}

export const DASHSCOPE_VOICES = [
  { id: "Cherry", label: "芊悦 (Cherry)" },
  { id: "Ethan", label: "晨煦 (Ethan)" },
  { id: "Nofish", label: "不吃鱼 (Nofish)" },
  { id: "Ryan", label: "甜茶 (Ryan)" },
  { id: "Katerina", label: "卡捷琳娜 (Katerina)" },
  { id: "Dylan", label: "北京-晓东 (Dylan)" },
  { id: "Sunny", label: "四川-晴儿 (Sunny)" },
  { id: "Peter", label: "天津-李彼得 (Peter)" },
  { id: "Rocky", label: "粤语-阿强 (Rocky)" },
  { id: "Kiki", label: "粤语-阿清 (Kiki)" },
] as const;

/**
 * ITTSPlayer — unified interface for all TTS engines.
 * Eliminates engine-specific if/else branching in store code.
 */
export interface ITTSPlayer {
  speak(text: string | string[], config: TTSConfig): void | Promise<void>;
  append?(text: string | string[]): void | Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Whether playback is currently paused (true suspend). Optional — platforms without true pause may omit it. */
  readonly paused?: boolean;

  onStateChange?: (state: "playing" | "paused" | "stopped") => void;
  onChunkChange?: (index: number, total: number) => void;
  /** Called when all chunks finish playing naturally (not by stop()) */
  onEnd?: () => void;
}
