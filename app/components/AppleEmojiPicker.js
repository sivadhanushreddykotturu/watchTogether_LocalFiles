'use client';

import React, { useState, useMemo } from 'react';

export function getAppleEmojiUrl(emoji) {
  if (!emoji) return '';
  try {
    const codePoints = Array.from(emoji)
      .map((char) => char.codePointAt(0).toString(16).toLowerCase())
      .join('-');
    return 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/' + codePoints + '.png';
  } catch (e) {
    return '';
  }
}

export const EMOJI_CATEGORIES = [
  {
    name: 'Smileys',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
      '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨',
      '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
      '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁',
      '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞',
      '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺',
      '👻', '👽', '👾', '🤖'
    ]
  },
  {
    name: 'Hands',
    icon: '🤌',
    emojis: [
      '🤌', '👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '👌', '🤏', '👈', '👉', '👆',
      '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤙', '💪', '🦾', '🖕', '✍️', '🙏', '🤝', '👏', '🙌',
      '👐', '🤲', '🫂', '👑', '🧢', '👒', '🕶️', '👓', '🥽', '🧣', '🧤', '🧥', '🧦', '👗', '👘', '🥻',
      '🩱', '🩲', '🩳', '👙', '👚', '👛', '👜', '👝', '🎒', '👞', '👟', '🥾', '🥿', '👠', '👡', '🩰', '👢'
    ]
  },
  {
    name: 'Hearts',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓',
      '💗', '💖', '💘', '💝', '💟', '✨', '🌟', '⭐', '💫', '🔥', '💥', '💯', '💢', '💨', '💤', '🎉',
      '🎊', '🎈', '🎁', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🪄', '💎', '🔮', '🧿', '🎀'
    ]
  },
  {
    name: 'Food',
    icon: '🍿',
    emojis: [
      '🍿', '🍔', '🍕', '🍟', '🌭', '🥪', '🌮', '🌯', '🫔', '🥙', '🧆', '🥗', '🥘', '🫕', '🥫', '🍝',
      '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡',
      '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍩', '🍪', '🍯', '☕', '🫖',
      '🍵', '🍶', '🍾', '🍷', '🍸', '🍹', '🍺', '🍻', '🥂', '🥃', '🥤', '🧋', '🧃', '🧉', '🧊', '🍎',
      '🍓', '🍉', '🍇', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍌', '🍋', '🍊', '🥑', '🥦', '🌽', '🌶️'
    ]
  },
  {
    name: 'Animals',
    icon: '🐶',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈',
      '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴',
      '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂',
      '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋',
      '🦈', '🦭', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘',
      '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈'
    ]
  },
  {
    name: 'Fun',
    icon: '🎬',
    emojis: [
      '🎬', '🎥', '📽️', '📺', '📻', '🎙️', '🎧', '🎸', '🎹', '🥁', '🎷', '🎺', '🎻', '🎮', '🕹️', '🎲',
      '♟️', '🎯', '🎳', '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🥏', '🎱', '🏓', '🏸', '🏒', '🏑',
      '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️',
      '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '🤺', '🏇', '🧘', '🏄', '🏊', '🚴', '🚀'
    ]
  }
];

export default function AppleEmojiPicker({ onSelectEmoji, target = 'react', onChangeTarget, onClose }) {
  const [activeCategory, setActiveCategory] = useState('All');

  const filteredEmojis = useMemo(() => {
    if (activeCategory === 'All') {
      return EMOJI_CATEGORIES.flatMap((c) => c.emojis);
    }
    const cat = EMOJI_CATEGORIES.find((c) => c.name === activeCategory);
    return cat ? cat.emojis : [];
  }, [activeCategory]);

  return (
    <div className="ep-container">
      <div className="emoji-picker-header">
        <div className="ep-actions" style={{ width: '100%', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              className={'ep-mode-btn' + (target === 'react' ? ' active' : '')}
              onClick={() => onChangeTarget && onChangeTarget('react')}
              title="Clicking an emoji spawns it live on the video screen"
            >
              🚀 React on Screen
            </button>
            <button
              type="button"
              className={'ep-mode-btn' + (target === 'chat' ? ' active' : '')}
              onClick={() => onChangeTarget && onChangeTarget('chat')}
              title="Clicking an emoji inserts it into the chat box"
            >
              💬 Insert to Chat
            </button>
          </div>
          <button
            type="button"
            className="ep-close-btn"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="ep-category-bar">
        <button
          type="button"
          className={'ep-cat-pill' + (activeCategory === 'All' ? ' active' : '')}
          onClick={() => setActiveCategory('All')}
        >
          All
        </button>
        {EMOJI_CATEGORIES.map((cat) => (
          <button
            key={cat.name}
            type="button"
            className={'ep-cat-pill' + (activeCategory === cat.name ? ' active' : '')}
            onClick={() => setActiveCategory(cat.name)}
            title={cat.name}
          >
            <img src={getAppleEmojiUrl(cat.icon)} alt={cat.name} className="ep-cat-img" />
            <span>{cat.name}</span>
          </button>
        ))}
      </div>

      <div className="ep-emoji-grid">
        {filteredEmojis.map((emoji, idx) => {
          const appleUrl = getAppleEmojiUrl(emoji);
          return (
            <button
              key={`${emoji}-${idx}`}
              type="button"
              className="ep-grid-btn"
              onClick={() => onSelectEmoji(emoji)}
              title={emoji}
            >
              {appleUrl ? (
                <img
                  src={appleUrl}
                  alt={emoji}
                  className="ep-apple-grid-img"
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    if (e.currentTarget.nextSibling) {
                      e.currentTarget.nextSibling.style.display = 'inline';
                    }
                  }}
                />
              ) : null}
              <span style={{ display: appleUrl ? 'none' : 'inline' }}>{emoji}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
