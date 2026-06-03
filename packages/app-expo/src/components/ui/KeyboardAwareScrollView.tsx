import { useKeyboardInsets } from "@/hooks/use-keyboard-insets";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  type ScrollViewProps,
  type StyleProp,
  StyleSheet,
  type ViewStyle,
} from "react-native";
import { spacing } from "../../styles/theme";

interface KeyboardAwareScrollViewProps extends ScrollViewProps {
  keyboardViewStyle?: StyleProp<ViewStyle>;
  contentBottomInset?: number;
  keyboardVerticalOffset?: number;
}

export function KeyboardAwareScrollView({
  children,
  keyboardViewStyle,
  contentContainerStyle,
  contentBottomInset = spacing.xl,
  keyboardVerticalOffset = 0,
  keyboardShouldPersistTaps = "handled",
  keyboardDismissMode = "on-drag",
  ...props
}: KeyboardAwareScrollViewProps) {
  const keyboardInsets = useKeyboardInsets();
  const flattenedContent = StyleSheet.flatten(contentContainerStyle) as ViewStyle | undefined;
  const existingPaddingBottom =
    typeof flattenedContent?.paddingBottom === "number" ? flattenedContent.paddingBottom : 0;
  const bottomInset =
    keyboardInsets.safeAreaBottom + (keyboardInsets.isVisible ? keyboardInsets.bottomInset : 0);

  return (
    <KeyboardAvoidingView
      style={[styles.keyboardView, keyboardViewStyle]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={keyboardVerticalOffset}
    >
      <ScrollView
        {...props}
        automaticallyAdjustKeyboardInsets={false}
        contentContainerStyle={[
          contentContainerStyle,
          { paddingBottom: existingPaddingBottom + contentBottomInset + bottomInset },
        ]}
        keyboardDismissMode={keyboardDismissMode}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardView: { flex: 1 },
});
