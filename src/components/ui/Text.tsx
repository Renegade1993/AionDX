import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { type ColorToken, type as typeScale, useColors } from '@/theme';

export type TextVariant = keyof typeof typeScale;

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  color?: ColorToken;
}

export function Text({ variant = 'body', color = 'text', style, ...rest }: TextProps) {
  const colors = useColors();
  return <RNText {...rest} style={[typeScale[variant] as TextStyle, { color: colors[color] }, style]} />;
}
