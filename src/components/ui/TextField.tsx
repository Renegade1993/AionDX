import { type ComponentRef, forwardRef, useState } from 'react';
import { Platform, TextInput, type TextInputProps } from 'react-native';

import { useColors } from '@/theme';

/** The browser's default focus outline (black in light) is replaced by the primary border below. */
const NO_WEB_OUTLINE = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null;

/**
 * TextInput with the app's focus state (SPEC §16 #9): a 2 pt `primary` border while focused, so
 * focus looks like every other active state. The unfocused border is transparent, so nothing
 * shifts when focus moves.
 */
export const TextField = forwardRef<ComponentRef<typeof TextInput>, TextInputProps>(function TextField({ style, onFocus, onBlur, ...rest }, ref) {
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={ref}
      {...rest}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[style, { borderWidth: 2, borderColor: focused ? c.primary : 'transparent' }, NO_WEB_OUTLINE]}
    />
  );
});
