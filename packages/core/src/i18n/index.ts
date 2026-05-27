import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";

// Initialize with default "en". Each platform should call
// `initI18nLanguage()` after setPlatformService() to restore the saved lang.
console.log("[i18n] Starting initialization...");
export const i18nReady = i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ja: { translation: ja },
      ko: { translation: ko },
      fr: { translation: fr },
      es: { translation: es },
    },
    lng: "en",
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
  })
  .then(() => {
    console.log("[i18n] Initialization completed successfully");
    console.log("[i18n] Current language:", i18n.language);
    console.log("[i18n] Available languages:", Object.keys(i18n.services.resourceStore.data));
  })
  .catch((error) => {
    console.error("[i18n] Initialization failed:", error);
    throw error;
  });

/**
 * Restore saved language from platform KV storage.
 * Call this once at app startup AFTER `setPlatformService()`.
 */
export async function initI18nLanguage(): Promise<void> {
  console.log("[i18n] initI18nLanguage called");
  try {
    const { getPlatformService } = await import("../services/platform");
    const platform = getPlatformService();
    console.log("[i18n] Platform service available");

    // 1. Check if user has already chosen a language
    const savedLang = await platform.kvGetItem("readany-lang");
    console.log(`[i18n] initI18nLanguage: savedLang = ${savedLang}`);

    if (savedLang && savedLang !== i18n.language) {
      console.log(`[i18n] Restoring saved language: ${savedLang}`);
      try {
        // First try with changeLanguage
        await i18n.changeLanguage(savedLang);
        console.log(`[i18n] Successfully changed language to: ${savedLang}`);
      } catch (error) {
        console.error(`[i18n] Failed to change language to ${savedLang}:`, error);
        // Fallback: directly set language property
        console.log(`[i18n] Trying direct assignment...`);
        i18n.language = savedLang;
        console.log(`[i18n] Direct assignment completed`);
      }
      return;
    }

    // 2. If no saved language, try to get system locale as default
    if (!savedLang && platform.getLocale) {
      try {
        const systemLocale = await platform.getLocale();
        console.log(`[i18n] System locale: ${systemLocale}`);
        if (systemLocale) {
          const lc = systemLocale.toLowerCase();
          const lang = lc.startsWith("zh") ? "zh"
            : lc.startsWith("ja") ? "ja"
            : lc.startsWith("ko") ? "ko"
            : lc.startsWith("fr") ? "fr"
            : lc.startsWith("es") ? "es"
            : "en";
          console.log(`[i18n] Detected language from system: ${lang}`);
          if (lang !== i18n.language) {
            await i18n.changeLanguage(lang);
            // Persist the detected system language as default
            await platform.kvSetItem("readany-lang", lang);
            console.log(`[i18n] Saved system language as default: ${lang}`);
          }
        }
      } catch (error) {
        console.log("[i18n] getLocale failed:", error);
        // getLocale not supported or failed, keep default (en)
      }
    }
  } catch (error) {
    console.error("[i18n] initI18nLanguage error:", error);
    // Platform not ready or storage error — keep default
  }
}

/**
 * Change language and persist the choice to platform KV storage.
 */
export async function changeAndPersistLanguage(lang: string): Promise<void> {
  console.log(`[i18n] Changing language to: ${lang}`);
  try {
    await i18n.changeLanguage(lang);
    console.log(`[i18n] Successfully changed language to: ${lang}`);
  } catch (error) {
    console.error(`[i18n] Failed to change language to ${lang}:`, error);
    // Fallback: directly set language property
    console.log(`[i18n] Trying direct assignment...`);
    i18n.language = lang;
    console.log(`[i18n] Direct assignment completed`);
  }

  try {
    const { getPlatformService } = await import("../services/platform");
    const platform = getPlatformService();
    console.log(`[i18n] Persisting language to storage: ${lang}`);
    await platform.kvSetItem("readany-lang", lang);
    console.log("[i18n] Language persisted successfully");
    // Verify by reading back
    const saved = await platform.kvGetItem("readany-lang");
    console.log(`[i18n] Verification: saved value = ${saved}`);
  } catch (error) {
    console.error("[i18n] Failed to persist language:", error);
  }
}

export default i18n;
