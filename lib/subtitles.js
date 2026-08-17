// lib/subtitles.js
// Client-side subtitle parsing & embedded subtitle track extraction for MKV, WebM, MP4, and external files.

// ---------------------------------------------------------------------------
// Helpers & Text Cleanup
// ---------------------------------------------------------------------------

export function tsToMs(s) {
  if (typeof s === 'number') return Math.round(s * 1000);
  const str = String(s || '').trim();
  // "hh:mm:ss,mmm" / "hh:mm:ss.mmm" / "mm:ss.mmm" / "h:mm:ss.m"
  const m = str.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  const hours = Number(m[1] || 0);
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0').slice(0, 3));
  return (hours * 3600 + mins * 60 + secs) * 1000 + ms;
}

export function cleanSubtitleText(raw) {
  if (!raw) return '';
  let text = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Handle ASS/SSA formatting overrides like {\an8}, {\pos(x,y)}, {\b1}, {\c&H...&}, {\fad(...)}
  text = text.replace(/\{[^}]+\}/g, '');

  // Handle ASS/SSA \N and \n linebreaks
  text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');

  // Remove HTML / WebVTT formatting tags like <i>, <b>, <u>, <c.yellow>, <v Speaker>
  text = text.replace(/<[^>]+>/g, '');

  // Trim whitespace on each line
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// External Subtitle File Parsers (.srt, .vtt, .ass/.ssa)
// ---------------------------------------------------------------------------

export function parseSrtOrVtt(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti === -1) continue;
    const parts = lines[ti].split('-->');
    const start = tsToMs(parts[0]);
    const end = tsToMs(parts[1]);
    if (start === null || end === null) continue;
    const cueText = cleanSubtitleText(lines.slice(ti + 1).join('\n'));
    if (cueText) cues.push({ start, end, text: cueText });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function parseAssOrSsa(text) {
  const cues = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  let formatFields = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Format:')) {
      const parts = trimmed.substring(7).split(',').map((s) => s.trim());
      if (parts.length > 0) formatFields = parts;
      continue;
    }
    if (trimmed.startsWith('Dialogue:')) {
      const content = trimmed.substring(9).trim();
      const numFields = formatFields.length;
      let parts = [];
      let cur = '';
      let fieldIdx = 0;
      for (let i = 0; i < content.length; i++) {
        if (fieldIdx < numFields - 1 && content[i] === ',') {
          parts.push(cur.trim());
          cur = '';
          fieldIdx++;
        } else {
          cur += content[i];
        }
      }
      parts.push(cur.trim());

      const startIdx = formatFields.indexOf('Start');
      const endIdx = formatFields.indexOf('End');
      const textIdx = formatFields.indexOf('Text');

      if (startIdx !== -1 && endIdx !== -1 && textIdx !== -1 && parts[startIdx] && parts[endIdx]) {
        const start = tsToMs(parts[startIdx]);
        const end = tsToMs(parts[endIdx]);
        const rawText = parts.slice(textIdx).join(',');
        const cueText = cleanSubtitleText(rawText);
        if (start !== null && end !== null && cueText) {
          cues.push({ start, end, text: cueText });
        }
      }
    }
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function parseExternalSubtitle(text, filename = '') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.ass') || lower.endsWith('.ssa') || text.includes('[Events]') || text.includes('Dialogue:')) {
    const cues = parseAssOrSsa(text);
    if (cues.length > 0) return cues;
  }
  return parseSrtOrVtt(text);
}

// ---------------------------------------------------------------------------
// Binary Chunk Reader for File slicing
// ---------------------------------------------------------------------------

async function readFileSlice(file, start, length) {
  const end = Math.min(file.size, start + length);
  if (start >= end) return new Uint8Array(0);
  const blob = file.slice(start, end);
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Matroska / WebM (EBML) Binary Helpers
// ---------------------------------------------------------------------------

function readEbmlVint(bytes, pos, maskMarker = true) {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  let length = 1;
  let mask = 0x7f;
  if (first >= 0x80) { length = 1; mask = 0x7f; }
  else if (first >= 0x40) { length = 2; mask = 0x3f; }
  else if (first >= 0x20) { length = 3; mask = 0x1f; }
  else if (first >= 0x10) { length = 4; mask = 0x0f; }
  else if (first >= 0x08) { length = 5; mask = 0x07; }
  else if (first >= 0x04) { length = 6; mask = 0x03; }
  else if (first >= 0x02) { length = 7; mask = 0x01; }
  else if (first >= 0x01) { length = 8; mask = 0x00; }
  else return null;

  if (pos + length > bytes.length) return null;

  let value = maskMarker ? (first & mask) : first;
  for (let i = 1; i < length; i++) {
    value = (value * 256) + bytes[pos + i];
  }
  return { value, length };
}

function readEbmlUint(bytes, pos, length) {
  let val = 0;
  for (let i = 0; i < length; i++) {
    val = (val * 256) + bytes[pos + i];
  }
  return val;
}

function readEbmlString(bytes, pos, length) {
  const slice = bytes.subarray(pos, pos + length);
  return new TextDecoder('utf-8').decode(slice);
}

export async function extractMatroskaMediaTracks(file) {
  // First check if file looks like EBML (0x1A45DFA3)
  const headerBytes = await readFileSlice(file, 0, 16);
  if (headerBytes.length < 4 || headerBytes[0] !== 0x1a || headerBytes[1] !== 0x45 || headerBytes[2] !== 0xdf || headerBytes[3] !== 0xa3) {
    return null; // Not Matroska / WebM
  }

  // Scan for Tracks element within the first 1MB-4MB
  let initialScanSize = Math.min(file.size, 4 * 1024 * 1024);
  let bytes = await readFileSlice(file, 0, initialScanSize);
  
  let timecodeScale = 1000000; // default 1ms
  const subtitleTracks = [];
  const audioTracks = [];

  // Parse root level
  let pos = 0;
  while (pos < bytes.length) {
    const idInfo = readEbmlVint(bytes, pos, false);
    if (!idInfo) break;
    const id = idInfo.value;
    pos += idInfo.length;

    const sizeInfo = readEbmlVint(bytes, pos, true);
    if (!sizeInfo) break;
    const size = sizeInfo.value;
    pos += sizeInfo.length;

    if (id === 0x18538067) { // Segment
      const segmentEnd = size === 0x01ffffffffffffff ? bytes.length : Math.min(bytes.length, pos + size);
      while (pos < segmentEnd) {
        const subIdInfo = readEbmlVint(bytes, pos, false);
        if (!subIdInfo) break;
        const subId = subIdInfo.value;
        pos += subIdInfo.length;

        const subSizeInfo = readEbmlVint(bytes, pos, true);
        if (!subSizeInfo) break;
        const subSize = subSizeInfo.value;
        pos += subSizeInfo.length;

        const subElemEnd = pos + subSize;

        if (subId === 0x1549a966) { // Info
          let p = pos;
          while (p < subElemEnd) {
            const iIdInfo = readEbmlVint(bytes, p, false);
            if (!iIdInfo) break;
            p += iIdInfo.length;
            const iSzInfo = readEbmlVint(bytes, p, true);
            if (!iSzInfo) break;
            p += iSzInfo.length;
            if (iIdInfo.value === 0x2ad7b1) {
              timecodeScale = readEbmlUint(bytes, p, iSzInfo.value) || 1000000;
            }
            p += iSzInfo.value;
          }
          pos = subElemEnd;
        } else if (subId === 0x1654ae6b) { // Tracks
          let p = pos;
          while (p < subElemEnd) {
            const tIdInfo = readEbmlVint(bytes, p, false);
            if (!tIdInfo) break;
            p += tIdInfo.length;
            const tSzInfo = readEbmlVint(bytes, p, true);
            if (!tSzInfo) break;
            p += tSzInfo.length;
            const tEnd = p + tSzInfo.value;

            if (tIdInfo.value === 0xae) { // TrackEntry
              let trackNum = null;
              let trackType = null;
              let trackName = '';
              let trackLang = '';
              let codecId = '';
              let flagDefault = 0;

              let ep = p;
              while (ep < tEnd) {
                const eIdInfo = readEbmlVint(bytes, ep, false);
                if (!eIdInfo) break;
                ep += eIdInfo.length;
                const eSzInfo = readEbmlVint(bytes, ep, true);
                if (!eSzInfo) break;
                ep += eSzInfo.length;
                const eId = eIdInfo.value;
                const eSz = eSzInfo.value;

                if (eId === 0xd7) trackNum = readEbmlUint(bytes, ep, eSz);
                else if (eId === 0x83) trackType = readEbmlUint(bytes, ep, eSz);
                else if (eId === 0x536e) trackName = readEbmlString(bytes, ep, eSz);
                else if (eId === 0x22b59c) trackLang = readEbmlString(bytes, ep, eSz);
                else if (eId === 0x22b59d && !trackLang) trackLang = readEbmlString(bytes, ep, eSz);
                else if (eId === 0x86) codecId = readEbmlString(bytes, ep, eSz);
                else if (eId === 0x88) flagDefault = readEbmlUint(bytes, ep, eSz);

                ep += eSz;
              }

              // TrackType === 17 (0x11) is subtitle track
              if (trackType === 17 || (codecId && codecId.startsWith('S_TEXT/')) || (codecId && codecId.startsWith('S_HDMV/'))) {
                subtitleTracks.push({
                  trackNumber: trackNum,
                  name: trackName || '',
                  language: trackLang || 'und',
                  codec: codecId,
                  default: flagDefault === 1,
                  cues: [],
                });
              } else if (trackType === 2 || (codecId && codecId.startsWith('A_'))) {
                // TrackType === 2 is Audio
                audioTracks.push({
                  trackNumber: trackNum,
                  name: trackName || '',
                  language: trackLang || 'und',
                  codec: codecId,
                  default: flagDefault === 1,
                });
              }
            }
            p = tEnd;
          }
          pos = subElemEnd;
        } else {
          if (subId === 0x1f43b675) {
            pos -= (subIdInfo.length + subSizeInfo.length);
            break;
          }
          pos = subElemEnd;
        }
      }
      break;
    } else {
      pos += size;
    }
  }

  // Scan Clusters throughout the entire file for subtitle cues
  if (subtitleTracks.length > 0) {
    const trackNums = new Set(subtitleTracks.map((t) => t.trackNumber));
    const trackMap = new Map(subtitleTracks.map((t) => [t.trackNumber, t]));
    const timeUnitToMs = timecodeScale / 1000000;
    
    let curFilePos = pos;
    let currentClusterTimecode = 0;

    // Read in buffered windows of 1MB, sliding forward as we advance
    let winStart = curFilePos;
    let winBytes = await readFileSlice(file, winStart, 1024 * 1024);

    while (curFilePos < file.size) {
      // Ensure we have at least 64KB in window ahead of curFilePos
      if (curFilePos + 65536 > winStart + winBytes.length && winStart + winBytes.length < file.size) {
        winStart = curFilePos;
        winBytes = await readFileSlice(file, winStart, 1024 * 1024);
      }

      const offsetInWin = curFilePos - winStart;
      if (offsetInWin >= winBytes.length) {
        winStart = curFilePos;
        winBytes = await readFileSlice(file, winStart, 1024 * 1024);
      }
      const localSlice = winBytes.subarray(curFilePos - winStart);
      if (localSlice.length < 4) break;

      const idInfo = readEbmlVint(localSlice, 0, false);
      if (!idInfo) {
        curFilePos += 1; // resync
        continue;
      }
      const id = idInfo.value;
      const idLen = idInfo.length;

      const sizeInfo = readEbmlVint(localSlice, idLen, true);
      if (!sizeInfo) {
        curFilePos += 1;
        continue;
      }
      const elemSize = sizeInfo.value;
      const headerLen = idLen + sizeInfo.length;

      if (id === 0x1f43b675) { // Cluster
        curFilePos += headerLen;
        continue;
      }

      if (id === 0xe7) { // Cluster Timecode
        let tcBytes = localSlice.subarray(headerLen, headerLen + elemSize);
        if (tcBytes.length < elemSize) {
          tcBytes = await readFileSlice(file, curFilePos + headerLen, elemSize);
        }
        currentClusterTimecode = readEbmlUint(tcBytes, 0, elemSize);
        curFilePos += (headerLen + elemSize);
        continue;
      }

      if (id === 0xa0) { // BlockGroup
        let bgBytes = localSlice.subarray(headerLen, headerLen + elemSize);
        if (bgBytes.length < elemSize) {
          bgBytes = await readFileSlice(file, curFilePos + headerLen, elemSize);
        }
        let bgPos = 0;
        let blockData = null;
        let blockDuration = null;

        while (bgPos < bgBytes.length) {
          const bgId = readEbmlVint(bgBytes, bgPos, false);
          if (!bgId) break;
          bgPos += bgId.length;
          const bgSz = readEbmlVint(bgBytes, bgPos, true);
          if (!bgSz) break;
          bgPos += bgSz.length;
          if (bgId.value === 0xa1) {
            blockData = bgBytes.subarray(bgPos, bgPos + bgSz.value);
          } else if (bgId.value === 0x9b) {
            blockDuration = readEbmlUint(bgBytes, bgPos, bgSz.value);
          }
          bgPos += bgSz.value;
        }

        if (blockData && blockData.length >= 4) {
          const trkInfo = readEbmlVint(blockData, 0, true);
          if (trkInfo && trackNums.has(trkInfo.value)) {
            const track = trackMap.get(trkInfo.value);
            const relTime = (blockData[trkInfo.length] << 8) | blockData[trkInfo.length + 1];
            const signedRelTime = (relTime & 0x8000) ? (relTime - 0x10000) : relTime;
            const payload = blockData.subarray(trkInfo.length + 3);
            const startMs = Math.round((currentClusterTimecode + signedRelTime) * timeUnitToMs);
            const durMs = blockDuration ? Math.round(blockDuration * timeUnitToMs) : 3500;
            const endMs = startMs + durMs;
            let rawText = new TextDecoder('utf-8').decode(payload);
            // Handle ASS format lines in MKV (ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text)
            if (track.codec.includes('ASS') || track.codec.includes('SSA')) {
              const commaIdx = getNthIndexOf(rawText, ',', 8);
              if (commaIdx !== -1) rawText = rawText.substring(commaIdx + 1);
            }
            const text = cleanSubtitleText(rawText);
            if (text) track.cues.push({ start: startMs, end: endMs, text });
          }
        }

        curFilePos += (headerLen + elemSize);
        continue;
      }

      if (id === 0xa3) { // SimpleBlock
        let sbBytes = localSlice.subarray(headerLen, headerLen + Math.min(elemSize, 32));
        if (sbBytes.length < 4) {
          sbBytes = await readFileSlice(file, curFilePos + headerLen, 32);
        }
        if (sbBytes.length >= 4) {
          const trkInfo = readEbmlVint(sbBytes, 0, true);
          if (trkInfo && trackNums.has(trkInfo.value)) {
            // Read full SimpleBlock payload for subtitle
            const fullSb = await readFileSlice(file, curFilePos + headerLen, elemSize);
            const track = trackMap.get(trkInfo.value);
            const relTime = (fullSb[trkInfo.length] << 8) | fullSb[trkInfo.length + 1];
            const signedRelTime = (relTime & 0x8000) ? (relTime - 0x10000) : relTime;
            const payload = fullSb.subarray(trkInfo.length + 3);
            const startMs = Math.round((currentClusterTimecode + signedRelTime) * timeUnitToMs);
            const endMs = startMs + 3500;
            let rawText = new TextDecoder('utf-8').decode(payload);
            if (track.codec.includes('ASS') || track.codec.includes('SSA')) {
              const commaIdx = getNthIndexOf(rawText, ',', 8);
              if (commaIdx !== -1) rawText = rawText.substring(commaIdx + 1);
            }
            const text = cleanSubtitleText(rawText);
            if (text) track.cues.push({ start: startMs, end: endMs, text });
          }
        }

        curFilePos += (headerLen + elemSize);
        continue;
      }

      // Skip any other element
      if (elemSize === 0x01ffffffffffffff) {
        curFilePos += headerLen;
      } else {
        curFilePos += (headerLen + elemSize);
      }
    }

    // Sort and clean overlapping cues
    for (const track of subtitleTracks) {
      track.cues.sort((a, b) => a.start - b.start);
      for (let i = 0; i < track.cues.length - 1; i++) {
        if (track.cues[i].end > track.cues[i + 1].start) {
          track.cues[i].end = track.cues[i + 1].start;
        }
      }
    }
  }

  return { subtitleTracks, audioTracks };
}

function getNthIndexOf(str, char, n) {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

export async function extractMp4MediaTracks(file) {
  let scanSize = Math.min(file.size, 1024 * 1024);
  let bytes = await readFileSlice(file, 0, scanSize);
  if (bytes.length < 8) return null;

  let isIso = false;
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (type === 'ftyp' || type === 'moov' || type === 'free' || type === 'mdat') {
      isIso = true;
      break;
    }
    if (size <= 0) break;
    pos += size;
  }
  if (!isIso) return null;

  let moovOffset = -1;
  let moovSize = 0;
  pos = 0;
  while (pos + 8 <= file.size) {
    const boxHeader = await readFileSlice(file, pos, 16);
    if (boxHeader.length < 8) break;
    let size = (boxHeader[0] << 24) | (boxHeader[1] << 16) | (boxHeader[2] << 8) | boxHeader[3];
    const type = String.fromCharCode(boxHeader[4], boxHeader[5], boxHeader[6], boxHeader[7]);
    let headerLen = 8;
    if (size === 1) {
      size = (boxHeader[8] * 0x100000000) + ((boxHeader[9] << 24) | (boxHeader[10] << 16) | (boxHeader[11] << 8) | boxHeader[12]);
      headerLen = 16;
    } else if (size === 0) {
      size = file.size - pos;
    }

    if (type === 'moov') {
      moovOffset = pos + headerLen;
      moovSize = size - headerLen;
      break;
    }
    pos += size;
  }

  if (moovOffset === -1 || moovSize <= 0) return { subtitleTracks: [], audioTracks: [] };

  const moovBytes = await readFileSlice(file, moovOffset, moovSize);
  const subtitleTracks = [];
  const audioTracks = [];

  function findBoxes(buf) {
    const boxes = [];
    let p = 0;
    while (p + 8 <= buf.length) {
      let bSize = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
      const bType = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      let bHead = 8;
      if (bSize === 1) {
        bSize = (buf[p + 8] * 0x100000000) + ((buf[p + 9] << 24) | (buf[p + 10] << 16) | (buf[p + 11] << 8) | buf[p + 12]);
        bHead = 16;
      } else if (bSize === 0) {
        bSize = buf.length - p;
      }
      if (bSize < bHead) break;
      boxes.push({ type: bType, offset: p + bHead, size: bSize - bHead, totalSize: bSize, raw: buf.subarray(p + bHead, p + bSize) });
      p += bSize;
    }
    return boxes;
  }

  const traks = findBoxes(moovBytes).filter((b) => b.type === 'trak');

  for (const trak of traks) {
    const mdia = findBoxes(trak.raw).find((b) => b.type === 'mdia');
    if (!mdia) continue;

    const mdiaBoxes = findBoxes(mdia.raw);
    const hdlr = mdiaBoxes.find((b) => b.type === 'hdlr');
    const mdhd = mdiaBoxes.find((b) => b.type === 'mdhd');
    const minf = mdiaBoxes.find((b) => b.type === 'minf');

    let handlerType = '';
    if (hdlr && hdlr.raw.length >= 12) {
      handlerType = String.fromCharCode(hdlr.raw[8], hdlr.raw[9], hdlr.raw[10], hdlr.raw[11]);
    }

    let timescale = 1000;
    let lang = 'und';
    if (mdhd && mdhd.raw.length >= 24) {
      const version = mdhd.raw[0];
      if (version === 1 && mdhd.raw.length >= 28) {
        timescale = (mdhd.raw[20] << 24) | (mdhd.raw[21] << 16) | (mdhd.raw[22] << 8) | mdhd.raw[23];
        const langCode = (mdhd.raw[32] << 8) | mdhd.raw[33];
        lang = parseMp4Language(langCode);
      } else {
        timescale = (mdhd.raw[12] << 24) | (mdhd.raw[13] << 16) | (mdhd.raw[14] << 8) | mdhd.raw[15];
        const langCode = (mdhd.raw[20] << 8) | mdhd.raw[21];
        lang = parseMp4Language(langCode);
      }
    }

    if (handlerType === 'soun') {
      audioTracks.push({
        trackNumber: audioTracks.length + 1,
        name: `Audio Track ${audioTracks.length + 1}`,
        language: lang,
        codec: 'mp4a',
        default: audioTracks.length === 0,
      });
      continue;
    }

    const isSub = handlerType === 'sbtl' || handlerType === 'text' || handlerType === 'subt' || handlerType === 'clcp';
    if (!isSub || !minf) continue;

    const minfBoxes = findBoxes(minf.raw);
    const stbl = minfBoxes.find((b) => b.type === 'stbl');
    if (!stbl) continue;

    const stblBoxes = findBoxes(stbl.raw);
    const stsd = stblBoxes.find((b) => b.type === 'stsd');
    const stts = stblBoxes.find((b) => b.type === 'stts');
    const stsz = stblBoxes.find((b) => b.type === 'stsz');
    const stco = stblBoxes.find((b) => b.type === 'stco');
    const co64 = stblBoxes.find((b) => b.type === 'co64');
    const stsc = stblBoxes.find((b) => b.type === 'stsc');

    let codec = 'tx3g';
    if (stsd && stsd.raw.length >= 16) {
      codec = String.fromCharCode(stsd.raw[12], stsd.raw[13], stsd.raw[14], stsd.raw[15]);
    }

    const sampleDurations = [];
    if (stts && stts.raw.length >= 8) {
      const entryCount = (stts.raw[4] << 24) | (stts.raw[5] << 16) | (stts.raw[6] << 8) | stts.raw[7];
      let p = 8;
      for (let i = 0; i < entryCount && p + 8 <= stts.raw.length; i++) {
        const count = (stts.raw[p] << 24) | (stts.raw[p + 1] << 16) | (stts.raw[p + 2] << 8) | stts.raw[p + 3];
        const delta = (stts.raw[p + 4] << 24) | (stts.raw[p + 5] << 16) | (stts.raw[p + 6] << 8) | stts.raw[p + 7];
        for (let j = 0; j < count; j++) sampleDurations.push(delta);
        p += 8;
      }
    }

    const sampleSizes = [];
    if (stsz && stsz.raw.length >= 12) {
      const defSize = (stsz.raw[4] << 24) | (stsz.raw[5] << 16) | (stsz.raw[6] << 8) | stsz.raw[7];
      const count = (stsz.raw[8] << 24) | (stsz.raw[9] << 16) | (stsz.raw[10] << 8) | stsz.raw[11];
      if (defSize !== 0) {
        for (let i = 0; i < count; i++) sampleSizes.push(defSize);
      } else {
        let p = 12;
        for (let i = 0; i < count && p + 4 <= stsz.raw.length; i++) {
          const sz = (stsz.raw[p] << 24) | (stsz.raw[p + 1] << 16) | (stsz.raw[p + 2] << 8) | stsz.raw[p + 3];
          sampleSizes.push(sz);
          p += 4;
        }
      }
    }

    const chunkOffsets = [];
    if (stco && stco.raw.length >= 8) {
      const count = (stco.raw[4] << 24) | (stco.raw[5] << 16) | (stco.raw[6] << 8) | stco.raw[7];
      let p = 8;
      for (let i = 0; i < count && p + 4 <= stco.raw.length; i++) {
        const off = (stco.raw[p] << 24) | (stco.raw[p + 1] << 16) | (stco.raw[p + 2] << 8) | stco.raw[p + 3];
        chunkOffsets.push(off);
        p += 4;
      }
    } else if (co64 && co64.raw.length >= 8) {
      const count = (co64.raw[4] << 24) | (co64.raw[5] << 16) | (co64.raw[6] << 8) | co64.raw[7];
      let p = 8;
      for (let i = 0; i < count && p + 8 <= co64.raw.length; i++) {
        const off = (co64.raw[p] * 0x100000000) + ((co64.raw[p + 4] << 24) | (co64.raw[p + 5] << 16) | (co64.raw[p + 6] << 8) | co64.raw[p + 7]);
        chunkOffsets.push(off);
        p += 8;
      }
    }

    const sampleOffsets = [];
    if (stsc && stsc.raw.length >= 8 && chunkOffsets.length > 0) {
      const count = (stsc.raw[4] << 24) | (stsc.raw[5] << 16) | (stsc.raw[6] << 8) | stsc.raw[7];
      const stscEntries = [];
      let p = 8;
      for (let i = 0; i < count && p + 12 <= stsc.raw.length; i++) {
        const firstChunk = (stsc.raw[p] << 24) | (stsc.raw[p + 1] << 16) | (stsc.raw[p + 2] << 8) | stsc.raw[p + 3];
        const samplesPerChunk = (stsc.raw[p + 4] << 24) | (stsc.raw[p + 5] << 16) | (stsc.raw[p + 6] << 8) | stsc.raw[p + 7];
        stscEntries.push({ firstChunk, samplesPerChunk });
        p += 12;
      }

      let sampleIdx = 0;
      for (let c = 0; c < chunkOffsets.length; c++) {
        const chunkNum = c + 1;
        let samplesInThisChunk = 1;
        for (let i = stscEntries.length - 1; i >= 0; i--) {
          if (chunkNum >= stscEntries[i].firstChunk) {
            samplesInThisChunk = stscEntries[i].samplesPerChunk;
            break;
          }
        }
        let curChunkOffset = chunkOffsets[c];
        for (let s = 0; s < samplesInThisChunk && sampleIdx < sampleSizes.length; s++) {
          sampleOffsets.push(curChunkOffset);
          curChunkOffset += sampleSizes[sampleIdx];
          sampleIdx++;
        }
      }
    } else if (chunkOffsets.length === sampleSizes.length) {
      for (const off of chunkOffsets) sampleOffsets.push(off);
    }

    const cues = [];
    let curTime = 0;
    const timeScaleFactor = 1000 / (timescale || 1000);

    for (let i = 0; i < sampleOffsets.length; i++) {
      const dur = sampleDurations[i] || 0;
      const startMs = Math.round(curTime * timeScaleFactor);
      const endMs = Math.round((curTime + dur) * timeScaleFactor);
      curTime += dur;

      const sz = sampleSizes[i];
      const off = sampleOffsets[i];
      if (sz > 2 && off > 0) {
        const sampleBytes = await readFileSlice(file, off, sz);
        let rawText = '';
        if (codec === 'tx3g' && sampleBytes.length >= 2) {
          const textLen = (sampleBytes[0] << 8) | sampleBytes[1];
          if (textLen > 0 && textLen <= sampleBytes.length - 2) {
            rawText = new TextDecoder('utf-8').decode(sampleBytes.subarray(2, 2 + textLen));
          }
        } else {
          rawText = new TextDecoder('utf-8').decode(sampleBytes);
        }

        const text = cleanSubtitleText(rawText);
        if (text) {
          cues.push({ start: startMs, end: endMs, text });
        }
      }
    }

    subtitleTracks.push({
      trackNumber: subtitleTracks.length + 1,
      name: `Track ${subtitleTracks.length + 1}`,
      language: lang,
      codec,
      default: subtitleTracks.length === 0,
      cues,
    });
  }

  return { subtitleTracks, audioTracks };
}

// ---------------------------------------------------------------------------
// Unified Media Track Discovery (Subtitles + Audio)
// ---------------------------------------------------------------------------

export async function detectMediaTracks(file) {
  if (!file) return { subtitles: [], audio: [] };

  try {
    const mkv = await extractMatroskaMediaTracks(file);
    if (mkv) {
      const subtitles = (mkv.subtitleTracks || []).map((t, idx) => {
        const langDisplay = t.language && t.language !== 'und' ? `[${t.language.toUpperCase()}]` : '';
        const nameDisplay = t.name ? t.name : `Track ${idx + 1}`;
        const label = `${nameDisplay} ${langDisplay}`.trim();
        return {
          id: `embedded-${t.trackNumber || idx + 1}`,
          type: 'embedded',
          label: label || `Track ${idx + 1}`,
          language: t.language || 'und',
          codec: t.codec || '',
          cues: t.cues || [],
        };
      });

      const audio = (mkv.audioTracks || []).map((a, idx) => {
        const langDisplay = a.language && a.language !== 'und' ? `[${a.language.toUpperCase()}]` : '';
        const nameDisplay = a.name ? a.name : `Audio ${idx + 1}`;
        const label = `${nameDisplay} ${langDisplay}`.trim();
        return {
          id: `audio-${a.trackNumber || idx + 1}`,
          index: idx,
          label: label || `Audio ${idx + 1}`,
          language: a.language || 'und',
          codec: a.codec || '',
        };
      });

      return { subtitles, audio };
    }

    const mp4 = await extractMp4MediaTracks(file);
    if (mp4) {
      const subtitles = (mp4.subtitleTracks || []).map((t, idx) => {
        const langDisplay = t.language && t.language !== 'und' ? `[${t.language.toUpperCase()}]` : '';
        const nameDisplay = t.name ? t.name : `Track ${idx + 1}`;
        const label = `${nameDisplay} ${langDisplay}`.trim();
        return {
          id: `embedded-${idx + 1}`,
          type: 'embedded',
          label: label || `Track ${idx + 1}`,
          language: t.language || 'und',
          codec: t.codec || '',
          cues: t.cues || [],
        };
      });

      const audio = (mp4.audioTracks || []).map((a, idx) => {
        const langDisplay = a.language && a.language !== 'und' ? `[${a.language.toUpperCase()}]` : '';
        const nameDisplay = a.name ? a.name : `Audio ${idx + 1}`;
        const label = `${nameDisplay} ${langDisplay}`.trim();
        return {
          id: `audio-${idx + 1}`,
          index: idx,
          label: label || `Audio ${idx + 1}`,
          language: a.language || 'und',
          codec: a.codec || '',
        };
      });

      return { subtitles, audio };
    }
  } catch (err) {
    console.warn('Media track extraction error:', err);
  }

  return { subtitles: [], audio: [] };
}

export async function detectEmbeddedSubtitles(file) {
  const res = await detectMediaTracks(file);
  return res.subtitles || [];
}

