import { Frame, Observable } from "@nativescript/core";

import {
  anthropicApiKeySetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
  deepgramApiKeySetting,
  elevenLabsApiKeySetting,
  mapboxApiKeySetting,
  openAiApiKeySetting,
  sonioxApiKeySetting,
} from "../ui/dashboard-settings";

type TextChangeArgs = { value?: string; object?: { text?: string } };

export class ApiKeysViewModel extends Observable {
  private _status = "Existing secrets stay hidden. Enter a value only to replace it.";
  private _bridgeHost = assistantBridgeHostSetting.get();
  private _bridgePort = assistantBridgePortSetting.get();
  private _bridgeToken = "";
  private _anthropicApiKey = "";
  private _openAiApiKey = "";
  private _deepgramApiKey = "";
  private _elevenLabsApiKey = "";
  private _sonioxApiKey = "";
  private _mapboxApiKey = "";

  get status(): string { return this._status; }
  get bridgeHost(): string { return this._bridgeHost; }
  set bridgeHost(value: string) { this._bridgeHost = value ?? ""; }
  get bridgePort(): string { return this._bridgePort; }
  set bridgePort(value: string) { this._bridgePort = value ?? ""; }
  get bridgeTokenConfigured(): string { return configuredLabel("Hermes bridge token", assistantBridgeTokenSetting.get()); }
  get anthropicConfigured(): string { return configuredLabel("Anthropic", anthropicApiKeySetting.get()); }
  get openAiConfigured(): string { return configuredLabel("OpenAI", openAiApiKeySetting.get()); }
  get deepgramConfigured(): string { return configuredLabel("Deepgram", deepgramApiKeySetting.get()); }
  get elevenLabsConfigured(): string { return configuredLabel("ElevenLabs", elevenLabsApiKeySetting.get()); }
  get sonioxConfigured(): string { return configuredLabel("Soniox", sonioxApiKeySetting.get()); }
  get mapboxConfigured(): string { return configuredLabel("Mapbox", mapboxApiKeySetting.get()); }

  onBridgeHostTextChange(args: TextChangeArgs): void { this._bridgeHost = args.object?.text ?? args.value ?? ""; }
  onBridgePortTextChange(args: TextChangeArgs): void { this._bridgePort = args.object?.text ?? args.value ?? ""; }
  onBridgeTokenTextChange(args: TextChangeArgs): void { this._bridgeToken = args.object?.text ?? args.value ?? ""; }
  onAnthropicTextChange(args: TextChangeArgs): void { this._anthropicApiKey = args.object?.text ?? args.value ?? ""; }
  onOpenAiTextChange(args: TextChangeArgs): void { this._openAiApiKey = args.object?.text ?? args.value ?? ""; }
  onDeepgramTextChange(args: TextChangeArgs): void { this._deepgramApiKey = args.object?.text ?? args.value ?? ""; }
  onElevenLabsTextChange(args: TextChangeArgs): void { this._elevenLabsApiKey = args.object?.text ?? args.value ?? ""; }
  onSonioxTextChange(args: TextChangeArgs): void { this._sonioxApiKey = args.object?.text ?? args.value ?? ""; }
  onMapboxTextChange(args: TextChangeArgs): void { this._mapboxApiKey = args.object?.text ?? args.value ?? ""; }

  onSaveTap(): void {
    const host = this._bridgeHost.trim();
    const port = this._bridgePort.trim();
    if (host) assistantBridgeHostSetting.set(host);
    if (port) assistantBridgePortSetting.set(port);
    replaceIfProvided(assistantBridgeTokenSetting, this._bridgeToken);
    replaceIfProvided(anthropicApiKeySetting, this._anthropicApiKey);
    replaceIfProvided(openAiApiKeySetting, this._openAiApiKey);
    replaceIfProvided(deepgramApiKeySetting, this._deepgramApiKey);
    replaceIfProvided(elevenLabsApiKeySetting, this._elevenLabsApiKey);
    replaceIfProvided(sonioxApiKeySetting, this._sonioxApiKey);
    replaceIfProvided(mapboxApiKeySetting, this._mapboxApiKey);
    this.clearDraftSecrets();
    this._status = "Saved. Existing secret values remain hidden.";
    for (const property of [
      "status",
      "bridgeTokenConfigured",
      "anthropicConfigured",
      "openAiConfigured",
      "deepgramConfigured",
      "elevenLabsConfigured",
      "sonioxConfigured",
      "mapboxConfigured",
    ]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }

  onBackTap(): void {
    Frame.topmost()?.navigate({ moduleName: "phone-ui/main-page", clearHistory: true });
  }

  private clearDraftSecrets(): void {
    this._bridgeToken = "";
    this._anthropicApiKey = "";
    this._openAiApiKey = "";
    this._deepgramApiKey = "";
    this._elevenLabsApiKey = "";
    this._sonioxApiKey = "";
    this._mapboxApiKey = "";
  }
}

function replaceIfProvided(setting: { set(value: string): string }, value: string): void {
  const replacement = value.trim();
  if (replacement) setting.set(replacement);
}

function configuredLabel(label: string, value: string): string {
  return `${label}: ${value.trim() ? "configured" : "not set"}`;
}
