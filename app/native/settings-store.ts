/**
 * TS wrapper for the Java FaceclawSettings singleton: settings storage shared
 * by every isolate (main thread and app workers), with cross-isolate change
 * notifications. Each isolate that subscribes registers one Java listener;
 * Java dispatches through the registering thread's Looper so callbacks run on
 * this isolate's own thread.
 */
import { Utils } from "@nativescript/core";

declare const com: any;

let javaInstance: any = null;
// The Java-side listener proxy must stay referenced or it gets GC'd.
let retainedListenerProxy: any = null;
const changeListeners = new Set<(key: string) => void>();

const SECRET_SETTING_KEYS = new Set([
  "assistant.bridgeToken",
  "even.account.email",
  "even.account.password",
  "even.api.appId",
  "even.api.accessKey",
  "even.api.accessSecret",
  "even.api.aesKey",
  "even.api.aesIv",
  "even.api.authToken",
  "voice.deepgramApiKey",
  "voice.elevenLabsApiKey",
  "voice.openAiApiKey",
  "voice.sonioxApiKey",
  "llm.anthropicApiKey",
  "maps.mapboxApiKey",
  "terminal.newConnectionDraft",
  "terminal.connections",
  "motion.deviceBindingSalt",
  "assistant.contextDashboardPins",
  "assistant.directNotifications.v1",
  "clock.store.v1",
  "work.tasks.store.v1",
  "captures.store.v1",
  "notifications.rules.v2",
]);

function getJava(): any {
  if (javaInstance === null) {
    const context = Utils.android?.getApplicationContext?.();
    javaInstance = context
      ? com.faceclaw.app.FaceclawSettings.getInstance(context)
      : com.faceclaw.app.FaceclawSettings.getInstance();
  }
  return javaInstance;
}

export function getStringSetting(key: string, defaultValue: string): string {
  return String(SECRET_SETTING_KEYS.has(key)
    ? getJava().getSecret(key, defaultValue)
    : getJava().getString(key, defaultValue));
}

/** Value-free presence probe used to fail closed when encrypted reads fail. */
export function hasStoredSecretSetting(key: string): boolean {
  if (!SECRET_SETTING_KEYS.has(key)) throw new Error("setting is not classified as secret");
  return Boolean(getJava().hasStoredSecret(key));
}

export function setStringSetting(key: string, value: string): void {
  if (SECRET_SETTING_KEYS.has(key)) {
    if (!getJava().setSecret(key, value)) throw new Error("secure setting write failed");
  } else {
    if (!getJava().setString(key, value)) throw new Error("setting write failed");
  }
}

export function removeStringSetting(key: string): void {
  if (SECRET_SETTING_KEYS.has(key)) throw new Error("secret settings require secure removal");
  if (!getJava().removeString(key)) throw new Error("setting removal failed");
}

export function removeSecretSetting(key: string): void {
  if (!SECRET_SETTING_KEYS.has(key)) throw new Error("setting is not classified as secret");
  if (!getJava().removeSecret(key)) throw new Error("secure setting removal failed");
}

export function getBooleanSetting(key: string, defaultValue: boolean): boolean {
  return Boolean(getJava().getBoolean(key, defaultValue));
}

export function setBooleanSetting(key: string, value: boolean): void {
  getJava().setBoolean(key, value);
}

/**
 * Subscribe to setting changes from any isolate (including this one). The
 * callback runs on this isolate's own thread, one message-loop tick after the
 * change.
 */
export function onSettingsStoreChanged(listener: (key: string) => void): () => void {
  if (retainedListenerProxy === null) {
    retainedListenerProxy = new com.faceclaw.app.FaceclawSettingsListener({
      onSettingChanged: (key: string) => {
        for (const registered of Array.from(changeListeners)) {
          try {
            registered(String(key));
          } catch (error) {
            console.warn("settings change listener failed", error);
          }
        }
      },
    });
    getJava().registerListener(retainedListenerProxy);
  }
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
