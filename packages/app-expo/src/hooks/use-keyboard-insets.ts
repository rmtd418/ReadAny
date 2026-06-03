import { useEffect, useMemo, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type KeyboardState = {
  height: number;
  visible: boolean;
};

export function useKeyboardInsets() {
  const safeAreaInsets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState<KeyboardState>({ height: 0, visible: false });

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      const height = Math.max(0, event.endCoordinates.height - safeAreaInsets.bottom);
      setKeyboard({ height, visible: height > 0 });
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboard({ height: 0, visible: false });
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [safeAreaInsets.bottom]);

  return useMemo(
    () => ({
      bottomInset: keyboard.height,
      height: keyboard.height,
      isVisible: keyboard.visible,
      safeAreaBottom: safeAreaInsets.bottom,
    }),
    [keyboard.height, keyboard.visible, safeAreaInsets.bottom],
  );
}
