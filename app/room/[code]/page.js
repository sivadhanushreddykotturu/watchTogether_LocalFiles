'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getSocket } from '../../../lib/socket';
import { detectMediaTracks, parseExternalSubtitle } from '../../../lib/subtitles';

// ---------- helpers ----------
function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

const clockFmt = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
  const [syncOk, setSyncOk] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playDisabled, setPlayDisabled] = useState(true);
  const [nowInfo, setNowInfo] = useState({ playing: false, time: 0, at: Date.now() });
  const [unread, setUnread] = useState(0);
  const [chatOpen, setChatOpen] = useState(true);
  const [dimmed, setDimmed] = useState(false);
  const [floatingBubbles, setFloatingBubbles] = useState([]);
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

  // ---------- element refs ----------
  const videoRef = useRef(null);
  const screenRef = useRef(null);
  const chatOpenRef = useRef(true);
  const timelineRef = useRef(null);
  const fillRef = useRef(null);
  const headRef = useRef(null);
  const ticksRef = useRef(null);
  const curRef = useRef(null);
  const durRef = useRef(null);
  const chatScrollRef = useRef(null);
  const chatInputRef = useRef(null);
  const fileInputRef = useRef(null);

  // ---------- logic refs (mutable, survive renders; no stale closures) ----------
  const sessionRef = useRef(null);   // { code, name }
  const joinedRef = useRef(false);
  const meRef = useRef(null);
  const fileLoadedRef = useRef(false);
  const latestStateRef = useRef({ playing: false, time: 0, at: Date.now() });
  const peersRef = useRef(new Map());
  const guardRef = useRef({ play: 0, pause: 0, seek: 0 });
  const lastLocalPauseRef = useRef(0);
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

  // ---------- small utilities ----------
  const toast = (text) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2600);
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

  const selectAudioTrack = (trackId, announce = true) => {
    activeAudioTrackIdRef.current = trackId;
    setActiveAudioTrackId(trackId);

    const video = videoRef.current;
    const list = audioTracksRef.current;
    const found = list.find((a) => a.id === trackId);

    // If browser supports HTML5 video.audioTracks API
    if (video && video.audioTracks && video.audioTracks.length > 0) {
      for (let i = 0; i < video.audioTracks.length; i++) {
        const at = video.audioTracks[i];
        at.enabled = (at.id === trackId || (found && found.index === i));
      }
    }

    if (announce && found) {
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
      const el = chatScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
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

  // ---------- player core ----------
  function updateTimeline() {
    const video = videoRef.current;
    const d = video && video.duration;
    if (!fileLoadedRef.current || !d || !isFinite(d)) {
      if (fillRef.current) fillRef.current.style.width = '0%';
      if (headRef.current) headRef.current.style.left = '0%';
      if (curRef.current) curRef.current.textContent = '0:00';
      if (durRef.current) durRef.current.textContent = '0:00';
      renderTicks();
      return;
    }
    const pct = (video.currentTime / d) * 100;
    fillRef.current.style.width = pct + '%';
    headRef.current.style.left = pct + '%';
    curRef.current.textContent = fmt(video.currentTime);
    durRef.current.textContent = fmt(d);
    renderTicks();
  }

  function renderTicks() {
    const box = ticksRef.current;
    if (!box) return;
    box.innerHTML = '';
    const video = videoRef.current;
    const d = video && video.duration;
    if (!fileLoadedRef.current || !d || !isFinite(d)) return;
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
    const video = videoRef.current;
    if (!fileLoadedRef.current || !video) { updateTimeline(); return; }
    const guard = guardRef.current;

    if (Math.abs(video.currentTime - state.time) > 0.5) {
      guard.seek++;
      video.currentTime = state.time;
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
    const video = videoRef.current;
    if (!('wakeLock' in navigator) || wakeLockRef.current || !fileLoadedRef.current || !video || video.paused) return;
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
    if (socket.connected && videoRef.current) {
      socket.emit('playback', { action, time: videoRef.current.currentTime });
    }
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

  function beat() {
    const socket = getSocket();
    const video = videoRef.current;
    if (!fileLoadedRef.current || !video || !socket.connected) return;
    socket.emit('time-update', video.currentTime, ({ expected, playing } = {}) => {
      if (typeof expected !== 'number') return;
      setStateLatest(playing, expected);
      const drift = expected - video.currentTime;
      if (playing && !video.paused && Math.abs(drift) > 1.5) {
        guardRef.current.seek++;
        video.currentTime = expected;
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
      setUsers(res.users);
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
      if (guardRef.current.play > 0) { guardRef.current.play--; return; }
      emitPlayback('play');
    };
    const onPause = () => {
      setPlaying(false);
      releaseWakeLock();
      if (guardRef.current.pause > 0) { guardRef.current.pause--; return; }
      lastLocalPauseRef.current = Date.now();
      emitPlayback('pause');
    };
    const onSeeked = () => {
      updateTimeline();
      updateSubtitles();
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
      const t = v.currentTime * 1000 - offsetRef.current;
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
    };

    const onLoadedMetadata = () => {
      updateTimeline();
      updateSubtitles();
      const v = videoRef.current;
      if (v && v.audioTracks && v.audioTracks.length > 1) {
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
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ended', onEnded);
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
      renderTicks();
    };
    const onChat = (msg) => {
      setMessages((prev) => [...prev.slice(-499), msg]);
      if (!msg.system && (!chatOpenRef.current || document.fullscreenElement || window.innerWidth <= 768)) {
        const bId = Date.now() + Math.random();
        setFloatingBubbles((prev) => [...prev.slice(-3), { id: bId, text: msg.text, name: msg.name, color: msg.color }]);
        setTimeout(() => {
          setFloatingBubbles((prev) => prev.filter((b) => b.id !== bId));
        }, 4500);
      }
      if (!chatVisible()) bumpUnread();
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
        applyState(latestStateRef.current);
        setSyncStatus(true);
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
    socket.on('playback', onPlayback);
    socket.on('users', onUsers);
    socket.on('chat', onChat);
    socket.on('peer-time', onPeerTime);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('subtitle', onSubtitle);

    // --- heartbeat + now-strip + subtitle ticker ---
    heartbeatRef.current = setInterval(beat, 2000);
    nowTickRef.current = setInterval(() => {
      setNowInfo({ ...latestStateRef.current });
    }, 1000);
    subTimerRef.current = setInterval(updateSubtitles, 80);

    // --- saved subtitle appearance (per person, this device only) ---
    try {
      const saved = JSON.parse(localStorage.getItem('reelsync:substyle') || 'null');
      if (saved) setSubStyle({ ...SUB_STYLE_DEFAULT, ...saved });
    } catch { /* ignore corrupt prefs */ }

    // --- page-level listeners ---
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      beat();
      ensureWakeLock();
      maybeClearUnread();
    };
    const onResize = () => maybeClearUnread();
    const onKey = (e) => {
      if (!fileLoadedRef.current || !videoRef.current) return;
      if (e.target.matches('input, textarea')) return;
      const v = videoRef.current;
      if (e.code === 'Space') { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
      if (e.code === 'ArrowRight') v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
      if (e.code === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 5);
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
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey);
      clearInterval(heartbeatRef.current);
      clearInterval(nowTickRef.current);
      clearInterval(subTimerRef.current);
      releaseWakeLock();
      if (video.src) { URL.revokeObjectURL(video.src); }
      document.title = 'ReelSync — watch local files together';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // autoscroll chat on new messages when visible
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el && chatVisible()) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // unread count in the tab title
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ReelSync` : 'ReelSync — watch local files together';
  }, [unread]);

  // remember subtitle appearance on this device
  useEffect(() => {
    try { localStorage.setItem('reelsync:substyle', JSON.stringify(subStyle)); } catch { /* private mode */ }
  }, [subStyle]);

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

  // ---------- UI handlers ----------
  const onPickFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    videoRef.current.src = URL.createObjectURL(file);
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
        selectAudioTrack(media.audio[0].id, false);
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
    const v = videoRef.current;
    if (!fileLoadedRef.current || !v) return;
    if (v.paused) v.play(); else v.pause();
  };

  const onScrub = (e, commit) => {
    const v = videoRef.current;
    if (!fileLoadedRef.current || !v || !v.duration) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = ratio * v.duration;
    fillRef.current.style.width = ratio * 100 + '%';
    headRef.current.style.left = ratio * 100 + '%';
    curRef.current.textContent = fmt(t);
    if (commit) v.currentTime = t; // fires 'seeked' once -> broadcast
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
        <span className={'sync-status' + (syncOk ? '' : ' behind')}>
          <span className="dot"></span><span>{syncOk ? 'in sync' : 'catching up…'}</span>
        </span>
        <span className="spacer"></span>
        <button className="btn ghost" onClick={leave}>Leave</button>
      </header>

      {/* phone-only quick action bar */}
      <div className="mobile-actions-bar">
        <button className="code-slate" onClick={copyCode} title="Copy room code">
          <span className="slate-label">ROOM</span>
          <span className="slate-code">{code}</span>
        </button>
        <button className={'mobile-action-btn' + (dimmed ? ' active' : '')} onClick={() => setDimmed(!dimmed)}>
          💡 {dimmed ? 'Lights' : 'Dim'}
        </button>
        <button className={'mobile-action-btn' + (subsOn ? ' active' : '')} onClick={() => setSubPanelOpen(!subPanelOpen)}>
          CC {subsOn ? 'On' : 'Off'}
        </button>
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
            <video ref={videoRef} playsInline></video>

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

            <div className={'picker' + (pickerOpen ? '' : ' hidden')}>
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

            <div className={'resume' + (resumeOpen ? '' : ' hidden')}>
              <button className="btn primary big" onClick={resume}>Catch up with the room</button>
            </div>
          </div>

          <div className="transport-wrap">
            {subPanelOpen && (
              <div className="sub-panel">
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
              </div>
            )}

            <div className="transport">
              <button className="t-btn" onClick={togglePlay} disabled={playDisabled} title="Play / pause (space)">
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

              <div
                className="timeline"
                ref={timelineRef}
                title="Seek"
                onPointerDown={(e) => {
                  if (!fileLoadedRef.current || !videoRef.current || !videoRef.current.duration) return;
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

              <input
                type="range"
                className="volume"
                min="0" max="1" step="0.05" defaultValue="1"
                title="Volume"
                onInput={(e) => { if (videoRef.current) videoRef.current.volume = Number(e.target.value); }}
              />

              <button
                className={'t-btn dim-btn' + (dimmed ? ' active' : '')}
                onClick={() => setDimmed(!dimmed)}
                title="Theater mode (L)"
              >
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>

              <button
                className={'t-btn cc' + (subPanelOpen ? ' active' : '') + (subsOn ? ' on' : '')}
                onClick={() => setSubPanelOpen(!subPanelOpen)}
                title="Subtitles (V to cycle)"
              >
                CC
                {subsOn && <span className="cc-dot" />}
              </button>

              <button className="t-btn" onClick={fullscreen} title="Fullscreen">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>
          </div>
        </section>

        <aside className="side">
          <div className="side-top-bar">
            <div className="side-top-info">
              <span className="side-title">Live Chat</span>
              <span className="side-count">({users.length})</span>
            </div>
            <button
              className="side-collapse-btn"
              onClick={() => {
                chatOpenRef.current = false;
                setChatOpen(false);
              }}
              title="Collapse chat"
              type="button"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
            </button>
          </div>

          <div className="viewers">
            {users.map((u) => (
              <span key={u.id} className={'viewer' + (u.id === meId ? ' me' : '')}>
                <span className="avatar" style={{ background: u.color }}>{u.name[0].toUpperCase()}</span>
                {u.name}
              </span>
            ))}
          </div>

          <div className="chat" ref={chatScrollRef}>
            {messages.map((m, i) =>
              m.system ? (
                <div key={i} className="msg system">{m.text}</div>
              ) : (
                <div key={i} className={'msg' + (m.sender === meId ? ' own' : '')}>
                  <span className="m-avatar" style={{ background: m.color }}>{m.name[0].toUpperCase()}</span>
                  <span className="m-body">
                    <span className="who" style={{ color: m.color }}>{m.name}<span className="when">{clockFmt(m.at)}</span></span>
                    <span className="m-text">{m.text}</span>
                  </span>
                </div>
              )
            )}
          </div>

          <form className="chat-form" onSubmit={sendChat}>
            <input ref={chatInputRef} type="text" placeholder="Say something…" maxLength={500} autoComplete="off" />
            <button className="btn primary send-btn" type="submit" title="Send">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </form>
        </aside>
      </div>

      <div className="toast-stack">
        {toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
      </div>
    </main>
  );
}

