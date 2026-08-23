'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import AppleEmojiPicker from '../../components/AppleEmojiPicker';
import { getSocket } from '../../../lib/socket';
import { detectMediaTracks, parseExternalSubtitle } from '../../../lib/subtitles';
import { transcodeAudioToMp3, getFFmpeg } from '../../../lib/audioTranscoder';
import { loadYouTubeApi, parseYouTubeId, fetchYouTubeInfo, searchYouTube } from '../../../lib/youtube';
import { parseMediaUrl } from '../../../lib/mediaEmbeds';
import { VoiceSession } from '../../../lib/voice';

// mic icons for the viewer chips
const micIcon = (on) =>
  on ? (
    <svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3z" fill="currentColor"/><path d="M19 11a7 7 0 0 1-14 0" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
  ) : (
    <svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3z" fill="currentColor"/><path d="M19 11a7 7 0 0 1-14 0" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
  );

// ---------- helpers ----------
function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

const clockFmt = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function getAppleEmojiUrl(emoji) {
  if (!emoji) return '';
  try {
    const codePoints = Array.from(emoji)
      .map((char) => char.codePointAt(0).toString(16).toLowerCase())
      .join('-');
    return `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/${codePoints}.png`;
  } catch (e) {
    return '';
  }
}

// ---------- subtitles & media ----------
const SUB_COLORS = ['#ffffff', '#facc15', '#86efac', '#67e8f9'];
const SUB_STYLE_DEFAULT = { size: 20, color: '#ffffff', bg: true, pos: 10 };
const SUB_POSITIONS = [[4, 'Low'], [10, 'Mid'], [18, 'High']];

// VLC semantics: positive = subtitles appear later.
const fmtOffset = (o) => (o > 0 ? `+${o} ms` : o < 0 ? `−${Math.abs(o)} ms` : '0 ms');

export default function Room() {
  const params = useParams();
  const router = useRouter();
  const code = String(params.code || '').toUpperCase();

  // ---------- render state ----------
  const [meId, setMeId] = useState(null);
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [tab, setTabState] = useState('chat');
  const [pickerOpen, setPickerOpen] = useState(true);
  const [pickerHint, setPickerHint] = useState('');
  const [resumeOpen, setResumeOpen] = useState(false);
  const [source, setSource] = useState(null); // { type: 'youtube', videoId, title } | null (null = local files)
  const [queue, setQueue] = useState([]);
  const [queueInput, setQueueInput] = useState('');
  const [queueLoading, setQueueLoading] = useState(false);
  const queueRef = useRef([]);
  const [ytPanelOpen, setYtPanelOpen] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [ytSearchModalOpen, setYtSearchModalOpen] = useState(false);
  const [ytSearchQuery, setYtSearchQuery] = useState('');
  const [ytSearchResults, setYtSearchResults] = useState([]);
  const [ytSearching, setYtSearching] = useState(false);
  const [ytSearchError, setYtSearchError] = useState('');
  const [queueTabMode, setQueueTabMode] = useState('search'); // 'search' | 'url'
  const searchAbortRef = useRef(null);
  const searchDebounceRef = useRef(null);
  const [adBreak, setAdBreak] = useState(false);
  const [ytError, setYtError] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [peerVoice, setPeerVoice] = useState({}); // socketId -> true while their mic is live
  const [speakers, setSpeakers] = useState({});  // socketId -> true while speaking
  const [ytTopBarVisible, setYtTopBarVisible] = useState(false);
  const [ytSettingsOpen, setYtSettingsOpen] = useState(false);
  const [ytQuality, setYtQuality] = useState('auto');
  const [ytCcOn, setYtCcOn] = useState(false);
  const [centerPulse, setCenterPulse] = useState(null); // 'play' | 'pause' | null
  const ytTopBarTimerRef = useRef(null);
  const centerPulseTimerRef = useRef(null);
  const [syncOk, setSyncOk] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playDisabled, setPlayDisabled] = useState(true);
  const [nowInfo, setNowInfo] = useState({ playing: false, time: 0, at: Date.now() });
  const [unread, setUnread] = useState(0);
  const [chatOpen, setChatOpen] = useState(true);
  const [dimmed, setDimmed] = useState(false);
  const [floatingBubbles, setFloatingBubbles] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [emojiTarget, setEmojiTarget] = useState('react'); // 'react' | 'chat'
  const emojiPickerRef = useRef(null);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [danmakuEnabled, setDanmakuEnabled] = useState(false);
  const [danmakuList, setDanmakuList] = useState([]);
  const [fileMatch, setFileMatch] = useState(null);
  const [joinError, setJoinError] = useState('');
  const [subTracks, setSubTracks] = useState([{ id: 'off', label: 'Off / Disabled', cues: [] }]);
  const [activeTrackId, setActiveTrackId] = useState('off');
  const [audioTracks, setAudioTracks] = useState([{ id: 'default', index: 0, label: 'Default Audio' }]);
  const [activeAudioTrackId, setActiveAudioTrackId] = useState('default');
  const [subsOn, setSubsOn] = useState(false);
  const [subText, setSubText] = useState('');
  const [subOffset, setSubOffset] = useState(0);
  const [subPanelOpen, setSubPanelOpen] = useState(false);
  const [subStyle, setSubStyle] = useState(SUB_STYLE_DEFAULT);
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomUiVisible, setZoomUiVisible] = useState(false);
  const zoomUiTimerRef = useRef(null);

  // player-chrome behavior: controls wake on cursor/touch activity, fade when idle
  function pokeZoomUi() {
    if (!document.fullscreenElement) return;
    setZoomUiVisible(true);
    clearTimeout(zoomUiTimerRef.current);
    zoomUiTimerRef.current = setTimeout(() => setZoomUiVisible(false), 2500);
  }
  const [extAudioName, setExtAudioName] = useState('');
  const [transcodingAudio, setTranscodingAudio] = useState(false);
  const [transcodeProgress, setTranscodeProgress] = useState(0);
  const [transcodeStatus, setTranscodeStatus] = useState('Converting audio...');

  // ---------- element refs ----------
  const videoRef = useRef(null);
  const extAudioRef = useRef(null);
  const loadedFileRef = useRef(null);
  const screenRef = useRef(null);
  const chatOpenRef = useRef(true);
  const danmakuEnabledRef = useRef(false);
  const peerFilesRef = useRef(new Map());
  const timelineRef = useRef(null);
  const fillRef = useRef(null);
  const headRef = useRef(null);
  const ticksRef = useRef(null);
  const curRef = useRef(null);
  const durRef = useRef(null);
  const chatScrollRef = useRef(null);
  const chatInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const audioInputRef = useRef(null);

  // ---------- logic refs (mutable, survive renders; no stale closures) ----------
  const sessionRef = useRef(null);   // { code, name }
  const joinedRef = useRef(false);
  const userIntentRef = useRef(false);
  const meRef = useRef(null);
  const fileLoadedRef = useRef(false);
  const latestStateRef = useRef({ playing: false, time: 0, at: Date.now() });
  const peersRef = useRef(new Map());
  const guardRef = useRef({ play: 0, pause: 0, seek: 0 });
  const lastLocalPauseRef = useRef(0);
  const lastLocalSeekRef = useRef(0); // grace window so drift correction can't yank back a fresh local seek
  const wakeLockRef = useRef(null);
  const heartbeatRef = useRef(null);
  const nowTickRef = useRef(null);
  const scrubbingRef = useRef(false);
  const tabRef = useRef('chat');
  const toastSeq = useRef(0);
  const subTracksRef = useRef([{ id: 'off', label: 'Off / Disabled', cues: [] }]);
  const activeTrackIdRef = useRef('off');
  const audioTracksRef = useRef([{ id: 'default', index: 0, label: 'Default Audio' }]);
  const activeAudioTrackIdRef = useRef('default');
  const cuesRef = useRef([]);
  const offsetRef = useRef(0);
  const subsOnRef = useRef(false);
  const subTimerRef = useRef(null);
  const speedRef = useRef(1);
  const sourceRef = useRef(null);          // mirror of `source` for event handlers
  const ytRef = useRef(null);              // YT.Player instance
  const ytHostRef = useRef(null);          // div the iframe replaces
  const ytPlayingRef = useRef(false);      // last known YT state
  const ytVideoIdRef = useRef(null);
  const ytLastRef = useRef({ t: 0, at: 0, playing: false }); // seek detection
  const ytTickRef = useRef(null);
  const ytStallRef = useRef(false); // "playing" but clock frozen = ad (or stall)
  const voiceRef = useRef(null); // VoiceSession, created lazily
  const voiceAudioRef = useRef(null); // hidden container for remote audio elements

  const ytMode = () => sourceRef.current?.type === 'youtube';
  const setSourceState = (s) => {
    sourceRef.current = s;
    setSource(s);
    if (s?.type === 'youtube' && !s.title && s.videoId) {
      fetchYouTubeInfo(s.videoId).then((info) => {
        if (info && info.title) {
          setSource((prev) => (prev?.videoId === s.videoId ? { ...prev, title: info.title } : prev));
        }
      });
    }
  };

  // Time/duration adapters — the sync engine reads through these so it
  // doesn't care whether the source is a local file or YouTube.
  function currentTimeAny() {
    if (ytMode() && ytRef.current?.getCurrentTime) return ytRef.current.getCurrentTime();
    return videoRef.current ? videoRef.current.currentTime : 0;
  }
  function durationAny() {
    if (ytMode() && ytRef.current?.getDuration) return ytRef.current.getDuration();
    return videoRef.current ? videoRef.current.duration : 0;
  }

  // ---------- small utilities ----------
  const toast = (text) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  };

  const selectTrack = (trackId, announce = true) => {
    activeTrackIdRef.current = trackId;
    setActiveTrackId(trackId);
    if (trackId === 'off') {
      subsOnRef.current = false;
      setSubsOn(false);
      cuesRef.current = [];
      setSubText('');
      if (announce) toast('Subtitles: Off');
    } else {
      const track = subTracksRef.current.find((t) => t.id === trackId);
      if (track) {
        cuesRef.current = track.cues || [];
        subsOnRef.current = true;
        setSubsOn(true);
        if (announce) toast(`Subtitles: ${track.label}`);
      }
    }
  };

  const cycleSubtitles = () => {
    const list = subTracksRef.current;
    if (!list || list.length <= 1) {
      toast('No alternate subtitle tracks available');
      return;
    }
    const curIdx = list.findIndex((t) => t.id === activeTrackIdRef.current);
    const nextIdx = (curIdx + 1) % list.length;
    const nextTrack = list[nextIdx];
    selectTrack(nextTrack.id, true);
  };

  const audioCacheRef = useRef({});

  const selectAudioTrack = async (trackId, announce = true) => {
    activeAudioTrackIdRef.current = trackId;
    setActiveAudioTrackId(trackId);

    const video = videoRef.current;
    const list = audioTracksRef.current;
    const found = list.find((a) => a.id === trackId);
    if (!found) return;

    // 1. If we already have this converted track in cache, switch instantly!
    if (audioCacheRef.current[trackId]) {
      const audioUrl = audioCacheRef.current[trackId];
      if (extAudioRef.current) {
        extAudioRef.current.src = audioUrl;
        extAudioRef.current.load();
        extAudioRef.current.muted = false;
        extAudioRef.current.volume = volume;
        if (video) {
          extAudioRef.current.currentTime = video.currentTime;
          extAudioRef.current.playbackRate = video.playbackRate;
          if (!video.paused) {
            extAudioRef.current.play().catch((e) => console.warn('Cached audio play:', e));
          }
        }
      }
      setExtAudioName(`${found.label} (Cached)`);
      if (announce) toast(`✓ Switched audio to: ${found.label}`);
      return;
    }

    // 2. Check if track needs conversion (EAC3, AC3, DTS)
    const isUnsupported = found.codec && (
      found.codec.includes('AC3') ||
      found.codec.includes('EAC3') ||
      found.codec.includes('DTS')
    );

    if (isUnsupported && loadedFileRef.current) {
      if (announce) {
        toast(`⚡ Converting ${found.label}... current audio continues playing`);
      }
      runAudioTranscode(loadedFileRef.current, found.trackNumber || null, trackId, found.label);
      return;
    }

    // 3. For native browser tracks (AAC/MP3 in video container)
    if (video && video.audioTracks && video.audioTracks.length > 0) {
      for (let i = 0; i < video.audioTracks.length; i++) {
        const at = video.audioTracks[i];
        at.enabled = (at.id === trackId || (found && found.index === i));
      }
    }

    if (announce) {
      toast(`Audio: ${found.label}`);
    }
  };

  const cycleAudioTrack = () => {
    const list = audioTracksRef.current;
    if (!list || list.length <= 1) {
      toast('Only one audio track available');
      return;
    }
    const curIdx = list.findIndex((a) => a.id === activeAudioTrackIdRef.current);
    const nextIdx = (curIdx + 1) % list.length;
    const nextTrack = list[nextIdx];
    selectAudioTrack(nextTrack.id, true);
  };

  const setTab = (t) => {
    tabRef.current = t;
    setTabState(t);
    if (t === 'chat') {
      maybeClearUnread();
    }
  };

  const chatVisible = () =>
    document.visibilityState === 'visible' &&
    (window.innerWidth >= 640 || tabRef.current === 'chat');

  const bumpUnread = () => setUnread((u) => u + 1);
  function maybeClearUnread() { if (chatVisible()) setUnread(0); }

  const setSyncStatus = (ok) => setSyncOk(ok);

  const setStateLatest = (playing, time) => {
    latestStateRef.current = { playing, time, at: Date.now() };
  };

  // ---------- volume control ----------
  const setVol = (v) => {
    const val = Math.max(0, Math.min(1, Number(v) || 0));
    setVolume(val);
    if (ytMode() && ytRef.current?.setVolume) ytRef.current.setVolume(Math.round(val * 100));
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = false;
    }
    if (extAudioRef.current) {
      extAudioRef.current.volume = val;
      extAudioRef.current.muted = false;
    }
  };

  // ---------- synced playback speed ----------
  const changeSpeed = (s, announce = true) => {
    const spd = Number(s) || 1;
    setSpeed(spd);
    speedRef.current = spd;
    if (videoRef.current) videoRef.current.playbackRate = spd;
    if (extAudioRef.current) extAudioRef.current.playbackRate = spd;
    if (ytRef.current?.setPlaybackRate) {
      try { ytRef.current.setPlaybackRate(spd); } catch {}
    }
    const socket = getSocket();
    if (socket.connected) socket.emit('playback-speed', spd);
    if (announce) toast(`Playback speed: ${spd}x`);
  };

  // ---------- live emoji reactions ----------
  const addReactionBubble = (emoji, id = null) => {
    const item = {
      id: id || Date.now() + Math.random(),
      emoji: String(emoji || '🍿'),
      left: 25 + Math.random() * 65,      // % — scattered across 25% to 90%
      drift: -50 + Math.random() * 100,   // px of sideways wander
      size: 26 + Math.random() * 16,      // px
      dur: 2.2 + Math.random() * 1.2,     // seconds
      rot: -25 + Math.random() * 50,      // deg
    };
    setReactions((prev) => [...prev.slice(-15), item]);
    setTimeout(() => {
      setReactions((prev) => prev.filter((r) => r.id !== item.id));
    }, item.dur * 1000 + 300);
  };

  const sendReaction = (emoji) => {
    const socket = getSocket();
    if (socket.connected) socket.emit('reaction', emoji);
    addReactionBubble(emoji);
  };

  // ---------- timestamp jump in chat ----------
  const seekToSeconds = (seconds) => {
    const v = videoRef.current;
    if (!v || !fileLoadedRef.current) return;
    v.currentTime = Math.min(v.duration || seconds, Math.max(0, seconds));
    emitPlayback('seek');
    toast(`Jumped to ${fmt(seconds)}`);
  };

  const renderChatText = (text) => {
    if (!text) return '';
    const regex = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
    const parts = [];
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      const fullMatch = match[0];
      const hours = Number(match[1] || 0);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const totalSeconds = hours * 3600 + minutes * 60 + seconds;
      parts.push(
        <button
          key={match.index}
          className="time-link"
          onClick={() => seekToSeconds(totalSeconds)}
          title={`Jump to ${fullMatch}`}
          type="button"
        >
          {fullMatch}
        </button>
      );
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }
    return parts.length > 0 ? parts : text;
  };

  // ---------- smart file match detection ----------
  const checkFileMatch = (myDuration, peerData) => {
    if (!myDuration || !peerData || peerData.size === 0) {
      setFileMatch(null);
      return;
    }
    let maxDelta = 0;
    let mismatchedPeer = null;
    for (const [id, meta] of peerData.entries()) {
      if (meta && meta.duration > 0) {
        const delta = Math.abs(myDuration - meta.duration);
        if (delta > maxDelta) {
          maxDelta = delta;
          mismatchedPeer = meta;
        }
      }
    }
    if (maxDelta <= 1.5) {
      setFileMatch({ match: true, delta: 0 });
    } else {
      setFileMatch({ match: false, delta: Math.round(maxDelta), peerName: mismatchedPeer ? mismatchedPeer.name : '' });
    }
  };

  // ---------- player core ----------
  function updateTimeline() {
    const d = durationAny();
    const t = currentTimeAny();
    if ((ytMode() && !ytRef.current) || (!ytMode() && !fileLoadedRef.current) || !d || !isFinite(d)) {
      if (fillRef.current) fillRef.current.style.width = '0%';
      if (headRef.current) headRef.current.style.left = '0%';
      if (curRef.current) curRef.current.textContent = '0:00';
      if (durRef.current) durRef.current.textContent = '0:00';
      renderTicks();
      return;
    }
    const pct = (t / d) * 100;
    fillRef.current.style.width = pct + '%';
    headRef.current.style.left = pct + '%';
    curRef.current.textContent = fmt(t);
    durRef.current.textContent = fmt(d);
    renderTicks();
  }

  function renderTicks() {
    const box = ticksRef.current;
    if (!box) return;
    box.innerHTML = '';
    const d = durationAny();
    if ((ytMode() && !ytRef.current) || (!ytMode() && !fileLoadedRef.current) || !d || !isFinite(d)) return;
    for (const [id, p] of peersRef.current) {
      if (id === (meRef.current && meRef.current.id) || typeof p.time !== 'number') continue;
      const el = document.createElement('div');
      el.className = 'tick';
      el.style.left = Math.min(100, (p.time / d) * 100) + '%';
      el.style.background = p.color;
      el.dataset.name = p.name;
      box.appendChild(el);
    }
  }

  function applyState(state) {
    setStateLatest(state.playing, state.time);

    // YouTube mode: drive the iframe player instead of the <video> element.
    if (sourceRef.current?.type === 'youtube') {
      const yt = ytRef.current;
      const guard = guardRef.current;
      if (!yt || !yt.seekTo) { updateTimeline(); return; }
      if (Math.abs(yt.getCurrentTime() - state.time) > 0.5) {
        guard.seek++;
        yt.seekTo(state.time, true);
      }
      if (state.playing) {
        guard.play++;
        yt.playVideo();
        setResumeOpen(false);
        // autoplay blocked = no PLAYING event arrives — undo the guard and ask for a tap
        setTimeout(() => {
          if (!ytPlayingRef.current && guardRef.current.play > 0) {
            guardRef.current.play--;
            setResumeOpen(true);
          }
        }, 900);
      } else if (ytPlayingRef.current) {
        guard.pause++;
        yt.pauseVideo();
      }
      updateTimeline();
      return;
    }

    const video = videoRef.current;
    if (!fileLoadedRef.current || !video) { updateTimeline(); return; }
    video.muted = false;
    video.volume = volume;
    const guard = guardRef.current;

    if (Math.abs(video.currentTime - state.time) > 0.5) {
      guard.seek++;
      video.currentTime = state.time;
    }
    if (extAudioRef.current && extAudioRef.current.src) {
      if (Math.abs(extAudioRef.current.currentTime - state.time) > 0.5) {
        extAudioRef.current.currentTime = state.time;
      }
      if (state.playing) {
        if (extAudioRef.current.paused) extAudioRef.current.play().catch(() => {});
      } else if (!extAudioRef.current.paused) {
        extAudioRef.current.pause();
      }
    }
    if (state.playing) {
      if (video.paused) {
        guard.play++;
        video.play().catch(() => {
          guard.play--; // autoplay blocked — ask for a tap
          setResumeOpen(true);
        });
      }
      setResumeOpen(false);
    } else if (!video.paused) {
      guard.pause++;
      video.pause();
    }
    updateTimeline();
  }

  async function ensureWakeLock() {
    if (ytMode()) {
      if (!('wakeLock' in navigator) || wakeLockRef.current || !ytPlayingRef.current) return;
    } else {
      const video = videoRef.current;
      if (!('wakeLock' in navigator) || wakeLockRef.current || !fileLoadedRef.current || !video || video.paused) return;
    }
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
      wakeLockRef.current.addEventListener('release', () => { wakeLockRef.current = null; });
    } catch { /* battery saver etc. — fine */ }
  }

  function releaseWakeLock() {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }

  function emitPlayback(action) {
    const socket = getSocket();
    if (!socket.connected) return;
    // every local seek funnels through here — timestamp it so the heartbeat's
    // drift correction gives the server a round-trip to catch up, instead of
    // snapping us back to the stale position mid-hop
    if (action === 'seek') lastLocalSeekRef.current = Date.now();
    socket.emit('playback', { action, time: currentTimeAny() });
  }

  // VLC-style delay: positive pushes subtitles later. Room-wide — everyone
  // watching the same moment needs subs shifted by the same amount.
  function nudgeSubtitles(step) {
    const next = Math.max(-60000, Math.min(60000, offsetRef.current + step));
    offsetRef.current = next;
    setSubOffset(next);
    const socket = getSocket();
    if (socket.connected) socket.emit('subtitle', { offset: next });
  }

  function toggleSubs() {
    subsOnRef.current = !subsOnRef.current;
    setSubsOn(subsOnRef.current);
  }

  // VLC-style zoom: scales the video frame to crop letterbox bars in fullscreen.
  function nudgeZoom(delta) {
    setZoom((z) => Math.min(2, Math.max(1, Math.round((z + delta) * 100) / 100)));
  }

  function beat() {
    const socket = getSocket();

    // YouTube mode heartbeat: same drift-correction contract, iframe time source.
    if (sourceRef.current?.type === 'youtube') {
      const yt = ytRef.current;
      if (!yt || !yt.getCurrentTime || !socket.connected) return;
      socket.emit('time-update', yt.getCurrentTime(), ({ expected, playing } = {}) => {
        if (typeof expected !== 'number') return;
        setStateLatest(playing, expected);
        const drift = expected - yt.getCurrentTime();
        if (playing && ytPlayingRef.current && !ytStallRef.current && Math.abs(drift) > 2 && Date.now() - lastLocalSeekRef.current > 1500) {
          guardRef.current.seek++;
          yt.seekTo(expected, true);
          setSyncStatus(false);
          setTimeout(() => setSyncStatus(true), 1200);
        } else if (playing && !ytPlayingRef.current && Date.now() - lastLocalPauseRef.current > 5000) {
          setResumeOpen(true);
        }
      });
      return;
    }

    const video = videoRef.current;
    if (!fileLoadedRef.current || !video || !socket.connected) return;
    socket.emit('time-update', video.currentTime, ({ expected, playing } = {}) => {
      if (typeof expected !== 'number') return;
      setStateLatest(playing, expected);
      const drift = expected - video.currentTime;
      if (playing && !video.paused && Math.abs(drift) > 1.5 && Date.now() - lastLocalSeekRef.current > 1500) {
        guardRef.current.seek++;
        video.currentTime = expected;
        if (extAudioRef.current && extAudioRef.current.src) {
          extAudioRef.current.currentTime = expected;
        }
        setSyncStatus(false);
        setTimeout(() => setSyncStatus(true), 1200);
      } else if (playing && video.paused && Date.now() - lastLocalPauseRef.current > 5000) {
        setResumeOpen(true); // room is rolling but we're stopped (not a deliberate pause)
      }
    });
  }

  // ---------- main effect: join, wire everything, clean up on leave ----------
  useEffect(() => {
    const name = sessionStorage.getItem('reelsync:name');
    if (!name) {
      router.replace(`/?room=${code}`);
      return;
    }
    const socket = getSocket();
    sessionRef.current = { code, name };
    setTab(window.innerWidth < 640 ? 'chat' : 'watch');

    // Pre-warm WebAssembly audio engine so it's ready in 0.0s
    getFFmpeg().catch((e) => console.log('FFmpeg pre-warming:', e));

    // --- join ---
    socket.emit('join-room', { code, name }, (res) => {
      if (!res || res.error) {
        setJoinError((res && res.error) || 'Could not join that room.');
        return;
      }
      joinedRef.current = true;
      meRef.current = res.self;
      setMeId(res.self.id);
      setStateLatest(res.state.playing, res.state.time);
      offsetRef.current = res.state.subOffset || 0;
      setSubOffset(offsetRef.current);
      setSourceState(res.state.source || null);
      if (Array.isArray(res.state.queue)) {
        setQueue(res.state.queue);
        queueRef.current = res.state.queue;
      }
      if (res.state.speed) {
        const s = Number(res.state.speed) || 1;
        setSpeed(s);
        speedRef.current = s;
        if (videoRef.current) videoRef.current.playbackRate = s;
        if (extAudioRef.current) extAudioRef.current.playbackRate = s;
        if (ytRef.current?.setPlaybackRate) {
          try { ytRef.current.setPlaybackRate(s); } catch {}
        }
      }
      setUsers(res.users);
      setPeerVoice(res.voice || {});
      setMessages(Array.isArray(res.history) ? res.history : []);
      if (res.state.playing) {
        setPickerHint(`The room is already watching — at ${fmt(res.state.time)} and rolling.`);
      }
    });

    // --- video element events ---
    const video = videoRef.current;
    const onPlay = () => {
      setPlaying(true);
      setSyncStatus(true);
      ensureWakeLock();
      if (extAudioRef.current && extAudioRef.current.src && extAudioRef.current.paused) {
        extAudioRef.current.play().catch(() => {});
      }
      if (guardRef.current.play > 0) { guardRef.current.play--; return; }
      if (userIntentRef.current) {
        userIntentRef.current = false;
        emitPlayback('play');
      }
    };
    const onPause = () => {
      setPlaying(false);
      releaseWakeLock();
      if (extAudioRef.current && extAudioRef.current.src && !extAudioRef.current.paused) {
        extAudioRef.current.pause();
      }
      if (guardRef.current.pause > 0) { guardRef.current.pause--; return; }
      if (userIntentRef.current) {
        userIntentRef.current = false;
        lastLocalPauseRef.current = Date.now();
        emitPlayback('pause');
      }
    };
    const onSeeking = () => {
      // Allow hardware decoders to seek without interruption
    };
    const onSeeked = () => {
      updateTimeline();
      updateSubtitles();
      const v = videoRef.current;
      const ext = extAudioRef.current;
      if (ext && ext.src && v) {
        ext.currentTime = v.currentTime;
        if (!v.paused) {
          ext.play().catch(() => {});
        }
      }
      if (guardRef.current.seek > 0) { guardRef.current.seek--; return; }
      emitPlayback('seek');
    };
    const onEnded = () => { setPlaying(false); releaseWakeLock(); };

    const updateSubtitles = () => {
      const v = videoRef.current;
      const cues = cuesRef.current;
      if (!v || !cues.length || !subsOnRef.current) {
        setSubText((prev) => (prev ? '' : prev));
        return;
      }
      const t = currentTimeAny() * 1000 - offsetRef.current;
      const matching = [];
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (t >= c.start && t <= c.end) {
          matching.push(c.text);
        }
      }
      const out = matching.join('\n');
      setSubText((prev) => (prev === out ? prev : out));
    };

    const onTime = () => {
      updateTimeline();
      updateSubtitles();
      const ext = extAudioRef.current;
      const v = videoRef.current;
      // Only correct drift if neither video nor audio is seeking
      if (ext && ext.src && v && !v.paused && !v.seeking && !ext.seeking) {
        if (ext.paused) {
          ext.play().catch(() => {});
        }
        const drift = Math.abs(ext.currentTime - v.currentTime);
        if (drift > 0.25) {
          ext.currentTime = v.currentTime;
        }
      }
    };

    const onLoadedMetadata = () => {
      updateTimeline();
      updateSubtitles();
      const v = videoRef.current;
      if (v && v.duration && socket.connected) {
        socket.emit('file-meta', {
          duration: v.duration,
          size: fileLoadedRef.current ? fileLoadedRef.current.size : 0,
          name: fileLoadedRef.current ? fileLoadedRef.current.name : '',
        });
        checkFileMatch(v.duration, peerFilesRef.current);
      }
      if (v && v.audioTracks && v.audioTracks.length > 1 && (!audioTracksRef.current || audioTracksRef.current.length <= 1)) {
        const list = [];
        for (let i = 0; i < v.audioTracks.length; i++) {
          const at = v.audioTracks[i];
          const lang = at.language ? `[${at.language.toUpperCase()}]` : '';
          const label = (at.label || `Audio Track ${i + 1}`) + (lang ? ` ${lang}` : '');
          list.push({ id: at.id || `audio-native-${i}`, index: i, label, language: at.language || 'und' });
        }
        audioTracksRef.current = list;
        setAudioTracks(list);
      }
    };
    const onRateChange = () => {
      const v = videoRef.current;
      if (!v) return;
      const newRate = Number(v.playbackRate);
      if (!newRate || Math.abs(newRate - speedRef.current) < 0.01) return;
      changeSpeed(newRate, true);
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ended', onEnded);
    video.addEventListener('ratechange', onRateChange);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onLoadedMetadata);

    // --- socket events ---
    const onPlayback = ({ action, time, playing: p, name: actor }) => {
      applyState({ playing: p, time });
      if (!fileLoadedRef.current) {
        setPickerHint(`${actor} pressed ${action} at ${fmt(time)} — load your file to join in.`);
        return;
      }
      const verb = action === 'seek' ? `jumped to ${fmt(time)}` : action === 'play' ? 'pressed play' : 'paused';
      toast(`${actor} ${verb}`);
    };
    const onUsers = (list) => {
      setUsers(list);
      const next = new Map();
      for (const u of list) {
        const prev = peersRef.current.get(u.id);
        next.set(u.id, { name: u.name, color: u.color, time: prev ? prev.time : undefined });
      }
      peersRef.current = next;
      setPeerVoice((prev) => {
        const ids = new Set(list.map((u) => u.id));
        return Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)));
      });
      renderTicks();
    };
    const onChat = (msg) => {
      setMessages((prev) => [...prev.slice(-499), msg]);
      if (!msg.system && danmakuEnabledRef.current) {
        const dId = Date.now() + Math.random();
        const topPct = 8 + Math.floor(Math.random() * 42);
        setDanmakuList((prev) => [...prev.slice(-12), { id: dId, text: msg.text, top: topPct }]);
        setTimeout(() => {
          setDanmakuList((prev) => prev.filter((d) => d.id !== dId));
        }, 7000);
      }
      // transient popup, bottom-right of the screen — the way you actually
      // notice a text mid-movie (fullscreen / chat collapsed / phone)
      if (!msg.system && (!chatOpenRef.current || document.fullscreenElement || window.innerWidth <= 768)) {
        const bId = Date.now() + Math.random();
        setFloatingBubbles((prev) => [...prev.slice(-2), { id: bId, text: msg.text, name: msg.name, color: msg.color }]);
        setTimeout(() => {
          setFloatingBubbles((prev) => prev.filter((b) => b.id !== bId));
        }, 2000);
      }
      if (!chatVisible()) bumpUnread();
    };

    const onPlaybackSpeed = ({ speed: spd, name: actor }) => {
      const s = Number(spd) || 1;
      setSpeed(s);
      speedRef.current = s;
      if (videoRef.current) videoRef.current.playbackRate = s;
      if (extAudioRef.current) extAudioRef.current.playbackRate = s;
      if (ytRef.current?.setPlaybackRate) {
        try { ytRef.current.setPlaybackRate(s); } catch {}
      }
      toast(`${actor} set speed to ${s}x`);
    };

    const onReaction = ({ emoji, id, sender }) => {
      if (sender && meRef.current && sender === meRef.current.id) return;
      addReactionBubble(emoji, id);
    };

    const onPeerFileMeta = ({ id, duration, size, name: fileName }) => {
      peerFilesRef.current.set(id, { duration, size, name: fileName });
      if (videoRef.current && videoRef.current.duration) {
        checkFileMatch(videoRef.current.duration, peerFilesRef.current);
      }
    };

    const onPeerTime = ({ id, time }) => {
      const p = peersRef.current.get(id);
      if (p) { p.time = time; renderTicks(); }
    };
    const onConnect = () => {
      if (!joinedRef.current) return; // initial join handles first connect
      socket.emit('join-room', { ...sessionRef.current, rejoin: true }, (res) => {
        if (!res || res.error) { router.replace('/'); return; }
        meRef.current = res.self;
        setMeId(res.self.id);
        setStateLatest(res.state.playing, res.state.time);
        setUsers(res.users);
        if (Array.isArray(res.state.queue)) {
          setQueue(res.state.queue);
          queueRef.current = res.state.queue;
        }
        applyState(latestStateRef.current);
        setSyncStatus(true);
        if (videoRef.current && videoRef.current.duration) {
          socket.emit('file-meta', {
            duration: videoRef.current.duration,
            size: fileLoadedRef.current ? fileLoadedRef.current.size : 0,
            name: fileLoadedRef.current ? fileLoadedRef.current.name : '',
          });
        }
        toast('Reconnected');
      });
    };
    const onDisconnect = () => {
      setSyncStatus(false);
      toast('Connection lost — reconnecting…');
    };
    const onSubtitle = ({ offset, name: actor }) => {
      const o = Number(offset) || 0;
      offsetRef.current = o;
      setSubOffset(o);
      toast(`${actor} set subtitle delay to ${fmtOffset(o)}`);
    };
    const onPeerVoice = ({ id, on }) => {
      setPeerVoice((prev) => ({ ...prev, [id]: !!on }));
    };
    const onSource = ({ source: s, playing: p, time, name: actor }) => {
      setSourceState(s);
      setStateLatest(p, time);
      setResumeOpen(false);
      if (s?.type === 'youtube' && s.videoId) {
        setSubPanelOpen(false);
        toast(`${actor} started playing ${s.title ? `"${s.title}"` : 'a YouTube video'}`);
        // pause local playback quietly — the room has moved on to YouTube
        const v = videoRef.current;
        if (v && !v.paused) { guardRef.current.pause++; v.pause(); }

        // Directly load new video in existing YouTube player to guarantee instant synchronized switch
        if (ytRef.current && typeof ytRef.current.loadVideoById === 'function') {
          ytVideoIdRef.current = s.videoId;
          ytRef.current.loadVideoById({
            videoId: s.videoId,
            startSeconds: Number(time) || 0,
          });
          if (speedRef.current && typeof ytRef.current.setPlaybackRate === 'function') {
            try { ytRef.current.setPlaybackRate(speedRef.current); } catch {}
          }
          if (p) {
            guardRef.current.play++;
            if (typeof ytRef.current.playVideo === 'function') ytRef.current.playVideo();
          } else {
            guardRef.current.pause++;
            if (typeof ytRef.current.pauseVideo === 'function') ytRef.current.pauseVideo();
          }
        }
      } else {
        toast(`${actor} switched back to local files`);
        if (!fileLoadedRef.current) setPickerHint('Pick your copy of the file to join in.');
      }
    };
    const onQueueUpdate = ({ queue: q, action, item, name: actor }) => {
      const list = Array.isArray(q) ? q : [];
      setQueue(list);
      queueRef.current = list;
      if (action === 'add' && item) {
        toast(`${actor || 'Someone'} added "${item.title || 'a video'}" to queue`);
      } else if (action === 'next' && item) {
        toast(`Now playing: ${item.title || 'Next video'}`);
      }
    };
    socket.on('playback', onPlayback);
    socket.on('users', onUsers);
    socket.on('chat', onChat);
    socket.on('playback-speed', onPlaybackSpeed);
    socket.on('reaction', onReaction);
    socket.on('peer-file-meta', onPeerFileMeta);
    socket.on('peer-time', onPeerTime);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('subtitle', onSubtitle);
    socket.on('source', onSource);
    socket.on('peer-voice', onPeerVoice);
    socket.on('queue-update', onQueueUpdate);

    // --- heartbeat + now-strip + subtitle ticker ---
    heartbeatRef.current = setInterval(beat, 2000);
    nowTickRef.current = setInterval(() => {
      setNowInfo({ ...latestStateRef.current });
    }, 1000);
    subTimerRef.current = setInterval(updateSubtitles, 80);

    // YouTube has no seek event — poll for jumps (and keep the timeline fresh).
    ytTickRef.current = setInterval(() => {
      if (!ytMode() || !ytRef.current || !ytRef.current.getCurrentTime) return;
      const cur = ytRef.current.getCurrentTime();
      const last = ytLastRef.current;
      const now = Date.now();
      const advancing = cur !== last.t;
      const stalled = ytPlayingRef.current && !advancing;
      if (stalled !== ytStallRef.current) {
        ytStallRef.current = stalled;
        setAdBreak(stalled);
      }

      if (last.playing && ytPlayingRef.current && !ytStallRef.current) {
        const expected = last.t + (now - last.at) / 1000;
        if (Math.abs(cur - expected) > 1.2) {
          if (guardRef.current.seek > 0) guardRef.current.seek--;
          else emitPlayback('seek');
        }
      }
      ytLastRef.current = { t: cur, at: now, playing: ytPlayingRef.current };
      updateTimeline();
    }, 250);

    // --- saved subtitle appearance + zoom (per person, this device only) ---
    try {
      const saved = JSON.parse(localStorage.getItem('reelsync:substyle') || 'null');
      if (saved) setSubStyle({ ...SUB_STYLE_DEFAULT, ...saved });
    } catch { /* ignore corrupt prefs */ }
    try {
      const savedZoom = Number(localStorage.getItem('reelsync:zoom'));
      if (savedZoom >= 1 && savedZoom <= 2) setZoom(savedZoom);
    } catch { /* ignore */ }

    const onFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement) setZoomUiVisible(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    const screenEl = screenRef.current;
    if (screenEl) {
      screenEl.addEventListener('mousemove', pokeZoomUi);
      screenEl.addEventListener('pointerdown', pokeZoomUi);
    }

    // --- page-level listeners ---
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      beat();
      ensureWakeLock();
      maybeClearUnread();
    };
    const onResize = () => maybeClearUnread();
    // hotkeys: space = play/pause, left/right = seek 5s
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (ytMode()) {
        const yt = ytRef.current;
        if (!yt || !yt.playVideo) return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.code === 'ArrowRight') yt.seekTo(Math.min(yt.getDuration() || 0, yt.getCurrentTime() + 5), true);
        if (e.code === 'ArrowLeft') yt.seekTo(Math.max(0, yt.getCurrentTime() - 5), true);
        if (e.code === 'KeyC') toggleYtCaptions();
        if (e.code === 'KeyL' || e.code === 'KeyD') setDimmed((prev) => !prev);
        return;
      }
      const v = videoRef.current;
      if (e.code === 'Space') {
        e.preventDefault();
        userIntentRef.current = true;
        if (v.paused) v.play(); else v.pause();
      }
      if (e.code === 'ArrowRight') {
        userIntentRef.current = true;
        const target = Math.min(v.duration || 0, v.currentTime + 5);
        v.currentTime = target;
        if (extAudioRef.current && extAudioRef.current.src) {
          extAudioRef.current.currentTime = target;
          if (!v.paused) extAudioRef.current.play().catch(() => {});
        }
      }
      if (e.code === 'ArrowLeft') {
        userIntentRef.current = true;
        const target = Math.max(0, v.currentTime - 5);
        v.currentTime = target;
        if (extAudioRef.current && extAudioRef.current.src) {
          extAudioRef.current.currentTime = target;
          if (!v.paused) extAudioRef.current.play().catch(() => {});
        }
      }
      const subStep = e.shiftKey ? 500 : 50; // VLC: G/H nudge subtitle delay
      if (e.code === 'KeyG') nudgeSubtitles(-subStep);
      if (e.code === 'KeyH') nudgeSubtitles(subStep);
      if (e.code === 'KeyV') cycleSubtitles(); // VLC: V cycles subtitle tracks
      if (e.code === 'KeyB') cycleAudioTrack(); // VLC: B cycles audio tracks
      if (e.code === 'KeyL' || e.code === 'KeyD') setDimmed((prev) => !prev);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);
    // (onFsChange registered above, removed in cleanup)

    // --- cleanup: leave the room, drop everything ---
    return () => {
      socket.emit('leave-room');
      socket.off('playback', onPlayback);
      socket.off('users', onUsers);
      socket.off('chat', onChat);
      socket.off('peer-time', onPeerTime);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('subtitle', onSubtitle);
      socket.off('source', onSource);
      socket.off('peer-voice', onPeerVoice);
      socket.off('queue-update', onQueueUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
      if (screenEl) {
        screenEl.removeEventListener('mousemove', pokeZoomUi);
        screenEl.removeEventListener('pointerdown', pokeZoomUi);
      }
      clearTimeout(zoomUiTimerRef.current);
      clearInterval(heartbeatRef.current);
      clearInterval(nowTickRef.current);
      clearInterval(subTimerRef.current);
      clearInterval(ytTickRef.current);
      if (voiceRef.current) voiceRef.current.leave();
      releaseWakeLock();
      if (video.src) { URL.revokeObjectURL(video.src); }
      document.title = 'ReelSync — watch local files together';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // YouTube player lifecycle: create once per mount, load on video change,
  // destroy when the room goes back to local files.
  useEffect(() => {
    if (source?.type !== 'youtube' || !source.videoId) {
      setYtError('');
      if (ytRef.current) {
        try { ytRef.current.destroy(); } catch {}
        ytRef.current = null;
        ytPlayingRef.current = false;
        ytVideoIdRef.current = null;
      }
      return;
    }
    const currentVideoId = source.videoId;
    let cancelled = false;
    setYtError('');
    loadYouTubeApi().then(() => {
      if (cancelled) return;
      if (ytRef.current && typeof ytRef.current.loadVideoById === 'function') {
        if (ytVideoIdRef.current !== currentVideoId) {
          ytVideoIdRef.current = currentVideoId;
          ytRef.current.loadVideoById({
            videoId: currentVideoId,
            startSeconds: latestStateRef.current.time || 0,
          });
          if (speedRef.current && typeof ytRef.current.setPlaybackRate === 'function') {
            try { ytRef.current.setPlaybackRate(speedRef.current); } catch {}
          }
          if (latestStateRef.current.playing) {
            ytRef.current.playVideo();
          }
        }
        return;
      }
      ytVideoIdRef.current = currentVideoId;
      ytRef.current = new window.YT.Player(ytHostRef.current, {
        videoId: currentVideoId,
        host: 'https://www.youtube.com',
        playerVars: {
          autoplay: latestStateRef.current.playing ? 1 : 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          iv_load_policy: 3,
          modestbranding: 1,
          origin: typeof window !== 'undefined' ? window.location.origin : undefined,
          widget_referrer: typeof window !== 'undefined' ? window.location.href : undefined,
        },
        events: {
          onReady: (e) => {
            ytLastRef.current = { t: 0, at: Date.now(), playing: false };
            if (speedRef.current && typeof e.target.setPlaybackRate === 'function') {
              try { e.target.setPlaybackRate(speedRef.current); } catch {}
            }
            applyState(latestStateRef.current); // join mid-playback if the room is rolling
            if (latestStateRef.current.playing) {
              guardRef.current.play++;
              try { e.target.playVideo(); } catch {}
            }
          },
          onPlaybackRateChange: (e) => {
            const newRate = Number(e.data);
            if (!newRate || Math.abs(newRate - speedRef.current) < 0.01) return;
            changeSpeed(newRate, true);
          },
          onStateChange: (e) => {
            const S = window.YT.PlayerState;
            if (e.data === S.PLAYING) {
              ytPlayingRef.current = true;
              setPlaying(true);
              setSyncStatus(true);
              ensureWakeLock();
              if (guardRef.current.play > 0) { guardRef.current.play--; return; }
              emitPlayback('play');
            } else if (e.data === S.PAUSED) {
              ytPlayingRef.current = false;
              setPlaying(false);
              releaseWakeLock();
              if (guardRef.current.pause > 0) { guardRef.current.pause--; return; }
              lastLocalPauseRef.current = Date.now();
              emitPlayback('pause');
            } else if (e.data === S.ENDED) {
              ytPlayingRef.current = false;
              setPlaying(false);
              releaseWakeLock();
              if (queueRef.current.length > 0) {
                const socket = getSocket();
                if (socket.connected) socket.emit('queue-next');
              }
            }
          },
          onError: (e) => {
            const map = {
              2: 'That video ID looks invalid — re-copy the link.',
              5: "This video can't play in an embedded player.",
              100: 'Video not found — it may be private or deleted.',
              101: "This video has age/embed restrictions set by YouTube or the creator.",
              150: "This video is age-restricted (18+) or blocked from external embedding by YouTube.",
            };
            setYtError(map[e.data] || "This video can't be embedded.");
          },
        },
      });
    }).catch(() => {
      if (!cancelled) {
        setYtError("YouTube can't be reached from this device.");
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.videoId, source?.type]);

  // autoscroll chat on new messages or when switching to chat tab or expanding sidebar
  useEffect(() => {
    if (tab === 'chat' && chatOpen) {
      maybeClearUnread();
      const scrollDown = () => {
        const el = chatScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      };
      scrollDown();
      const raf1 = requestAnimationFrame(scrollDown);
      const raf2 = requestAnimationFrame(() => requestAnimationFrame(scrollDown));
      const t1 = setTimeout(scrollDown, 50);
      const t2 = setTimeout(scrollDown, 150);
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
  }, [tab, chatOpen, messages]);

  // close emoji picker when clicking outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target)) {
        if (!e.target.closest('.picker-toggle-btn') && !e.target.closest('.chat-emoji-toggle')) {
          setEmojiPickerOpen(false);
        }
      }
    }
    if (emojiPickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [emojiPickerOpen]);

  // unread count in the tab title
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ReelSync` : 'ReelSync — watch local files together';
  }, [unread]);

  // remember subtitle appearance + zoom on this device
  useEffect(() => {
    try { localStorage.setItem('reelsync:substyle', JSON.stringify(subStyle)); } catch { /* private mode */ }
  }, [subStyle]);
  useEffect(() => {
    try { localStorage.setItem('reelsync:zoom', String(zoom)); } catch { /* private mode */ }
  }, [zoom]);

  const onPickSubs = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow picking the same file again after edits
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const cues = parseExternalSubtitle(text, file.name);
      if (!cues.length) {
        toast('No cues found — is that an .srt, .vtt, or .ass file?');
        return;
      }
      const extTrack = {
        id: `external-${Date.now()}`,
        type: 'external',
        label: `${file.name} (external)`,
        language: 'ext',
        cues,
      };
      const nonExt = subTracksRef.current.filter((t) => !t.id.startsWith('external-'));
      const nextTracks = [...nonExt, extTrack];
      subTracksRef.current = nextTracks;
      setSubTracks(nextTracks);
      selectTrack(extTrack.id, true);
    };
    reader.readAsText(file);
  };

  const onPickExternalAudio = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (extAudioRef.current) {
      extAudioRef.current.src = url;
      if (videoRef.current) {
        extAudioRef.current.currentTime = videoRef.current.currentTime;
        extAudioRef.current.playbackRate = videoRef.current.playbackRate;
      }
      extAudioRef.current.volume = volume;
      if (playing) extAudioRef.current.play().catch(() => {});
    }
    setExtAudioName(file.name);
    toast(`Loaded external audio: “${file.name}”`);
  };

  const runAudioTranscode = async (file, trackNum = null, trackId = null, trackLabel = null) => {
    const targetFile = file || loadedFileRef.current;
    if (!targetFile || transcodingAudio) return;
    setTranscodingAudio(true);
    setTranscodeProgress(0);
    setTranscodeStatus(`Extracting ${trackLabel ? trackLabel.split(' ')[0] : 'audio'}...`);
    try {
      const aacBlob = await transcodeAudioToMp3(
        targetFile,
        trackNum,
        (p) => setTranscodeProgress(p),
        (msg) => setTranscodeStatus(msg)
      );
      const audioUrl = URL.createObjectURL(aacBlob);

      // Cache the converted audio
      if (trackId) {
        audioCacheRef.current[trackId] = audioUrl;
      }
      if (trackNum) {
        audioCacheRef.current[`audio-${trackNum}`] = audioUrl;
      }

      // Only swap immediately if user is still on this track or if no specific track was set
      const isCurrentTrack = !trackId || activeAudioTrackIdRef.current === trackId;

      if (isCurrentTrack && extAudioRef.current) {
        extAudioRef.current.src = audioUrl;
        extAudioRef.current.load();
        extAudioRef.current.muted = false;
        extAudioRef.current.volume = volume;
        if (videoRef.current) {
          extAudioRef.current.currentTime = videoRef.current.currentTime;
          extAudioRef.current.playbackRate = videoRef.current.playbackRate;
          if (!videoRef.current.paused) {
            extAudioRef.current.play().catch((e) => console.warn('Audio auto-play:', e));
          }
        }
        setExtAudioName(`${trackLabel || 'Auto-transcoded'} (Lossless Audio)`);
        toast(`✓ ${trackLabel || 'Audio'} active in sync!`);
      } else {
        toast(`✓ Converted ${trackLabel || 'track'} in background!`);
      }
      setTranscodingAudio(false);
    } catch (err) {
      console.error('[ReelSync Transcoder Error]:', err);
      const errMsg = err?.message || String(err) || 'Unknown error';
      setTranscodingAudio(false);
      setTranscodeStatus(`Error: ${errMsg}`);
      toast(`⚠️ Audio conversion error: ${errMsg}`);
    }
  };

  // ---------- UI handlers ----------
  const onPickFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    loadedFileRef.current = file;
    audioCacheRef.current = {}; // clear cache for new file
    const v = videoRef.current;
    if (v) {
      v.src = URL.createObjectURL(file);
      v.volume = volume;
      v.muted = false;
      v.defaultMuted = false;
    }
    fileLoadedRef.current = true;
    setPlayDisabled(false);
    setPickerOpen(false);
    toast(`Loaded “${file.name}”`);
    applyState(latestStateRef.current); // line up with the room

    // Auto-detect embedded subtitles & audio tracks from video file
    try {
      const media = await detectMediaTracks(file);
      if (media.subtitles && media.subtitles.length > 0) {
        const nextTracks = [{ id: 'off', label: 'Off / Disabled', cues: [] }, ...media.subtitles];
        subTracksRef.current = nextTracks;
        setSubTracks(nextTracks);
        // Default to the first embedded subtitle track
        selectTrack(media.subtitles[0].id, false);
        const trackLangs = media.subtitles
          .map((t) => (t.language && t.language !== 'und' ? t.language.toUpperCase() : t.label))
          .join(', ');
        toast(`Found ${media.subtitles.length} subtitle track${media.subtitles.length > 1 ? 's' : ''} (${trackLangs}) — ${media.subtitles[0].label} active`);
      } else {
        const nonEmbedded = subTracksRef.current.filter((t) => t.type === 'external');
        const nextTracks = [{ id: 'off', label: 'Off / Disabled', cues: [] }, ...nonEmbedded];
        subTracksRef.current = nextTracks;
        setSubTracks(nextTracks);
        if (!nonEmbedded.length) selectTrack('off', false);
      }

      if (media.audio && media.audio.length > 0) {
        audioTracksRef.current = media.audio;
        setAudioTracks(media.audio);
        const firstAudio = media.audio[0];
        activeAudioTrackIdRef.current = firstAudio.id;
        setActiveAudioTrackId(firstAudio.id);

        const isUnsupported = firstAudio.codec && (
          firstAudio.codec.includes('AC3') ||
          firstAudio.codec.includes('EAC3') ||
          firstAudio.codec.includes('DTS')
        );

        if (isUnsupported) {
          toast(`⚡ Auto-converting ${firstAudio.label.split(' ')[0]} audio...`);
          runAudioTranscode(file, firstAudio.trackNumber || null, firstAudio.id, firstAudio.label);
        } else {
          selectAudioTrack(firstAudio.id, false);
        }
      } else {
        const defAudio = [{ id: 'default', index: 0, label: 'Default Audio Track' }];
        audioTracksRef.current = defAudio;
        setAudioTracks(defAudio);
        selectAudioTrack('default', false);
      }
    } catch (err) {
      console.warn('Could not extract media tracks:', err);
    }
  };

  const togglePlay = () => {
    if (ytMode()) {
      const yt = ytRef.current;
      if (!yt || !yt.playVideo) return;
      if (ytPlayingRef.current) yt.pauseVideo(); else yt.playVideo();
      return;
    }
    const v = videoRef.current;
    if (!fileLoadedRef.current || !v) return;
    userIntentRef.current = true;
    v.muted = false;
    v.volume = volume;
    if (v.paused) v.play(); else v.pause();
  };

  const onScrub = (e, commit) => {
    const d = durationAny();
    if (!d || !isFinite(d)) return;
    if (!ytMode() && !fileLoadedRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = ratio * d;
    fillRef.current.style.width = ratio * 100 + '%';
    headRef.current.style.left = ratio * 100 + '%';
    curRef.current.textContent = fmt(t);
    if (commit) {
      if (ytMode()) {
        ytRef.current.seekTo(t, true); // poll detects the jump -> broadcast
      } else {
        const v = videoRef.current;
        v.currentTime = t; // fires 'seeked' once -> broadcast
        if (extAudioRef.current && extAudioRef.current.src) {
          extAudioRef.current.currentTime = t;
          if (!v.paused) extAudioRef.current.play().catch(() => {});
        }
      }
    }
  };

  const handlePlayYouTube = async (playNow = true, customUrl = null) => {
    const raw = customUrl !== null ? customUrl : ytUrl;
    const parsed = parseMediaUrl(raw);
    if (!parsed) { toast("Paste a valid video or embed link"); return; }
    const socket = getSocket();
    if (!socket.connected) return;

    let title = parsed.title;
    if (parsed.type === 'youtube') {
      const info = await fetchYouTubeInfo(parsed.videoId);
      title = info.title;
    }

    if (playNow) {
      socket.emit('source', {
        type: parsed.type,
        videoId: parsed.videoId,
        embedUrl: parsed.embedUrl,
        url: parsed.url,
        title,
        platform: parsed.platform,
        playing: true,
      });
    } else {
      socket.emit('queue-add', {
        type: parsed.type,
        videoId: parsed.videoId,
        embedUrl: parsed.embedUrl,
        url: parsed.url,
        title,
        platform: parsed.platform,
        playNow: false,
      });
    }
    setYtUrl('');
    setYtPanelOpen(false);
  };

  const handleQueueAdd = async (playNow = false) => {
    const parsed = parseMediaUrl(queueInput);
    if (!parsed) {
      toast("Paste a valid YouTube or PH link");
      return;
    }
    const socket = getSocket();
    if (!socket.connected) return;
    setQueueLoading(true);

    let title = parsed.title;
    if (parsed.type === 'youtube') {
      const info = await fetchYouTubeInfo(parsed.videoId);
      title = info.title;
    }

    socket.emit('queue-add', {
      type: parsed.type,
      videoId: parsed.videoId,
      embedUrl: parsed.embedUrl,
      url: parsed.url,
      title,
      platform: parsed.platform,
      playNow,
    }, () => {
      setQueueLoading(false);
    });
    setQueueInput('');
    setQueueLoading(false);
  };

  const playQueueItem = (itemId) => {
    const socket = getSocket();
    if (socket.connected) socket.emit('queue-play', itemId);
  };

  const removeQueueItem = (itemId) => {
    const socket = getSocket();
    if (socket.connected) socket.emit('queue-remove', itemId);
  };

  const nextQueueItem = () => {
    const socket = getSocket();
    if (socket.connected) socket.emit('queue-next');
  };

  const clearQueue = () => {
    const socket = getSocket();
    if (socket.connected) socket.emit('queue-clear');
  };

  const switchToLocal = () => {
    const socket = getSocket();
    if (socket.connected) socket.emit('source', { type: 'local' });
    setYtPanelOpen(false);
  };

  const executeSearch = async (queryText) => {
    const q = String(queryText || '').trim();
    if (!q) {
      setYtSearchResults([]);
      setYtSearching(false);
      return;
    }
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;
    setYtSearching(true);
    setYtSearchError('');
    try {
      const results = await searchYouTube(q, ctrl.signal);
      if (!ctrl.signal.aborted) {
        setYtSearchResults(results);
        setYtSearching(false);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setYtSearchError('Failed to load search results. Please try again.');
        setYtSearching(false);
      }
    }
  };

  const handleSearchInputChange = (text) => {
    setYtSearchQuery(text);
    clearTimeout(searchDebounceRef.current);
    if (!text.trim()) {
      setYtSearchResults([]);
      setYtSearching(false);
      return;
    }
    searchDebounceRef.current = setTimeout(() => {
      executeSearch(text);
    }, 450);
  };

  const handleSelectSearchResult = (item, playNow = true) => {
    if (!item || !item.id) return;
    const socket = getSocket();
    if (!socket.connected) return;
    if (playNow) {
      socket.emit('source', { type: 'youtube', videoId: item.id, title: item.title, playing: true });
      toast(`Playing "${item.title}"`);
      setYtSearchModalOpen(false);
      setYtPanelOpen(false);
    } else {
      socket.emit('queue-add', { videoId: item.id, title: item.title, playNow: false });
      toast(`Added "${item.title}" to queue`);
    }
  };

  const pokeTopBar = () => {
    setYtTopBarVisible(true);
    clearTimeout(ytTopBarTimerRef.current);
    ytTopBarTimerRef.current = setTimeout(() => {
      setYtTopBarVisible(false);
    }, 2500);
  };

  const handleStageClick = () => {
    togglePlay();
    const nextAction = playing ? 'pause' : 'play';
    setCenterPulse(nextAction);
    clearTimeout(centerPulseTimerRef.current);
    centerPulseTimerRef.current = setTimeout(() => setCenterPulse(null), 550);
  };

  const toggleYtCaptions = () => {
    const yt = ytRef.current;
    if (!yt) return;
    const next = !ytCcOn;
    setYtCcOn(next);
    try {
      if (next) {
        if (typeof yt.loadModule === 'function') yt.loadModule('captions');
        if (typeof yt.setOption === 'function') {
          try { yt.setOption('captions', 'track', { languageCode: 'en' }); } catch {}
          try { yt.setOption('captions', 'reload', true); } catch {}
        }
      } else {
        if (typeof yt.setOption === 'function') {
          try { yt.setOption('captions', 'track', {}); } catch {}
        }
        if (typeof yt.unloadModule === 'function') {
          try { yt.unloadModule('captions'); } catch {}
        }
      }
    } catch (e) {
      console.warn('Captions toggle error:', e);
    }
    toast(`Captions: ${next ? 'On' : 'Off'}`);
  };

  const changeYtQuality = (q) => {
    setYtQuality(q);
    const yt = ytRef.current;
    if (yt?.setPlaybackQuality) {
      try { yt.setPlaybackQuality(q); } catch {}
    }
    toast(`Quality: ${q === 'auto' ? 'Auto (HD)' : q}`);
  };

  // ---------- voice ----------
  const toggleMic = async () => {
    const socket = getSocket();
    if (!voiceRef.current) voiceRef.current = new VoiceSession();
    const voice = voiceRef.current;

    if (!voice.joined) {
      try {
        const res = await new Promise((resolve) => socket.emit('voice-token', resolve));
        if (!res || res.error) { toast((res && res.error) || 'Voice unavailable.'); return; }
        await voice.join({
          url: res.url,
          token: res.token,
          onSpeakers: (ids) => setSpeakers(Object.fromEntries(ids.map((id) => [id, true]))),
          onRemoteAudio: (track) => {
            const el = track.attach();
            el.autoplay = true;
            if (voiceAudioRef.current) voiceAudioRef.current.appendChild(el);
          },
        });
        setMicOn(false);
        toast("You're in voice — you can hear everyone. Tap the mic to talk.");
      } catch {
        toast('Could not join voice — try again.');
      }
    } else {
      try {
        const on = await voice.enableMic(!voice.micOn);
        setMicOn(on);
        socket.emit('voice-state', { on });
      } catch {
        toast('Mic failed — check the browser permission and try again.');
      }
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Room code copied');
    } catch {
      toast('Room code: ' + code);
    }
  };

  const leave = () => {
    getSocket().emit('leave-room');
    router.push('/');
  };

  const resume = () => {
    setResumeOpen(false);
    applyState(latestStateRef.current);
  };

  const sendChat = (e) => {
    e.preventDefault();
    const text = chatInputRef.current.value.trim();
    if (!text) return;
    getSocket().emit('chat', text);
    chatInputRef.current.value = '';
    chatInputRef.current.focus();
  };

  const fullscreen = () => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (screenRef.current.requestFullscreen) screenRef.current.requestFullscreen().catch(() => {});
    else if (videoRef.current.webkitEnterFullscreen) videoRef.current.webkitEnterFullscreen(); // iPhone Safari
  };

  const nowPosition = nowInfo.playing
    ? nowInfo.time + (Date.now() - nowInfo.at) / 1000
    : nowInfo.time;

  // ---------- render ----------
  if (joinError) {
    return (
      <main className="landing">
        <div className="landing-card">
          <h1 className="wordmark"><span className="stroke">REEL</span><span className="fill-word">SYNC</span></h1>
          <p className="error" role="alert">{joinError}</p>
          <button className="btn primary big" onClick={() => router.push('/')}>Back to start</button>
        </div>
      </main>
    );
  }

  return (
    <main className={'room' + (dimmed ? ' theater-dim' : '')} data-tab={tab}>
      <header className="room-bar">
        <span className="brand">REEL<span className="brand-accent">SYNC</span></span>
        <button className="code-slate desktop-only" onClick={copyCode} title="Copy room code">
          <span className="slate-label">ROOM</span>
          <span className="slate-code">{code}</span>
        </button>
        <span className={'sync-status' + (syncOk && !adBreak ? '' : ' behind')}>
          <span className="dot"></span><span>{adBreak ? 'ad break…' : syncOk ? 'in sync' : 'catching up…'}</span>
        </span>
        {fileMatch && (
          <span className={'file-match-badge' + (fileMatch.match ? '' : ' mismatch')} title={fileMatch.match ? 'Exact file match across participants' : `Duration differs by ${fileMatch.delta}s`}>
            {fileMatch.match ? '✓ Same File' : `⚠️ ${fileMatch.delta}s diff`}
          </span>
        )}
        <span className="spacer"></span>
        <button className="btn ghost" onClick={leave}>Leave</button>
      </header>

      {/* phone-only quick action bar */}
      <div className="mobile-actions-bar">
        <button className="code-slate" onClick={copyCode} title="Copy room code">
          <span className="slate-label">ROOM</span>
          <span className="slate-code">{code}</span>
        </button>
        <button
          className={'mobile-action-btn' + (source?.type === 'youtube' ? (ytCcOn ? ' active' : '') : (subsOn ? ' active' : ''))}
          onClick={() => {
            if (source?.type === 'youtube') {
              toggleYtCaptions();
            } else {
              setSubPanelOpen(!subPanelOpen);
            }
          }}
          title={source?.type === 'youtube' ? 'Captions' : 'Subtitles'}
        >
          CC {source?.type === 'youtube' ? (ytCcOn ? 'On' : 'Off') : (subsOn ? 'On' : 'Off')}
        </button>
        {fileMatch && (
          <span className={'file-match-badge' + (fileMatch.match ? '' : ' mismatch')}>
            {fileMatch.match ? '✓ Matched' : `⚠️ ${fileMatch.delta}s`}
          </span>
        )}
        <span className="side-count">{users.length} watching</span>
      </div>

      <div className={'stage' + (chatOpen ? '' : ' chat-collapsed')}>
        <section className="screen-col">
          <div className="beam" aria-hidden="true"></div>

          {!chatOpen && (
            <button
              className="floating-chat-toggle"
              onClick={() => {
                chatOpenRef.current = true;
                setChatOpen(true);
                setUnread(0);
              }}
              title="Open chat"
              type="button"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
              <span>Chat</span>
              {unread > 0 && <span className="unread-dot">{unread}</span>}
            </button>
          )}

          <div className="screen" ref={screenRef}>
            <video
              ref={videoRef}
              playsInline
              className={source?.type === 'youtube' || source?.type === 'embed' ? 'hidden' : ''}
              style={{ transform: `scale(${zoom})` }}
            ></video>
            <audio ref={extAudioRef} playsInline style={{ display: 'none' }}></audio>
            <div ref={voiceAudioRef} style={{ display: 'none' }} aria-hidden="true"></div>

            {source?.type === 'embed' && (
              <div className="web-embed-wrap" style={{ transform: `scale(${zoom})` }}>
                <iframe
                  src={source.embedUrl}
                  className="web-embed-iframe"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                  allowFullScreen
                  frameBorder="0"
                />
              </div>
            )}

            {source?.type === 'youtube' && (
              <>
                <div className="yt-host" style={{ transform: `scale(${zoom})` }}>
                  <div ref={ytHostRef} className="yt-frame" />
                </div>

                <div
                  className="yt-stage-overlay"
                  onClick={(e) => {
                    if (e.target.closest('button, select, .yt-settings-popover')) return;
                    handleStageClick();
                  }}
                  onDoubleClick={(e) => {
                    if (e.target.closest('button, select, .yt-settings-popover')) return;
                    fullscreen();
                  }}
                  onMouseMove={pokeTopBar}
                  onMouseEnter={pokeTopBar}
                >
                  <div className={'yt-top-overlay' + (ytTopBarVisible || ytSettingsOpen ? ' visible' : '')}>
                    <div className="yt-top-title-wrap" title={source.title || 'YouTube Video'}>
                      <svg viewBox="0 0 24 24" width="20" height="20" className="yt-top-icon"><path d="M22 12s0-3.3-.42-4.8a2.5 2.5 0 0 0-1.76-1.77C18.25 5 12 5 12 5s-6.25 0-7.82.43A2.5 2.5 0 0 0 2.42 7.2C2 8.7 2 12 2 12s0 3.3.42 4.8c.23.86.9 1.53 1.76 1.77C5.75 19 12 19 12 19s6.25 0 7.82-.43a2.5 2.5 0 0 0 1.76-1.77C22 15.3 22 12 22 12zM10 15.5v-7l6 3.5-6 3.5z" fill="#ff0000"/></svg>
                      <span className="yt-top-title">{source.title || 'YouTube Video'}</span>
                    </div>

                    <div className="yt-top-actions">
                      <button
                        type="button"
                        className={'yt-top-btn cc' + (ytCcOn ? ' active' : '')}
                        onClick={(e) => { e.stopPropagation(); toggleYtCaptions(); }}
                        title="Toggle Subtitles / Captions"
                      >
                        CC
                      </button>

                      <div className="yt-settings-wrap">
                        <button
                          type="button"
                          className={'yt-top-btn settings' + (ytSettingsOpen ? ' active' : '')}
                          onClick={(e) => { e.stopPropagation(); setYtSettingsOpen(!ytSettingsOpen); }}
                          title="Playback Settings (Quality & Speed)"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        </button>

                        {ytSettingsOpen && (
                          <div className="yt-settings-popover" onClick={(e) => e.stopPropagation()}>
                            <div className="yt-settings-header">Playback Settings</div>
                            <div className="yt-settings-item">
                              <span className="yt-settings-label">Quality</span>
                              <select
                                className="yt-settings-select"
                                value={ytQuality}
                                onChange={(e) => changeYtQuality(e.target.value)}
                              >
                                <option value="auto">Auto (HD)</option>
                                <option value="hd1080">1080p HD</option>
                                <option value="hd720">720p HD</option>
                                <option value="large">480p</option>
                                <option value="medium">360p</option>
                                <option value="small">240p</option>
                              </select>
                            </div>
                            <div className="yt-settings-item">
                              <span className="yt-settings-label">Speed</span>
                              <select
                                className="yt-settings-select"
                                value={String(speed)}
                                onChange={(e) => changeSpeed(e.target.value)}
                              >
                                <option value="0.25">0.25x</option>
                                <option value="0.5">0.5x</option>
                                <option value="0.75">0.75x</option>
                                <option value="1">1.0x (Normal)</option>
                                <option value="1.25">1.25x</option>
                                <option value="1.5">1.5x</option>
                                <option value="1.75">1.75x</option>
                                <option value="2">2.0x</option>
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {centerPulse && (
                    <div className="center-pulse-anim" key={Date.now()}>
                      {centerPulse === 'play' ? (
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor"><path d="M8 5.14v13.72c0 .86.94 1.38 1.66.92l10.78-6.86c.69-.44.69-1.4 0-1.84L9.66 4.22A1.08 1.08 0 0 0 8 5.14z"/></svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor"><rect x="6" y="4.5" width="3.5" height="15" rx="1.5"/><rect x="14.5" y="4.5" width="3.5" height="15" rx="1.5"/></svg>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {ytError && (
              <div className="yt-error">
                <p className="yt-error-main">{ytError}</p>
                <p className="yt-error-sub">
                  If this video is age-restricted (18+), signing in on <a href="https://youtube.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-glow)', textDecoration: 'underline' }}>YouTube</a> in your browser or opening it directly will verify your account.
                </p>
                <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                  {source?.videoId && (
                    <a
                      href={`https://www.youtube.com/watch?v=${source.videoId}&t=${Math.floor(nowInfo.time || 0)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn primary"
                      style={{ padding: '6px 14px', fontSize: '12px', borderRadius: '8px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    >
                      <span>▶ Open on YouTube at {fmt(nowInfo.time || 0)}</span>
                    </a>
                  )}
                  {queue.length > 0 && (
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ padding: '6px 14px', fontSize: '12px', borderRadius: '8px' }}
                      onClick={() => {
                        const socket = getSocket();
                        if (socket.connected) socket.emit('queue-next');
                      }}
                    >
                      ⏭ Skip to Next in Queue
                    </button>
                  )}
                </div>
              </div>
            )}

            {danmakuEnabled && danmakuList.length > 0 && (
              <div className="danmaku-layer" aria-hidden="true">
                {danmakuList.map((d) => (
                  <span key={d.id} className="danmaku-item" style={{ top: `${d.top}%`, animationDuration: '6.5s' }}>
                    {d.text}
                  </span>
                ))}
              </div>
            )}

            {reactions.length > 0 && (
              <div className="reaction-stream" aria-hidden="true">
                {reactions.map((r) => {
                  const appleUrl = getAppleEmojiUrl(r.emoji);
                  return (
                    <span
                      key={r.id}
                      className="reaction-item"
                      style={{
                        left: `${r.left}%`,
                        width: `${Math.round(r.size * 1.35)}px`,
                        height: `${Math.round(r.size * 1.35)}px`,
                        animationDuration: `${r.dur}s`,
                        '--drift': `${r.drift}px`,
                        '--rot': `${r.rot}deg`,
                      }}
                    >
                      {appleUrl ? (
                        <img
                          src={appleUrl}
                          alt={r.emoji}
                          className="apple-emoji-img"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                            if (e.currentTarget.nextSibling) {
                              e.currentTarget.nextSibling.style.display = 'inline';
                            }
                          }}
                        />
                      ) : null}
                      <span style={{ display: appleUrl ? 'none' : 'inline', fontSize: `${r.size}px` }}>
                        {r.emoji}
                      </span>
                    </span>
                  );
                })}
              </div>
            )}

            {floatingBubbles.length > 0 && (
              <div className="floating-bubbles-layer" aria-live="polite">
                {floatingBubbles.map((b) => (
                  <div key={b.id} className="floating-bubble">
                    <span className="fb-author" style={{ color: b.color }}>{b.name}:</span>
                    <span className="fb-text">{b.text}</span>
                  </div>
                ))}
              </div>
            )}

            {isFullscreen && (
              <div className={'zoom-controls' + (zoomUiVisible ? ' show' : '')}>
                <button type="button" onClick={() => nudgeZoom(0.25)} title="Zoom in (crops black bars)">+</button>
                <button type="button" className="zoom-level" onClick={() => setZoom(1)} title="Reset zoom">{Math.round(zoom * 100)}%</button>
                <button type="button" onClick={() => nudgeZoom(-0.25)} title="Zoom out" disabled={zoom <= 1}>−</button>
              </div>
            )}

            {subsOn && subText && (
              <div
                className="sub-overlay"
                style={{
                  fontSize: subStyle.size + 'px',
                  color: subStyle.color,
                  bottom: subStyle.pos + '%',
                  background: subStyle.bg ? 'rgba(0, 0, 0, 0.65)' : 'transparent',
                }}
              >
                {subText}
              </div>
            )}

            {transcodingAudio && (
              <div className="transcode-indicator" aria-live="polite">
                <span className="transcode-spinner"></span>
                <span>{transcodeStatus}</span>
              </div>
            )}

            <div className={'picker' + (pickerOpen && !source ? '' : ' hidden')}>
              <label className="pick-orb" htmlFor="fileInput" title="Choose video file">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor" style={{ transform: 'translateX(2px)' }}>
                  <path d="M8 5.14v13.72c0 .86.94 1.38 1.66.92l10.78-6.86c.69-.44.69-1.4 0-1.84L9.66 4.22A1.08 1.08 0 0 0 8 5.14z"/>
                </svg>
              </label>
              <h2 className="picker-title">Reel it in</h2>
              <p className="picker-text">Pick your copy of the file this room is watching. It stays on your machine — only playback is synced.</p>
              <p className="picker-format">MP4 (H.264), WebM, and MKV with embedded subtitles & audio tracks.</p>
              <input type="file" id="fileInput" ref={fileInputRef} accept="video/*,.mkv,.mp4,.webm" hidden onChange={onPickFile} />
              <p className="picker-hint">{pickerHint}</p>
            </div>

            <div className={'resume' + (resumeOpen && !source ? '' : ' hidden')}>
              <button className="btn primary big" onClick={resume}>Catch up with the room</button>
            </div>

            {subPanelOpen && !source && (
              <>
                <div className="sub-backdrop" onClick={() => setSubPanelOpen(false)} />
                <div className="sub-panel">
                  <div className="sub-panel-head">
                    <span className="sub-panel-title">Subtitles & Audio</span>
                    <button className="sub-close-btn" onClick={() => setSubPanelOpen(false)} title="Close">
                      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
                    </button>
                  </div>

                  <div className="sub-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                      <span className="sub-label">Audio Track (B key · only you)</span>
                      {audioTracks.length > 1 && (
                        <span className="sub-badge">{audioTracks.length} Tracks</span>
                      )}
                    </div>
                    <select
                      className="sub-select"
                      value={activeAudioTrackId}
                      onChange={(e) => selectAudioTrack(e.target.value, true)}
                      disabled={audioTracks.length <= 1}
                    >
                      {audioTracks.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sub-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                      <span className="sub-label">Auto EAC-3 Transcoder</span>
                      {transcodingAudio && <span className="sub-badge">Converting {transcodeProgress}%</span>}
                    </div>
                    <button
                      type="button"
                      className="btn ghost sm"
                      style={{ width: '100%', justifyContent: 'center' }}
                      disabled={transcodingAudio || !fileLoadedRef.current}
                      onClick={() => runAudioTranscode()}
                    >
                      {transcodingAudio ? `Converting (${transcodeProgress}%)...` : '⚡ Auto-Convert EAC-3 Audio to MP3'}
                    </button>
                  </div>

                  <div className="sub-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                      <span className="sub-label">External Audio (MP3 / AAC / M4A)</span>
                      {extAudioName && <span className="sub-badge">Loaded</span>}
                    </div>
                    <label className="btn ghost sm" htmlFor="audioInput" style={{ cursor: 'pointer' }}>
                      {extAudioName ? `Replace: ${extAudioName.slice(0, 18)}...` : '+ Add audio file'}
                    </label>
                    <input id="audioInput" ref={audioInputRef} type="file" accept="audio/*,.mp3,.aac,.m4a,.wav,.ogg,.opus" hidden onChange={onPickExternalAudio} />
                  </div>

                  <div className="sub-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                      <span className="sub-label">Subtitle Track (V key · only you)</span>
                      {subTracks.filter((t) => t.type === 'embedded').length > 0 && (
                        <span className="sub-badge">
                          {subTracks.filter((t) => t.type === 'embedded').length} Embedded
                        </span>
                      )}
                    </div>
                    <select
                      className="sub-select"
                      value={activeTrackId}
                      onChange={(e) => selectTrack(e.target.value, true)}
                    >
                      {subTracks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sub-row">
                    <span className="sub-label">External file (SRT / VTT / ASS · only you)</span>
                    <label className="btn ghost sm" htmlFor="subInput" style={{ cursor: 'pointer' }}>
                      {subTracks.some((t) => t.type === 'external') ? 'Change external file' : '+ Add subtitle file'}
                    </label>
                    <input id="subInput" type="file" accept=".srt,.vtt,.ass,.ssa" hidden onChange={onPickSubs} />
                  </div>

                  <div className="sub-row">
                    <span className="sub-label">Delay — Room-Wide (G / H keys · synced)</span>
                    <button className="step-btn" onClick={() => nudgeSubtitles(-50)} title="Subtitles earlier by 50 ms (G)">−</button>
                    <span className="sub-offset">{fmtOffset(subOffset)}</span>
                    <button className="step-btn" onClick={() => nudgeSubtitles(50)} title="Subtitles later by 50 ms (H)">+</button>
                    <span className="sub-hint">V / B keys cycle · shift = 500 ms</span>
                  </div>

                  <div className="sub-row">
                    <span className="sub-label">Appearance (only you)</span>
                    <input
                      type="range"
                      className="sub-size"
                      min="14" max="34"
                      value={subStyle.size}
                      onChange={(e) => setSubStyle({ ...subStyle, size: Number(e.target.value) })}
                      title="Size"
                    />
                  </div>

                  <div className="sub-row">
                    {SUB_COLORS.map((c) => (
                      <button
                        key={c}
                        className={'swatch' + (subStyle.color === c ? ' sel' : '')}
                        style={{ background: c }}
                        onClick={() => setSubStyle({ ...subStyle, color: c })}
                        title={c}
                      />
                    ))}
                    <button
                      className={'btn ghost sm' + (subStyle.bg ? ' sel' : '')}
                      onClick={() => setSubStyle({ ...subStyle, bg: !subStyle.bg })}
                    >
                      Backdrop
                    </button>
                    <div className="seg">
                      {SUB_POSITIONS.map(([v, l]) => (
                        <button key={v} className={subStyle.pos === v ? 'sel' : ''} onClick={() => setSubStyle({ ...subStyle, pos: v })}>{l}</button>
                      ))}
                    </div>
                  </div>

                  <div className="sub-row">
                    <span className="sub-label">Flying Danmaku Comments</span>
                    <button
                      type="button"
                      className={'btn ghost sm' + (danmakuEnabled ? ' sel' : '')}
                      onClick={() => {
                        const next = !danmakuEnabled;
                        setDanmakuEnabled(next);
                        danmakuEnabledRef.current = next;
                        toast(`Flying comments: ${next ? 'On' : 'Off'}`);
                      }}
                    >
                      {danmakuEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="transport-wrap">
            {ytPanelOpen && (
              <>
                <div className="sub-backdrop" onClick={() => setYtPanelOpen(false)} />
                <div className="sub-panel yt-panel">
                  <div className="sub-panel-head">
                    <span className="sub-panel-title">YouTube</span>
                    <button className="sub-close-btn" onClick={() => setYtPanelOpen(false)} title="Close">
                      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
                    </button>
                  </div>
                  <div className="sub-row">
                    <button
                      className="btn primary"
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '9px 12px' }}
                      onClick={() => {
                        setYtPanelOpen(false);
                        setYtSearchModalOpen(true);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                      Search YouTube Videos
                    </button>
                  </div>
                  <div className="sub-row">
                    <span className="sub-label">Or Paste Link</span>
                    <div style={{ display: 'flex', gap: '6px', width: '100%' }}>
                      <input
                        type="text"
                        className="yt-url"
                        placeholder="Paste YouTube link…"
                        value={ytUrl}
                        onChange={(e) => setYtUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handlePlayYouTube(true); }}
                      />
                      <button className="btn primary sm" onClick={() => handlePlayYouTube(true)}>Play</button>
                      <button className="btn ghost sm" onClick={() => handlePlayYouTube(false)}>+ Queue</button>
                    </div>
                  </div>
                  {source?.type === 'youtube' && (
                    <div className="sub-row">
                      <button className="btn ghost sm" onClick={switchToLocal}>← Back to local files</button>
                      {queue.length > 0 && (
                        <button className="btn ghost sm" onClick={nextQueueItem}>Skip to next ({queue.length} in queue) →</button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="transport">
              <button className="t-btn" onClick={togglePlay} disabled={playDisabled && source?.type !== 'youtube'} title="Play / pause (space)">
                {playing ? (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <rect x="6" y="4.5" width="3.5" height="15" rx="1.5"/>
                    <rect x="14.5" y="4.5" width="3.5" height="15" rx="1.5"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style={{ transform: 'translateX(1.5px)' }}>
                    <path d="M8 5.14v13.72c0 .86.94 1.38 1.66.92l10.78-6.86c.69-.44.69-1.4 0-1.84L9.66 4.22A1.08 1.08 0 0 0 8 5.14z"/>
                  </svg>
                )}
              </button>

              {queue.length > 0 && (
                <button className="t-btn skip-btn" onClick={nextQueueItem} title={`Next video in queue (${queue.length} left)`}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
                  </svg>
                </button>
              )}

              <div
                className="timeline"
                ref={timelineRef}
                title="Seek"
                onPointerDown={(e) => {
                  if (!durationAny()) return;
                  scrubbingRef.current = true;
                  timelineRef.current.setPointerCapture(e.pointerId);
                  onScrub(e, false);
                }}
                onPointerMove={(e) => { if (scrubbingRef.current) onScrub(e, false); }}
                onPointerUp={(e) => { if (!scrubbingRef.current) return; scrubbingRef.current = false; onScrub(e, true); }}
              >
                <div className="track">
                  <div className="fill" ref={fillRef}></div>
                  <div className="ticks" ref={ticksRef}></div>
                  <div className="head" ref={headRef}></div>
                </div>
              </div>

              <span className="timecode"><span ref={curRef}>0:00</span><span className="sep">/</span><span ref={durRef}>0:00</span></span>

              <select
                className="speed-select"
                value={String(speed)}
                onChange={(e) => changeSpeed(e.target.value)}
                title="Playback speed (synced)"
              >
                <option value="0.25">0.25x</option>
                <option value="0.5">0.5x</option>
                <option value="0.75">0.75x</option>
                <option value="1">1.0x</option>
                <option value="1.25">1.25x</option>
                <option value="1.5">1.5x</option>
                <option value="1.75">1.75x</option>
                <option value="2">2.0x</option>
              </select>

              <div className="volume-wrap">
                <input
                  type="range"
                  className="volume"
                  min="0" max="1" step="0.05" value={volume}
                  title={`Volume: ${Math.round(volume * 100)}%`}
                  onChange={(e) => setVol(Number(e.target.value))}
                />
                <span className="vol-pct">
                  {Math.round(volume * 100)}%
                </span>
              </div>

              <button
                className={'t-btn yt-btn' + (source?.type === 'youtube' ? ' active' : '')}
                onClick={() => setYtPanelOpen(!ytPanelOpen)}
                title="YouTube together"
              >
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M22 12s0-3.3-.42-4.8a2.5 2.5 0 0 0-1.76-1.77C18.25 5 12 5 12 5s-6.25 0-7.82.43A2.5 2.5 0 0 0 2.42 7.2C2 8.7 2 12 2 12s0 3.3.42 4.8c.23.86.9 1.53 1.76 1.77C5.75 19 12 19 12 19s6.25 0 7.82-.43a2.5 2.5 0 0 0 1.76-1.77C22 15.3 22 12 22 12zM10 15.5v-7l6 3.5-6 3.5z" fill="currentColor"/></svg>
              </button>

              <button
                className={'t-btn dim-btn' + (dimmed ? ' active' : '')}
                onClick={() => setDimmed(!dimmed)}
                title="Theater mode (L)"
              >
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>

              <button
                className={'t-btn cc' + (source?.type === 'youtube' ? (ytCcOn ? ' active on' : '') : (subPanelOpen ? ' active' : '') + (subsOn ? ' on' : ''))}
                onClick={() => {
                  if (source?.type === 'youtube') {
                    toggleYtCaptions();
                  } else {
                    setSubPanelOpen(!subPanelOpen);
                  }
                }}
                title={source?.type === 'youtube' ? (ytCcOn ? 'Disable Captions (C)' : 'Enable Captions (C)') : 'Subtitles (V to cycle)'}
              >
                CC
                {(source?.type === 'youtube' ? ytCcOn : subsOn) && <span className="cc-dot" />}
              </button>

              <button className="t-btn" onClick={fullscreen} title="Fullscreen">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>
          </div>
        </section>

        <aside className="side">
          <div className="side-top-bar">
            <div className="side-tabs">
              <button
                type="button"
                className={'side-tab-btn' + (tab === 'chat' ? ' active' : '')}
                onClick={() => setTab('chat')}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span>Chat</span>
                {unread > 0 && <span className="unread-dot">{unread}</span>}
              </button>
              <button
                type="button"
                className={'side-tab-btn' + (tab === 'queue' ? ' active' : '')}
                onClick={() => setTab('queue')}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                <span>Queue</span>
                {queue.length > 0 && <span className="queue-pill">{queue.length}</span>}
              </button>
            </div>
            <button
              className="side-collapse-btn"
              onClick={() => {
                chatOpenRef.current = false;
                setChatOpen(false);
              }}
              title="Collapse sidebar"
              type="button"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
            </button>
          </div>

          {tab === 'chat' ? (
            <>
              <div className="viewers">
                {users.map((u) => {
                  const isMe = u.id === meId;
                  const on = isMe ? micOn : !!peerVoice[u.id];
                  const speaking = !!speakers[u.id];
                  return (
                    <span key={u.id} className={'viewer' + (isMe ? ' me' : '')}>
                      <span className={'avatar' + (speaking ? ' speaking' : '')} style={{ background: u.color }}>{u.name[0].toUpperCase()}</span>
                      {u.name}
                      {isMe ? (
                        <button
                          type="button"
                          className={'mic-btn' + (on ? ' on' : '')}
                          onClick={toggleMic}
                          title={on ? 'Mute your mic' : 'Unmute your mic'}
                        >
                          {micIcon(on)}
                        </button>
                      ) : (
                        <span className={'mic-btn mic-state' + (on ? ' on' : '')} title={on ? `${u.name} is on mic` : `${u.name} is muted`}>
                          {micIcon(on)}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>

              <div className="chat" ref={chatScrollRef}>
                {messages.length === 0 ? (
                  <div className="chat-empty">
                    <div className="chat-empty-icon">💬</div>
                    <div className="chat-empty-title">Welcome to the Room!</div>
                    <span className="chat-empty-hint">Say hi or share timestamps (e.g. 05:20) to jump to moments together.</span>
                  </div>
                ) : (
                  messages.map((m, i) => {
                    if (m.system) {
                      return (
                        <div key={i} className="msg system">
                          <span className="system-pill">{m.text}</span>
                        </div>
                      );
                    }
                    const isOwn = m.sender === meId;
                    const prev = messages[i - 1];
                    const isGrouped = prev && !prev.system && prev.sender === m.sender && (m.at - prev.at < 90000);
                    return (
                      <div key={i} className={'msg' + (isOwn ? ' own' : '') + (isGrouped ? ' grouped' : '')}>
                        {!isGrouped ? (
                          <div className="m-avatar" style={{ background: m.color }}>
                            {m.name ? m.name[0].toUpperCase() : '?'}
                          </div>
                        ) : (
                          <div className="m-avatar-spacer" />
                        )}
                        <div className="m-body">
                          {!isGrouped && (
                            <div className="m-header">
                              <span className="who" style={{ color: m.color }}>
                                {m.name}
                                {isOwn && <span className="you-badge">YOU</span>}
                              </span>
                              <span className="when">{clockFmt(m.at)}</span>
                            </div>
                          )}
                          <div className="m-bubble">
                            <div className="m-text">{renderChatText(m.text)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="reaction-bar">
                {['🍿', '😂', '🔥', '😱', '💀', '❤️', '🤌', '👀'].map((emoji) => {
                  const appleUrl = getAppleEmojiUrl(emoji);
                  return (
                    <button
                      key={emoji}
                      type="button"
                      className="react-btn"
                      onClick={() => sendReaction(emoji)}
                      title={`React with Apple HD ${emoji}`}
                    >
                      {appleUrl ? (
                        <img src={appleUrl} alt={emoji} className="apple-btn-emoji" />
                      ) : (
                        emoji
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={'react-btn picker-toggle-btn' + (emojiPickerOpen && emojiTarget === 'react' ? ' active' : '')}
                  onClick={() => {
                    setEmojiTarget('react');
                    setEmojiPickerOpen((v) => !v);
                  }}
                  title="All 2,300+ Apple HD Emojis..."
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" />
                    <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" />
                  </svg>
                </button>
              </div>

              {emojiPickerOpen && (
                <div className="emoji-picker-popover" ref={emojiPickerRef}>
                  <AppleEmojiPicker
                    target={emojiTarget}
                    onChangeTarget={setEmojiTarget}
                    onClose={() => setEmojiPickerOpen(false)}
                    onSelectEmoji={(char) => {
                      if (emojiTarget === 'chat') {
                        if (chatInputRef.current) {
                          chatInputRef.current.value += char;
                          chatInputRef.current.focus();
                        }
                      } else {
                        sendReaction(char);
                      }
                    }}
                  />
                </div>
              )}

              <form className="chat-form" onSubmit={sendChat}>
                <button
                  type="button"
                  className={'chat-emoji-toggle' + (emojiPickerOpen && emojiTarget === 'chat' ? ' active' : '')}
                  onClick={() => {
                    setEmojiTarget('chat');
                    setEmojiPickerOpen((v) => !v);
                  }}
                  title="Add emoji to chat"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" />
                    <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" />
                  </svg>
                </button>
                <input ref={chatInputRef} type="text" placeholder="Say something…" maxLength={500} autoComplete="off" />
                <button className="btn primary send-btn" type="submit" title="Send">
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </form>
            </>
          ) : (
            <div className="queue-container">
              <div className="queue-mode-switch">
                <button
                  type="button"
                  className={'q-mode-btn' + (queueTabMode === 'search' ? ' active' : '')}
                  onClick={() => setQueueTabMode('search')}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                  Search YouTube
                </button>
                <button
                  type="button"
                  className={'q-mode-btn' + (queueTabMode === 'url' ? ' active' : '')}
                  onClick={() => setQueueTabMode('url')}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  Paste Link
                </button>
              </div>

              {queueTabMode === 'search' ? (
                <div className="queue-search-section">
                  <div className="queue-search-input-wrap">
                    <input
                      type="text"
                      className="queue-input queue-search-input"
                      placeholder="Search YouTube videos…"
                      value={ytSearchQuery}
                      onChange={(e) => handleSearchInputChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          clearTimeout(searchDebounceRef.current);
                          executeSearch(ytSearchQuery);
                        }
                      }}
                    />
                    {ytSearching ? (
                      <div className="queue-search-spinner" />
                    ) : (
                      <button
                        type="button"
                        className="queue-search-btn"
                        onClick={() => executeSearch(ytSearchQuery)}
                        title="Search"
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    className="queue-modal-trigger-btn"
                    onClick={() => setYtSearchModalOpen(true)}
                  >
                    <span>Browse in full search window</span>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
                  </button>

                  {ytSearchResults.length > 0 && (
                    <div className="queue-search-results">
                      <div className="queue-search-results-header">
                        <span>Results ({ytSearchResults.length})</span>
                        <button type="button" className="qsr-clear" onClick={() => { setYtSearchResults([]); setYtSearchQuery(''); }}>Clear</button>
                      </div>
                      <div className="queue-search-items">
                        {ytSearchResults.slice(0, 10).map((video) => (
                          <div key={video.id} className="queue-search-item">
                            <div className="qsi-thumb-wrap">
                              <img src={video.thumbnail} alt={video.title} className="qsi-thumb" />
                              {video.duration && <span className="qsi-duration">{video.duration}</span>}
                            </div>
                            <div className="qsi-info">
                              <div className="qsi-title" title={video.title}>{video.title}</div>
                              <div className="qsi-author">{video.author}</div>
                            </div>
                            <div className="qsi-actions">
                              <button
                                type="button"
                                className="qi-btn play"
                                onClick={() => handleSelectSearchResult(video, true)}
                                title="Play now"
                              >
                                ▶
                              </button>
                              <button
                                type="button"
                                className="qi-btn add"
                                onClick={() => handleSelectSearchResult(video, false)}
                                title="Add to queue"
                              >
                                ＋
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="queue-add-box">
                  <input
                    type="text"
                    className="queue-input"
                    placeholder="Paste YouTube or PH link…"
                    value={queueInput}
                    onChange={(e) => setQueueInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleQueueAdd(false); }}
                  />
                  <div className="queue-add-actions">
                    <button
                      type="button"
                      className="btn primary sm"
                      onClick={() => handleQueueAdd(false)}
                      disabled={queueLoading || !queueInput.trim()}
                    >
                      + Queue
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => handleQueueAdd(true)}
                      disabled={queueLoading || !queueInput.trim()}
                    >
                      ▶ Play Now
                    </button>
                  </div>
                </div>
              )}

              {source && (
                <div className="queue-now-playing">
                  <div className="qnp-header">
                    <span className="qnp-badge">NOW PLAYING: {source.platform || (source.type === 'youtube' ? 'YOUTUBE' : 'WEB EMBED')}</span>
                    {queue.length > 0 && (
                      <button type="button" className="qnp-skip-btn" onClick={nextQueueItem} title="Skip to next video in queue">
                        Next ⏭
                      </button>
                    )}
                  </div>
                  <div className="qnp-content">
                    {source.videoId ? (
                      <img
                        src={`https://img.youtube.com/vi/${source.videoId}/mqdefault.jpg`}
                        alt="Thumbnail"
                        className="qnp-thumb"
                      />
                    ) : (
                      <div className="qnp-thumb placeholder">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
                      </div>
                    )}
                    <div className="qnp-info">
                      <div className="qnp-title" title={source.title || 'Playing Media'}>
                        {source.title || 'Playing Media'}
                      </div>
                      <div className="qnp-subtitle">{source.platform || 'Online Video Stream'}</div>
                    </div>
                  </div>
                </div>
              )}

              <div className="queue-list-header">
                <span className="ql-title">Up Next</span>
                <span className="ql-count">({queue.length})</span>
                {queue.length > 0 && (
                  <button type="button" className="ql-clear" onClick={clearQueue} title="Clear all queued videos">
                    Clear
                  </button>
                )}
              </div>

              <div className="queue-scroll">
                {queue.length === 0 ? (
                  <div className="queue-empty">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <p>The queue is empty</p>
                    <span>Search above or paste any video/embed link to queue up videos to watch next together!</span>
                  </div>
                ) : (
                  <div className="queue-items">
                    {queue.map((item, idx) => (
                      <div key={item.id || idx} className="queue-item">
                        <span className="qi-index">#{idx + 1}</span>
                        {item.videoId ? (
                          <img
                            src={`https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`}
                            alt="Thumbnail"
                            className="qi-thumb"
                          />
                        ) : (
                          <div className="qi-thumb placeholder">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
                          </div>
                        )}
                        <div className="qi-details">
                          <div className="qi-title" title={item.title}>
                            {item.title}
                          </div>
                          <div className="qi-meta">
                            Added by <span className="qi-by">{item.addedByName || 'Someone'}</span>
                          </div>
                        </div>
                        <div className="qi-actions">
                          <button
                            type="button"
                            className="qi-btn play"
                            onClick={() => playQueueItem(item.id)}
                            title="Play now"
                          >
                            ▶
                          </button>
                          <button
                            type="button"
                            className="qi-btn remove"
                            onClick={() => removeQueueItem(item.id)}
                            title="Remove from queue"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="reaction-bar" style={{ marginTop: 'auto', borderTop: '1px solid var(--border)' }}>
                {['🍿', '😂', '🔥', '😱', '💀', '❤️', '🤌', '👀'].map((emoji) => {
                  const appleUrl = getAppleEmojiUrl(emoji);
                  return (
                    <button
                      key={emoji}
                      type="button"
                      className="react-btn"
                      onClick={() => sendReaction(emoji)}
                      title={`React with Apple HD ${emoji}`}
                    >
                      {appleUrl ? (
                        <img src={appleUrl} alt={emoji} className="apple-btn-emoji" />
                      ) : (
                        emoji
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={'react-btn picker-toggle-btn' + (emojiPickerOpen && emojiTarget === 'react' ? ' active' : '')}
                  onClick={() => {
                    setEmojiTarget('react');
                    setEmojiPickerOpen((v) => !v);
                  }}
                  title="All 2,300+ Apple HD Emojis..."
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" />
                    <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {ytSearchModalOpen && (
        <div className="yt-search-modal-backdrop" onClick={() => setYtSearchModalOpen(false)}>
          <div className="yt-search-modal" onClick={(e) => e.stopPropagation()}>
            <div className="yt-search-header">
              <div className="yt-search-input-wrap">
                <svg className="yt-search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  className="yt-search-input"
                  placeholder="Search YouTube videos (e.g. songs, trailers, podcasts)..."
                  value={ytSearchQuery}
                  autoFocus
                  onChange={(e) => handleSearchInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      clearTimeout(searchDebounceRef.current);
                      executeSearch(ytSearchQuery);
                    }
                    if (e.key === 'Escape') setYtSearchModalOpen(false);
                  }}
                />
                {ytSearching ? (
                  <div className="yt-search-spinner" />
                ) : ytSearchQuery ? (
                  <button className="yt-search-clear" onClick={() => handleSearchInputChange('')} title="Clear">
                    ✕
                  </button>
                ) : null}
              </div>
              <button className="sub-close-btn" onClick={() => setYtSearchModalOpen(false)} title="Close (Esc)">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
              </button>
            </div>

            {!ytSearchQuery && (
              <div className="yt-search-suggestions">
                <span className="yt-sug-label">Popular topics:</span>
                {['Lofi Hip Hop', 'Synthwave', 'Movie Trailers', 'Chill Beats', 'Podcasts', 'Gaming', 'Top Music Hits'].map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="yt-sug-chip"
                    onClick={() => {
                      setYtSearchQuery(tag);
                      executeSearch(tag);
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            <div className="yt-search-body">
              {ytSearching && ytSearchResults.length === 0 ? (
                <div className="yt-search-loading-state">
                  <div className="yt-search-spinner-lg" />
                  <p>Searching YouTube...</p>
                </div>
              ) : ytSearchError ? (
                <div className="yt-search-error-state">
                  <p>{ytSearchError}</p>
                  <button className="btn ghost sm" onClick={() => executeSearch(ytSearchQuery)}>Retry</button>
                </div>
              ) : ytSearchResults.length > 0 ? (
                <div className="yt-search-grid">
                  {ytSearchResults.map((video) => (
                    <div key={video.id} className="yt-card">
                      <div className="yt-card-thumb-wrap">
                        <img src={video.thumbnail} alt={video.title} className="yt-card-thumb" />
                        {video.duration && <span className="yt-card-duration">{video.duration}</span>}
                      </div>
                      <div className="yt-card-info">
                        <div className="yt-card-title" title={video.title}>{video.title}</div>
                        <div className="yt-card-meta">
                          <span className="yt-card-author">{video.author}</span>
                          {video.views && <span className="yt-card-views"> · {video.views}</span>}
                        </div>
                        <div className="yt-card-actions">
                          <button
                            type="button"
                            className="btn primary sm"
                            onClick={() => handleSelectSearchResult(video, true)}
                            title="Play now for the whole room"
                          >
                            ▶ Play Now
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => handleSelectSearchResult(video, false)}
                            title="Add to shared queue"
                          >
                            + Queue
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : ytSearchQuery ? (
                <div className="yt-search-empty-state">
                  <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                  <p>No results found for &ldquo;{ytSearchQuery}&rdquo;</p>
                  <span>Try another search query or paste a direct YouTube link in the URL tab.</span>
                </div>
              ) : (
                <div className="yt-search-placeholder-state">
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                    <path d="M22 12s0-3.3-.42-4.8a2.5 2.5 0 0 0-1.76-1.77C18.25 5 12 5 12 5s-6.25 0-7.82.43A2.5 2.5 0 0 0 2.42 7.2C2 8.7 2 12 2 12s0 3.3.42 4.8c.23.86.9 1.53 1.76 1.77C5.75 19 12 19 12 19s6.25 0 7.82-.43a2.5 2.5 0 0 0 1.76-1.77C22 15.3 22 12 22 12zM10 15.5v-7l6 3.5-6 3.5z" />
                  </svg>
                  <p>Search YouTube to watch videos together</p>
                  <span>Type a search query above or pick one of the popular topics to get started.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="toast-stack">
        {toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
      </div>
    </main>
  );
}

