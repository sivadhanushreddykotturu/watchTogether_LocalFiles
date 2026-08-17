// lib/audioTranscoder.js
// Client-side WebAssembly audio extraction & transcoding for EAC3, AC3, and DTS audio tracks.

let ffmpegInstance = null;
let loadingPromise = null;

export async function getFFmpeg() {
  if (ffmpegInstance && ffmpegInstance.loaded) {
    return ffmpegInstance;
  }
  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const { toBlobURL } = await import('@ffmpeg/util');

      const ffmpeg = new FFmpeg();

      const coreCDN = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
      const coreURL = await toBlobURL(`${coreCDN}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURL(`${coreCDN}/ffmpeg-core.wasm`, 'application/wasm');

      await ffmpeg.load({ coreURL, wasmURL });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    } catch (err) {
      console.warn('Could not load FFmpeg wasm:', err);
      loadingPromise = null;
      throw err;
    }
  })();

  return loadingPromise;
}

/**
 * Transcodes any video file's audio track (EAC3, AC3, DTS, TrueHD) directly to stereo MP3 in the browser.
 * @param {File} file - Video file object
 * @param {Function} onProgress - Progress callback (0 - 100)
 * @returns {Promise<Blob>} Transcoded MP3 audio blob
 */
export async function transcodeAudioToMp3(file, onProgress = () => {}) {
  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg = await getFFmpeg();

  const inName = `input_${Date.now()}.${file.name.split('.').pop() || 'mkv'}`;
  const outName = `output_${Date.now()}.mp3`;

  ffmpeg.on('progress', ({ progress }) => {
    if (typeof progress === 'number') {
      onProgress(Math.round(progress * 100));
    }
  });

  try {
    // Write input file to virtual filesystem
    await ffmpeg.writeFile(inName, await fetchFile(file));

    // Fast audio-only extraction & conversion to stereo MP3 (128k bitrate for speed and high fidelity)
    await ffmpeg.exec([
      '-i', inName,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-ac', '2',
      outName,
    ]);

    const data = await ffmpeg.readFile(outName);
    const blob = new Blob([data.buffer], { type: 'audio/mp3' });

    // Clean up virtual filesystem
    try {
      await ffmpeg.deleteFile(inName);
      await ffmpeg.deleteFile(outName);
    } catch { /* ignore cleanup errors */ }

    return blob;
  } catch (err) {
    // Clean up on error
    try {
      await ffmpeg.deleteFile(inName);
      await ffmpeg.deleteFile(outName);
    } catch { /* ignore */ }
    throw err;
  }
}
