import { BookOpenIcon, ChevronDownIcon, MoonIcon, SunIcon } from "@/components/ui/Icon";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { useTheme } from "@/styles/ThemeContext";
import type { ThemeMode } from "@/styles/ThemeContext";
import { fontSize, fontWeight, radius, spacing } from "@/styles/theme";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionSheetIOS,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsHeader } from "./SettingsHeader";

const THEMES: { id: ThemeMode; labelKey: string; fallback: string; Icon: typeof SunIcon }[] = [
  { id: "light", labelKey: "settings.light", fallback: "Light", Icon: SunIcon },
  { id: "dark", labelKey: "settings.dark", fallback: "Dark", Icon: MoonIcon },
  { id: "sepia", labelKey: "settings.sepia", fallback: "Sepia", Icon: BookOpenIcon },
];

const LANGUAGES = [
  { code: "zh", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
] as const;

export default function AppearanceSettingsScreen() {
  const { t, i18n } = useTranslation();
  const { mode, setMode, colors } = useTheme();
  const layout = useResponsiveLayout();
  const [lang, setLang] = useState(() => i18n.language || "en");
  const [showLangPicker, setShowLangPicker] = useState(false);

  // Update lang state when i18n.language changes
  useEffect(() => {
    setLang(i18n.language || "en");
  }, [i18n.language]);

  const handleLangChange = useCallback(async (code: string) => {
    setLang(code);
    setShowLangPicker(false);
    try {
      const { changeAndPersistLanguage } = await import("@readany/core/i18n");
      await changeAndPersistLanguage(code);
    } catch (err) {
      console.warn("[Settings] Failed to change and persist language:", err);
    }
  }, []);

  const currentLangLabel = LANGUAGES.find((l) => l.code === lang)?.label || lang;

  const openLangPicker = useCallback(() => {
    if (Platform.OS === "ios") {
      const options = [...LANGUAGES.map((l) => l.label), t("common.cancel")];
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title: t("settings.language") },
        (idx) => {
          if (idx < LANGUAGES.length) {
            handleLangChange(LANGUAGES[idx].code);
          }
        },
      );
    } else {
      setShowLangPicker(true);
    }
  }, [handleLangChange, t]);

  const s = makeStyles(colors);

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <SettingsHeader
        title={t("settings.general", "通用")}
        subtitle={t("settings.realtimeHint")}
      />

      <ScrollView style={s.scroll} contentContainerStyle={[s.scrollContent, { alignItems: "center" }]}>
        <View style={{ width: "100%", maxWidth: layout.centeredContentWidth, gap: 24 }}>
          {/* Theme */}
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: colors.mutedForeground }]}>
              {t("settings.theme", "主题")}
            </Text>
            <View style={s.themeGrid}>
              {THEMES.map((item) => {
                const active = mode === item.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[
                      s.themeCard,
                      { borderColor: colors.border, backgroundColor: colors.card },
                      active && {
                        borderColor: colors.primary,
                        backgroundColor: colors.primary + "0D",
                      },
                    ]}
                    onPress={() => setMode(item.id)}
                    activeOpacity={0.7}
                  >
                    <item.Icon size={24} color={active ? colors.primary : colors.mutedForeground} />
                    <Text
                      style={[
                        s.themeLabel,
                        { color: colors.foreground },
                        active && { fontWeight: fontWeight.medium, color: colors.primary },
                      ]}
                    >
                      {t(item.labelKey, item.fallback)}
                    </Text>
                    {active && (
                      <View style={s.checkBadge}>
                        <Text style={[s.checkMark, { color: colors.primary }]}>✓</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Language — single row with current value, tap to pick */}
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: colors.mutedForeground }]}>
              {t("settings.language", "语言")}
            </Text>
            <TouchableOpacity
              style={[s.langRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={openLangPicker}
              activeOpacity={0.7}
            >
              <Text style={[s.langRowLabel, { color: colors.foreground }]}>
                {currentLangLabel}
              </Text>
              <ChevronDownIcon size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* Android bottom sheet picker */}
      {Platform.OS !== "ios" && (
        <Modal
          visible={showLangPicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowLangPicker(false)}
        >
          <Pressable style={s.modalOverlay} onPress={() => setShowLangPicker(false)}>
            <View style={[s.modalSheet, { backgroundColor: colors.card }]}>
              <Text style={[s.modalTitle, { color: colors.foreground }]}>
                {t("settings.language")}
              </Text>
              {LANGUAGES.map((l) => (
                <TouchableOpacity
                  key={l.code}
                  style={s.modalItem}
                  onPress={() => handleLangChange(l.code)}
                  activeOpacity={0.7}
                >
                  <Text style={[s.modalItemText, { color: colors.foreground }]}>
                    {l.label}
                  </Text>
                  {lang === l.code && (
                    <Text style={[s.checkPrimary, { color: colors.primary }]}>✓</Text>
                  )}
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[s.modalCancel, { borderTopColor: colors.border }]}
                onPress={() => setShowLangPicker(false)}
              >
                <Text style={[s.modalCancelText, { color: colors.mutedForeground }]}>
                  {t("common.cancel")}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Modal>
      )}
    </SafeAreaView>
  );
}

function makeStyles(_colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    container: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.xxl,
      paddingBottom: 56,
      gap: 24,
    },
    section: { gap: 12 },
    sectionTitle: {
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
    },
    themeGrid: { flexDirection: "row", gap: 12 },
    themeCard: {
      flex: 1,
      alignItems: "center",
      gap: 8,
      borderRadius: radius.xl,
      borderWidth: 1,
      padding: 16,
      position: "relative",
    },
    themeLabel: { fontSize: fontSize.sm },
    checkBadge: { position: "absolute", top: 8, right: 8 },
    checkMark: { fontSize: 14 },
    langRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: 14,
      borderRadius: radius.xl,
      borderWidth: 1,
    },
    langRowLabel: { fontSize: fontSize.md },
    checkPrimary: { fontSize: 14 },
    // Modal styles for Android
    modalOverlay: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: "rgba(0,0,0,0.4)",
    },
    modalSheet: {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingTop: 20,
      paddingBottom: 34,
      paddingHorizontal: 8,
    },
    modalTitle: {
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      textAlign: "center",
      marginBottom: 12,
    },
    modalItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: 14,
    },
    modalItemText: { fontSize: fontSize.md },
    modalCancel: {
      marginTop: 8,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      alignItems: "center",
    },
    modalCancelText: { fontSize: fontSize.md },
  });
}
