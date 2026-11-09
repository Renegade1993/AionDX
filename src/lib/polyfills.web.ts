import { Alert, type AlertButton } from 'react-native';

// Browsers already provide crypto.getRandomValues.

/*
 * WEB PREVIEW ONLY. react-native-web's Alert.alert is a no-op, which hides every
 * confirmation in the app. Map it onto browser dialogs: one action → confirm(),
 * several → a numbered prompt().
 */
Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
  const text = [title, message].filter(Boolean).join('\n\n');
  const actions = (buttons ?? []).filter((b) => b.style !== 'cancel');
  const cancel = (buttons ?? []).find((b) => b.style === 'cancel');
  if (actions.length === 0) {
    window.alert(text);
    return;
  }
  if (actions.length === 1) {
    if (window.confirm(`${text}\n\n[OK = ${actions[0].text}]`)) actions[0].onPress?.();
    else cancel?.onPress?.();
    return;
  }
  const choice = window.prompt(`${text}\n\n${actions.map((b, i) => `${i + 1}. ${b.text}`).join('\n')}\n\nEnter a number (blank = cancel)`);
  const picked = actions[Number(choice) - 1];
  if (picked) picked.onPress?.();
  else cancel?.onPress?.();
};
