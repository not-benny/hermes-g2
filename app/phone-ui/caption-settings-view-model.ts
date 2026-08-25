import { Frame, Observable } from "@nativescript/core";

import { captionProcessingDisclosure, captionProviderCapabilities, effectiveCaptionProvider } from "../captions/caption-settings";
import {
  captionFontSizeSetting,
  captionLayoutSetting,
  captionLineSpacingSetting,
  captionMaxLinesSetting,
  captionSourceLanguageSetting,
  captionSpeakerLabelsSetting,
  captionTargetLanguageSetting,
  captionVocabularySetting,
  conversateProviderSetting,
  deepgramApiKeySetting,
  elevenLabsApiKeySetting,
  openAiApiKeySetting,
  sonioxApiKeySetting,
} from "../ui/dashboard-settings";

type TextChangeArgs = { value?: string; object?: { text?: string } };

export class CaptionSettingsViewModel extends Observable {
  private vocabularyDraft = captionVocabularySetting.get();

  get sourceLanguage(): string { return captionSourceLanguageSetting.get(); }
  get provider(): string { return conversateProviderSetting.displayValue(); }
  get targetLanguage(): string { return captionTargetLanguageSetting.get(); }
  get layout(): string { return captionLayoutSetting.get(); }
  get fontSize(): string { return captionFontSizeSetting.get(); }
  get lineSpacing(): string { return captionLineSpacingSetting.get(); }
  get maxLines(): string { return captionMaxLinesSetting.get(); }
  get speakerLabels(): boolean { return captionSpeakerLabelsSetting.get(); }
  set speakerLabels(value: boolean) {
    if (!this.speakerLabelsAvailable || value === captionSpeakerLabelsSetting.get()) return;
    captionSpeakerLabelsSetting.set(value);
    this.refresh();
  }
  get speakerLabelsAvailable(): boolean { return captionProviderCapabilities(this.effectiveProvider()).speakerLabels; }
  get vocabulary(): string { return this.vocabularyDraft; }
  get vocabularyStatus(): string {
    return captionProviderCapabilities(this.effectiveProvider()).customVocabulary
      ? "Vocabulary will be sent only to the selected supporting provider."
      : "Selected provider does not support custom vocabulary; it stays local and is not sent.";
  }
  get disclosure(): string {
    return captionProcessingDisclosure(this.effectiveProvider(), captionTargetLanguageSetting.get());
  }

  onProviderTap(): void { conversateProviderSetting.set(conversateProviderSetting.next()); this.refresh(); }
  onSourceTap(): void { captionSourceLanguageSetting.set(captionSourceLanguageSetting.next()); this.refresh(); }
  onTargetTap(): void { captionTargetLanguageSetting.set(captionTargetLanguageSetting.next()); this.refresh(); }
  onLayoutTap(): void { captionLayoutSetting.set(captionLayoutSetting.next()); this.refresh(); }
  onFontTap(): void { captionFontSizeSetting.set(captionFontSizeSetting.next()); this.refresh(); }
  onSpacingTap(): void { captionLineSpacingSetting.set(captionLineSpacingSetting.next()); this.refresh(); }
  onMaxLinesTap(): void { captionMaxLinesSetting.set(captionMaxLinesSetting.next()); this.refresh(); }
  onVocabularyTextChange(args: TextChangeArgs): void { this.vocabularyDraft = args.object?.text ?? args.value ?? ""; }
  onSaveVocabularyTap(): void {
    this.vocabularyDraft = captionVocabularySetting.set(this.vocabularyDraft);
    this.refresh();
  }
  onBackTap(): void { Frame.topmost()?.goBack(); }

  private effectiveProvider() {
    return effectiveCaptionProvider(conversateProviderSetting.get(), {
      deepgram: deepgramApiKeySetting.get().trim().length > 0,
      elevenlabs: elevenLabsApiKeySetting.get().trim().length > 0,
      whisper: openAiApiKeySetting.get().trim().length > 0,
      soniox: sonioxApiKeySetting.get().trim().length > 0,
    });
  }

  private refresh(): void {
    for (const property of [
      "provider", "sourceLanguage", "targetLanguage", "layout", "fontSize", "lineSpacing", "maxLines",
      "speakerLabels", "speakerLabelsAvailable", "vocabulary", "vocabularyStatus", "disclosure",
    ]) this.notifyPropertyChange(property, (this as any)[property]);
  }
}
