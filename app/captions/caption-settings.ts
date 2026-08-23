// Keep phone-selectable languages to scripts the bundled renderer can display
// legibly. Provider events may still identify other languages, but the UI does
// not claim shaped RTL/CJK/Indic output that the bitmap fonts cannot provide.
export const CAPTION_SOURCE_LANGUAGES = ["auto", "en", "es", "fr", "de", "it", "pt"] as const;
export const CAPTION_TARGET_LANGUAGES = ["off", "en", "es", "fr", "de", "it", "pt"] as const;
export const CAPTION_LAYOUTS = ["source", "split", "translation"] as const;
export const CAPTION_FONT_SIZES = ["small", "medium", "large"] as const;
export const CAPTION_LINE_SPACING = ["compact", "normal", "relaxed"] as const;
export const CAPTION_MAX_LINES = ["4", "6", "8", "10", "12"] as const;

export type CaptionSourceLanguage = (typeof CAPTION_SOURCE_LANGUAGES)[number];
export type CaptionTargetLanguage = (typeof CAPTION_TARGET_LANGUAGES)[number];
export type CaptionLayout = (typeof CAPTION_LAYOUTS)[number];
export type CaptionFontSize = (typeof CAPTION_FONT_SIZES)[number];
export type CaptionLineSpacing = (typeof CAPTION_LINE_SPACING)[number];
export type CaptionMaxLines = (typeof CAPTION_MAX_LINES)[number];
export type CaptionProvider = "onboard" | "deepgram" | "elevenlabs" | "whisper" | "soniox";

export type CaptionProviderCapabilities = {
  locality: "local" | "cloud";
  translation: boolean;
  speakerLabels: boolean;
  customVocabulary: boolean;
};

const CAPABILITIES: Record<CaptionProvider, CaptionProviderCapabilities> = {
  onboard: { locality: "local", translation: false, speakerLabels: false, customVocabulary: false },
  deepgram: { locality: "cloud", translation: false, speakerLabels: false, customVocabulary: false },
  elevenlabs: { locality: "cloud", translation: false, speakerLabels: false, customVocabulary: false },
  whisper: { locality: "cloud", translation: false, speakerLabels: false, customVocabulary: false },
  soniox: { locality: "cloud", translation: true, speakerLabels: true, customVocabulary: false },
};

export function normalizeCaptionLanguage(value: string | null | undefined): CaptionSourceLanguage {
  return (CAPTION_SOURCE_LANGUAGES as readonly string[]).includes(value ?? "")
    ? (value as CaptionSourceLanguage)
    : "auto";
}

export function normalizeCaptionTargetLanguage(value: string | null | undefined): CaptionTargetLanguage {
  return (CAPTION_TARGET_LANGUAGES as readonly string[]).includes(value ?? "")
    ? (value as CaptionTargetLanguage)
    : "off";
}

export function normalizeCaptionVocabulary(value: string | null | undefined): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").split(/[\n,]/)) {
    const term = Array.from(raw.trim()).slice(0, 64).join("");
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 64) break;
    if (new TextEncoder().encode(terms.join(", ")).byteLength >= 4_096) break;
  }
  return terms.join(", ").slice(0, 4_096);
}

export function captionProviderCapabilities(provider: CaptionProvider): CaptionProviderCapabilities {
  return { ...CAPABILITIES[provider] };
}

export function effectiveCaptionProvider(
  provider: CaptionProvider,
  configured: Partial<Record<Exclude<CaptionProvider, "onboard">, boolean>>,
): CaptionProvider {
  return provider === "onboard" || configured[provider] ? provider : "onboard";
}

export function captionProcessingDisclosure(
  provider: CaptionProvider,
  targetLanguage: CaptionTargetLanguage,
): string {
  if (provider === "onboard") {
    return targetLanguage === "off"
      ? "Processing: on phone. Microphone audio is not uploaded and captions are not saved."
      : "Processing: on phone. Translation is unavailable; source captions continue without upload or persistence.";
  }
  const providerName = provider === "whisper" ? "OpenAI" : provider[0]!.toUpperCase() + provider.slice(1);
  const translation = targetLanguage !== "off" && CAPABILITIES[provider].translation;
  return `Processing: ${providerName} cloud. Microphone audio is sent to ${providerName} for transcription${translation ? " and translation" : ""}; captions are not saved by Hermes.`;
}
