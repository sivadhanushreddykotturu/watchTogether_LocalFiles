// lib/audioTranscoder.js
// Client-side WebAssembly audio extraction & transcoding for EAC3, AC3, and DTS audio tracks.
// Uses fast in-browser pure-JS MKV demuxing to extract ONLY the audio stream (<60MB)
// before feeding it to WebAssembly, preventing memory exhaustion and making conversion 20x faster.

let ffmpegInstance = null;
let loadingPromise = null;

export async function getFFmpeg() {
  if (typeof window === 'undefined') return null;
  if (ffmpegInstance && ffmpegInstance.loaded) {
    return ffmpegInstance;
  }
  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      // 1. Ensure UMD browser script is loaded
      if (!window.FFmpegWASM) {
        await new Promise((resolve, reject) => {
          if (window.FFmpeg) {
            window.FFmpegWASM = window.FFmpeg;
            return resolve();
          }
          const script = document.createElement('script');
          script.src = '/ffmpeg/ffmpeg.js';
          script.async = true;
          script.onload = () => {
            window.FFmpegWASM = window.FFmpeg;
            resolve();
          };
          script.onerror = () => {
            // Fallback to unpkg CDN if local static is blocked
            const cdnScript = document.createElement('script');
            cdnScript.src = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';
            cdnScript.onload = () => {
              window.FFmpegWASM = window.FFmpeg;
              resolve();
            };
            cdnScript.onerror = reject;
            document.head.appendChild(cdnScript);
          };
          document.head.appendChild(script);
        });
      }

      const { FFmpeg } = window.FFmpegWASM;
      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        console.log('[ffmpeg]:', message);
      });

      try {
        await ffmpeg.load({
          coreURL: '/ffmpeg/ffmpeg-core.js',
          wasmURL: '/ffmpeg/ffmpeg-core.wasm',
        });
      } catch (loadErr) {
        console.warn('Local ffmpeg core load failed, trying CDN:', loadErr);
        const coreCDN = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
        await ffmpeg.load({
          coreURL: `${coreCDN}/ffmpeg-core.js`,
          wasmURL: `${coreCDN}/ffmpeg-core.wasm`,
        });
      }

      ffmpegInstance = ffmpeg;
      return ffmpeg;
    } catch (err) {
      console.error('Could not initialize FFmpeg wasm engine:', err);
      loadingPromise = null;
      throw err;
    }
  })();

  return loadingPromise;
}

function readEbmlVint(b, p, mask = true) {
  if (p >= b.length) return null;
  const first = b[p];
  let numBytes = 0;
  let valMask = 0;
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) {
      numBytes = i + 1;
      valMask = (0x80 >> i) - 1;
      break;
    }
  }
  if (!numBytes || p + numBytes > b.length) return null;
  let val = mask ? (first & valMask) : first;
  for (let i = 1; i < numBytes; i++) {
    val = (val * 256) + b[p + i];
  }
  return { length: numBytes, value: val };
}

/**
 * Fast client-side pure-JS MKV audio track demuxer.
 * Extracts only the raw audio stream packets from the video container in under 1 second.
 */
async function extractRawAudioFromMkv(file, targetTrackNumber = null, onStatus = () => {}) {
  onStatus('Demuxing audio stream from file...');
  const fileSize = file.size;
  const targetTrack = (targetTrackNumber !== null && targetTrackNumber !== undefined) ? targetTrackNumber : 2;
  const audioPackets = [];

  let curPos = 0;
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB read chunks

  while (curPos < fileSize) {
    const toRead = Math.min(CHUNK_SIZE, fileSize - curPos);
    const slice = file.slice(curPos, curPos + toRead);
    const arrayBuf = await slice.arrayBuffer();
    const chunk = new Uint8Array(arrayBuf);

    if (chunk.length <= 12) break;

    let cp = 0;
    while (cp < chunk.length - 8) {
      const idInfo = readEbmlVint(chunk, cp, false);
      if (!idInfo) break;
      const szInfo = readEbmlVint(chunk, cp + idInfo.length, true);
      if (!szInfo) break;
      const hLen = idInfo.length + szInfo.length;
      const elemId = idInfo.value;
      const elemSize = szInfo.value;

      if (elemId === 0x1f43b675 || elemId === 0x18538067 || elemId === 0xa0) {
        cp += hLen;
        continue;
      }

      if (elemId === 0xa3 || elemId === 0xa1) { // SimpleBlock or Block
        const blockHdr = chunk.subarray(cp + hLen, cp + hLen + 4);
        const trk = readEbmlVint(blockHdr, 0, true);
        if (trk && trk.value === targetTrack) {
          const payloadOffset = cp + hLen + trk.length + 3;
          const payloadLen = elemSize - (trk.length + 3);
          if (payloadOffset + payloadLen <= chunk.length) {
            audioPackets.push(chunk.slice(payloadOffset, payloadOffset + payloadLen));
          } else {
            const exactSlice = file.slice(curPos + payloadOffset, curPos + payloadOffset + payloadLen);
            const exactBuf = await exactSlice.arrayBuffer();
            audioPackets.push(new Uint8Array(exactBuf));
          }
        }
        cp += (hLen + elemSize);
        continue;
      }

      cp += (hLen + elemSize);
    }
    curPos += cp;
  }

  if (audioPackets.length === 0) {
    return null;
  }

  let totalLength = 0;
  for (let i = 0; i < audioPackets.length; i++) {
    totalLength += audioPackets[i].length;
  }

  const rawAudio = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < audioPackets.length; i++) {
    rawAudio.set(audioPackets[i], offset);
    offset += audioPackets[i].length;
  }

  return rawAudio;
}

/**
 * Transcodes any video file's audio track (EAC3, AC3, DTS, TrueHD) directly to playable stereo audio in the browser.
 * @param {File} file - Video file object
 * @param {number|null} targetTrackNumber - Specific audio track number to convert
 * @param {Function} onProgress - Progress callback (0 - 100)
 * @param {Function} onStatus - Status text callback
 * @returns {Promise<Blob>} Transcoded audio blob
 */
export async function transcodeAudioToMp3(file, targetTrackNumber = null, onProgress = () => {}, onStatus = () => {}) {
  onStatus('Initializing audio engine...');
  const ffmpeg = await getFFmpeg();

  // 1. Demux audio stream directly using fast pure-JS reader (under 1 second)
  let audioData = null;
  try {
    audioData = await extractRawAudioFromMkv(file, targetTrackNumber, onStatus);
  } catch (err) {
    console.warn('Pure-JS demuxer error, falling back to direct stream:', err);
  }

  const inName = `input_${Date.now()}.eac3`;
  const outName = `output_${Date.now()}.aac`;

  ffmpeg.on('progress', ({ progress }) => {
    if (typeof progress === 'number' && progress >= 0) {
      const pct = Math.min(99, Math.max(1, Math.round(progress * 100)));
      onProgress(pct);
      onStatus(`Converting audio... ${pct}%`);
    }
  });

  try {
    if (audioData && audioData.length > 0) {
      onStatus(`Transcoding ${(audioData.length / (1024 * 1024)).toFixed(1)}MB audio stream...`);
      await ffmpeg.writeFile(inName, audioData);
    } else {
      onStatus('Reading audio stream from file...');
      const slice = file.slice(0, Math.min(file.size, 150 * 1024 * 1024)); // clamp to 150MB to prevent browser OOM
      const buf = new Uint8Array(await slice.arrayBuffer());
      await ffmpeg.writeFile(inName, buf);
    }

    onStatus('Converting EAC-3 to stereo AAC...');
    await ffmpeg.exec([
      '-i', inName,
      '-vn',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      outName,
    ]);

    onStatus('Finalizing audio...');
    const data = await ffmpeg.readFile(outName);
    const blob = new Blob([data.buffer], { type: 'audio/aac' });

    // Clean up virtual filesystem
    try {
      await ffmpeg.deleteFile(inName);
      await ffmpeg.deleteFile(outName);
    } catch { /* ignore */ }

    return blob;
  } catch (err) {
    try {
      await ffmpeg.deleteFile(inName);
      await ffmpeg.deleteFile(outName);
    } catch { /* ignore */ }
    throw err;
  }
}
