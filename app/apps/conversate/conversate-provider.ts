import { captionProviderCapabilities, effectiveCaptionProvider } from "../../captions/caption-settings";
import {
  conversateProviderSetting,
  deepgramApiKeySetting,
  elevenLabsApiKeySetting,
  openAiApiKeySetting,
  sonioxApiKeySetting,
  voiceProviderLabel,
  type VoiceProvider,
} from "../../ui/dashboard-settings";

export type ConversateProviderState = {
  selected: VoiceProvider;
  effective: VoiceProvider;
  label: string;
  locality: "local" | "cloud";
  configured: boolean;
};

function configuredCloudProviders(): Record<Exclude<VoiceProvider, "onboard">, boolean> {
  return {
    deepgram: deepgramApiKeySetting.get().trim().length > 0,
    elevenlabs: elevenLabsApiKeySetting.get().trim().length > 0,
    whisper: openAiApiKeySetting.get().trim().length > 0,
    soniox: sonioxApiKeySetting.get().trim().length > 0,
  };
}

/** Resolve the app-owned choice without exposing credentials to the UI. */
export function currentConversateProvider(): ConversateProviderState {
  const selected = conversateProviderSetting.get();
  const configured = configuredCloudProviders();
  const effective = effectiveCaptionProvider(selected, configured);
  return {
    selected,
    effective,
    label: voiceProviderLabel(effective),
    locality: captionProviderCapabilities(effective).locality,
    configured: selected === "onboard" || Boolean(configured[selected]),
  };
}

/**
 * Cycle only through usable providers. On-device is always first and always
 * available; a cloud provider appears only after its secret is configured.
 */
export function cycleConversateProvider(direction: 1 | -1): ConversateProviderState {
  const configured = configuredCloudProviders();
  const available = conversateProviderSetting.values.filter(
    (provider) => provider === "onboard" || Boolean(configured[provider]),
  );
  const selected = conversateProviderSetting.get();
  const current = Math.max(0, available.indexOf(selected));
  const next = available[(current + direction + available.length) % available.length] ?? "onboard";
  conversateProviderSetting.set(next);
  return currentConversateProvider();
}

export function conversatePrivacyStatus(state = currentConversateProvider()): string {
  if (state.locality === "local") {
    return state.selected === state.effective
      ? "LOCAL · NO AUDIO UPLOAD"
      : `${voiceProviderLabel(state.selected).toUpperCase()} UNAVAILABLE · USING LOCAL`;
  }
  return `CLOUD · ${state.label.toUpperCase()}`;
}
