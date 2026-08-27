'use client';

import React, { useState } from 'react';
import { getAppleEmojiUrl } from '../../lib/emoji';

// One emoji rendered as an Apple HD image, with the native emoji as fallback
// if the CDN image ever fails to load.
export function EmojiImg({
  char,
  size = 16,
  style,
}: {
  char: string;
  size?: number;
  style?: React.CSSProperties;
}): React.JSX.Element {
  const [failed, setFailed] = useState<boolean>(false);
  const src = getAppleEmojiUrl(char);
  if (!src || failed) {
    return <span style={{ lineHeight: 1, ...style }}>{char}</span>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={char}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        verticalAlign: '-0.14em',
        display: 'inline-block',
        pointerEvents: 'none',
        ...style,
      }}
    />
  );
}

// Emoji sequences: pictographs (optional skin tone + ZWJ chains), flags, keycaps.
const EMOJI_SOURCE =
  '(\\p{Extended_Pictographic}(?:\\u{1F3FB}-\\u{1F3FF})?\\uFE0F?(?:\\u200D\\p{Extended_Pictographic}(?:\\u{1F3FB}-\\u{1F3FF})?\\uFE0F?)*|\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3)';

// Replace every emoji in arbitrary text with an inline Apple HD image.
export function renderWithAppleEmojis(text: string, emojiSize = 16): React.ReactNode[] {
  if (!text) return [];
  const re = new RegExp(EMOJI_SOURCE, 'gu');
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(<EmojiImg key={m.index} char={m[0]} size={emojiSize} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
