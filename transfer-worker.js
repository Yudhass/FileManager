// transfer-worker.js - Worker Thread untuk copy 1 file dengan Stream (sesuai PRD)
// Optimasi: highWaterMark 4MB, IPC throttling, pipeline anti memory-leak.
// Mendukung pause / resume / cancel dari main thread.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

async function executeCopy() {
  const { source, destination } = workerData;

  try {
    const stat = fs.statSync(source);
    const totalSize = stat.size;

    // File kosong: langsung buat file kosong di tujuan
    if (totalSize === 0) {
      fs.closeSync(fs.openSync(destination, 'w'));
      parentPort.postMessage({ status: 'progress', progress: 100, copied: 0, total: 0, delta: 0 });
      parentPort.postMessage({ status: 'done', copied: 0 });
      return;
    }

    let copiedSize = 0;
    let lastReportedProgress = -1;
    let lastReportTime = 0;
    let paused = false;
    let cancelled = false;

    // Optimasi PRD: buffer 4MB per chunk (default Node 64KB terlalu kecil untuk SSD/NVMe)
    const CHUNK_SIZE = 4 * 1024 * 1024;

    const readStream = fs.createReadStream(source, { highWaterMark: CHUNK_SIZE });
    const writeStream = fs.createWriteStream(destination);

    parentPort.on('message', (msg) => {
      if (!msg || !msg.cmd) return;
      if (msg.cmd === 'pause') {
        paused = true;
        try { readStream.pause(); } catch (_) {}
      } else if (msg.cmd === 'resume') {
        paused = false;
        try { readStream.resume(); } catch (_) {}
      } else if (msg.cmd === 'cancel') {
        cancelled = true;
        try { readStream.destroy(new Error('CANCELLED_BY_USER')); } catch (_) {}
        try { writeStream.destroy(); } catch (_) {}
      }
    });

    readStream.on('error', () => {});
    writeStream.on('error', () => {});

    const progressTracker = new Transform({
      transform(chunk, encoding, callback) {
        if (cancelled) {
          callback(new Error('CANCELLED_BY_USER'));
          return;
        }
        // Saat pause, tahan chunk sampai resume (backpressure manual)
        if (paused) {
          const wait = () => {
            if (cancelled) return callback(new Error('CANCELLED_BY_USER'));
            if (!paused) return callback(null, chunk);
            setTimeout(wait, 50);
          };
          // tetap hitung setelah resume agar byte akurat
          const origCb = callback;
          setTimeout(function check() {
            if (cancelled) return origCb(new Error('CANCELLED_BY_USER'));
            if (!paused) {
              copiedSize += chunk.length;
              report(chunk.length);
              origCb(null, chunk);
            } else {
              setTimeout(check, 50);
            }
          }, 0);
          return;
        }
        copiedSize += chunk.length;
        report(chunk.length);
        callback(null, chunk);
      }
    });

    function report(delta) {
      const progress = Math.floor((copiedSize / totalSize) * 100);
      const now = Date.now();
      // IPC Throttling (PRD): kirim hanya jika % berubah ATAU >200ms sejak laporan terakhir
      if (progress > lastReportedProgress || (now - lastReportTime > 200 && delta > 0)) {
        parentPort.postMessage({
          status: 'progress',
          progress,
          copied: copiedSize,
          total: totalSize,
          delta
        });
        lastReportedProgress = progress;
        lastReportTime = now;
      }
    }

    await pipeline(readStream, progressTracker, writeStream);

    if (cancelled) {
      parentPort.postMessage({ status: 'error', message: 'CANCELLED_BY_USER' });
      return;
    }

    // Pertahankan timestamp sumber (opsional, best-effort)
    try {
      fs.utimesSync(destination, stat.atime, stat.mtime);
    } catch (_) {}

    parentPort.postMessage({ status: 'done', copied: copiedSize });
  } catch (error) {
    // Jika cancel, bersihkan file parsial
    try {
      if (error && error.message === 'CANCELLED_BY_USER') {
        try { fs.unlinkSync(workerData.destination); } catch (_) {}
      }
    } catch (_) {}
    parentPort.postMessage({ status: 'error', message: (error && error.message) || 'Unknown error' });
  }
}

executeCopy();
