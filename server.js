// server.js - Main Thread: HTTP server + Dual-Pane API + Job/Queue Engine
// Sesuai PRD: navigasi independen, copy/move rekursif, antrean, pause/resume/cancel,
// conflict handling, smart transfer (sekuensial file besar, konkuren file kecil),
// streams 4MB + worker_threads agar UI tidak freeze.
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4821;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Worker harus file fisik (tidak bisa dari dalam app.asar) -> di-build config
// transfer-worker.js di-unpack, dan di sini fallback ke lokasi unpacked.
function getWorkerPath() {
  const inside = path.join(__dirname, 'transfer-worker.js');
  if (fs.existsSync(inside)) return inside;
  const unpacked = inside.replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) return unpacked;
  return inside;
}

const LARGE_FILE = 100 * 1024 * 1024; // >100MB : sekuensial (PRD)
const SMALL_FILE = 5 * 1024 * 1024;   // <5MB   : konkuren 10-20 (PRD)
const CONCURRENCY_SMALL = 12;
const CONCURRENCY_MEDIUM = 4;

// ---------------- slot global file besar ----------------
// Hanya 1 file besar (>100MB) yang boleh disalin dalam satu waktu di SELURUH
// job. Tanpa ini, 2 job yang masing-masing menyalin file raksasa akan
// berebut disk (thrashing) dan keduanya terlihat berhenti.
// File kecil/sedang tidak dibatasi (tetap paralel antar job).
const largeSlot = { busyBy: null, waiters: [] }; // waiters: [jobId] untuk info antrean

// Tunggu giliran slot; batal ikut membatalkan penantian (tidak menggantung).
function acquireLargeSlot(job) {
  return new Promise((resolve, reject) => {
    const tryTake = () => {
      if (job.cancelled) {
        dropLargeSlotWaiter(job.id);
        return reject(new Error('CANCELLED_BY_USER'));
      }
      if (!largeSlot.busyBy) {
        largeSlot.busyBy = job.id;
        // Hapus dari daftar tunggu SAJA (jangan sentuh busyBy yang baru dipegang!)
        largeSlot.waiters = largeSlot.waiters.filter((id) => id !== job.id);
        return resolve();
      }
      if (!largeSlot.waiters.includes(job.id)) largeSlot.waiters.push(job.id);
      setTimeout(tryTake, 120);
    };
    tryTake();
  });
}

function releaseLargeSlot(job) {
  if (largeSlot.busyBy === job.id) largeSlot.busyBy = null;
  dropLargeSlotWaiter(job.id);
}

// Dipanggil saat job batal/selesai: keluarkan dari antrean slot bila masih menunggu
function dropLargeSlotWaiter(jobId) {
  largeSlot.waiters = largeSlot.waiters.filter((id) => id !== jobId);
  if (largeSlot.busyBy === jobId) largeSlot.busyBy = null;
}

// ---------------- util ----------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function sendText(res, code, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': contentType });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  // Izinkan absolute path lokal. Kembalikan path ternormalisasi.
  const n = path.normalize(p);
  return n;
}

function formatBytes(b) {
  if (b === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
}

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

function uniqueDestName(destPath) {
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  let i = 1;
  let candidate = path.join(dir, `${base} (copy ${i})${ext}`);
  while (fs.existsSync(candidate)) {
    i++;
    candidate = path.join(dir, `${base} (copy ${i})${ext}`);
  }
  return candidate;
}

// ---------------- drives & listing ----------------
async function getDrives() {
  if (process.platform === 'win32') {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      try { await fsp.access(d); drives.push(d); } catch (_) {}
    }
    return drives.length ? drives : [os.homedir()];
  }
  // linux/mac: root + home
  return ['/', os.homedir()];
}

async function listDir(dirPath) {
  const dir = normalizePath(dirPath);
  if (!dir) throw new Error('Path tidak valid');
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let stat = null;
    try { stat = await fsp.stat(full); } catch { continue; }
    out.push({
      name: e.name,
      path: full,
      isDir: stat.isDirectory(),
      size: stat.isDirectory() ? 0 : stat.size,
      sizeText: stat.isDirectory() ? '-' : formatBytes(stat.size),
      mtime: stat.mtimeMs,
      mtimeText: new Date(stat.mtimeMs).toLocaleString('id-ID'),
      ext: stat.isDirectory() ? 'Folder' : (path.extname(e.name).slice(1).toUpperCase() || 'File')
    });
  }
  // Folder dulu, lalu nama A-Z
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'id');
  });
  // Hitung ukuran folder? (berat) -> biarkan 0, frontend tidak butuh presisi per-baris.
  return { path: dir, parent: path.dirname(dir), entries: out };
}

// ---------------- expand rekursif ----------------
// Mengembalikan GRUP per sumber top-level agar transfer bisa diselesaikan
// per folder (bukan dioplos semua): [{ label, isDir, dirs, files }]
async function expandSources(sources, destDir, job) {
  const groups = [];

  async function walk(src, dst, acc) {
    if (job && job.cancelled) throw new Error('CANCELLED_BY_USER');
    // Progres scanning agar job 0/0 tidak terlihat mati (tampil di currentFile)
    if (job) {
      job.scannedFiles = (job.scannedFiles || 0) + 1;
      if (job.scannedFiles % 50 === 0 || (acc && acc.files.length + acc.dirs.length < 3)) job.currentFile = '🔍 Memindai: ' + src;
    }
    const stat = await fsp.stat(src);
    if (stat.isDirectory()) {
      acc.dirs.push(dst);
      const children = await fsp.readdir(src);
      for (const c of children) {
        await walk(path.join(src, c), path.join(dst, c), acc);
      }
    } else if (stat.isFile()) {
      acc.files.push({ source: src, dest: dst, size: stat.size });
    }
  }

  for (const src of sources) {
    const base = path.basename(src);
    const dst = path.join(destDir, base);
    const acc = { label: base, isDir: false, dirs: [], files: [] };
    try {
      const st = await fsp.stat(src);
      acc.isDir = st.isDirectory();
    } catch (_) {}
    await walk(src, dst, acc);
    groups.push(acc);
  }
  return groups;
}

// Buang sumber yang berada di dalam sumber lain (mis. folder + anaknya
// dicentang bersamaan) agar tidak tercopy ganda / konflik dengan diri sendiri.
function dedupeNestedSources(sources) {
  const norm = sources.map((s) => normalizePath(s)).filter(Boolean);
  // Yang pendek dulu (induk sebelum anak)
  norm.sort((a, b) => a.length - b.length);
  const kept = [];
  for (const s of norm) {
    const inside = kept.some((k) => s === k || s.startsWith(k + path.sep));
    if (!inside) kept.push(s);
  }
  return kept;
}

// ---------------- copy 1 file via worker ----------------
// Anti-stuck: promise SELALU settle (done/error/exit-timeout/watchdog).
// Jika worker keluar diam-diam atau macet tanpa progres, file gagal
// dengan pesan jelas — job TIDAK PERNAH menggantung selamanya.
const STALL_TIMEOUT_MS = 120 * 1000; // 120 dtk tanpa progres = macet

function copyOneFile(source, dest, job, onDelta) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastProgressAt = Date.now();
    const worker = new Worker(getWorkerPath(), { workerData: { source, destination: dest } });
    job.workers.add(worker);
    // Teruskan perintah pause/resume yang tertunda ke worker baru
    if (job.paused) worker.postMessage({ cmd: 'pause' });

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(exitTimer);
      job.workers.delete(worker);
      // Cabut hook cancel milik worker ini (sudah selesai, jangan dipanggil lagi)
      const hi = job.cancelHooks.indexOf(cancelHook);
      if (hi >= 0) job.cancelHooks.splice(hi, 1);
      worker.terminate().catch(() => {});
      fn(val);
    };

    // Watchdog: tidak ada pesan progress/worker macet -> bunuh & gagalkan file ini
    const watchdog = setInterval(() => {
      if (settled || job.paused) { lastProgressAt = Date.now(); return; }
      if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        try { worker.terminate(); } catch (_) {}
        finish(reject, new Error(`Macet saat memproses: ${source} (tidak ada progres 120 dtk)`));
      }
    }, 5000);

    // Pengaman exit: worker keluar tanpa pesan done/error (crash/OOM)
    // TIDAK BOLEH menggantung — langsung reject agar job gagal dengan pesan jelas.
    let exitTimer = null;
    const armExitTimer = () => {
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => {
        finish(reject, new Error(`Worker berhenti tanpa kabar saat memproses: ${source}`));
      }, 15000);
    };

    worker.on('message', (msg) => {
      lastProgressAt = Date.now();
      if (msg.status === 'progress') {
        onDelta(msg.delta || 0, msg);
      } else if (msg.status === 'done') {
        finish(resolve);
      } else if (msg.status === 'error') {
        finish(reject, new Error(msg.message));
      }
    });
    worker.on('error', (err) => {
      finish(reject, err);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      if (code !== 0) {
        // Crash sebelum sempat kirim pesan -> gagalkan file, jangan gantung
        finish(reject, new Error(`Worker crash (exit ${code}) saat memproses: ${source}`));
      } else {
        // Exit 0 tanpa pesan done = anomali; beri jeda terima pesan telat, lalu gagalkan
        armExitTimer();
      }
    });
    job.cancelHooks.push(cancelHook);
    function cancelHook() { try { worker.postMessage({ cmd: 'cancel' }); } catch (_) {} }
  });
}

// ---------------- Job manager ----------------
const jobs = new Map();
let jobSeq = 0;
const activeJobs = new Set(); // beberapa job boleh jalan BERSAMAAN (paralel)
const pendingQueue = [];

function publicJob(j) {
  return {
    id: j.id,
    operation: j.operation,
    status: j.status,
    totalFiles: j.totalFiles,
    doneFiles: j.doneFiles,
    skippedFiles: j.skippedFiles,
    totalBytes: j.totalBytes,
    copiedBytes: j.copiedBytes,
    progress: j.totalBytes > 0 ? Math.floor((j.copiedBytes / j.totalBytes) * 100) : (j.doneFiles / Math.max(j.totalFiles, 1) * 100 | 0),
    speed: j.speed || 0,
    speedText: formatBytes(j.speed || 0) + '/s',
    eta: j.eta || null,
    currentFile: j.currentFile || '',
    destDir: j.destDir,
    error: j.error || null,
    conflict: j.conflict || null,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt || null
  };
}

// Tiap job transfer langsung dijalankan paralel (tidak saling antre).
// Pembatasan konkurensi tetap ada DI DALAM tiap job (smart transfer PRD:
// file besar sekuensial, file kecil pool-12) agar disk tidak thrashing parah.
function processQueue() {
  while (pendingQueue.length) {
    const id = pendingQueue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    activeJobs.add(id);
    runJob(job).finally(() => {
      activeJobs.delete(id);
    });
  }
}

async function waitIfPausedOrConflict(job) {
  while (job.paused || job.status === 'waiting-conflict') {
    if (job.cancelled) throw new Error('CANCELLED_BY_USER');
    await new Promise((r) => setTimeout(r, 120));
  }
  if (job.cancelled) throw new Error('CANCELLED_BY_USER');
}

// Antrean resolusi konflik: konflik diproses SATU-PER-SATU sesuai urutan.
// (Sebelumnya satu slot _conflictResolver bisa tertimpa konflik lain dari
// lane konkuren -> promise yatim -> lane gantung selamanya = STUCK 99%.)
function pumpConflictQueue(job) {
  if (job._resolvingConflict) return;
  // Kebijakan global ("berlaku semua") sudah dipilih user -> kuras antrean
  // otomatis TANPA dialog lagi. Ini juga yang mencegah stuck saat banyak
  // konflik menumpuk di belakang konflik yang sedang ditampilkan.
  if (job.policy) {
    const q = job.conflictQueue || [];
    job.conflictQueue = [];
    for (const item of q) { try { item.resolve(job.policy); } catch (_) {} }
    if (!job.paused && job.status === 'waiting-conflict') job.status = 'active';
    return;
  }
  const next = (job.conflictQueue || []).shift();
  if (!next) {
    if (!job.paused && job.status === 'waiting-conflict') job.status = 'active';
    return;
  }
  job._resolvingConflict = true;
  job.status = 'waiting-conflict';
  job.conflict = next.info;
  const pump = (choice, applyAll) => {
    if (job._activePump !== pump) return; // pump basi (mis. sesudah cancel) -> abaikan
    job._activePump = null;
    if (applyAll) job.policy = choice;
    job.conflict = null;
    job._resolvingConflict = false;
    next.resolve(choice);
    // Lanjut ke konflik berikutnya dalam antrean (jika ada)
    setImmediate(() => pumpConflictQueue(job));
  };
  job._activePump = pump;
}

function resolveConflictFor(job, file, dstStat) {
  return new Promise((resolve) => {
    // Kebijakan global sudah ditentukan?
    if (job.policy === 'overwrite') return resolve('overwrite');
    if (job.policy === 'skip') return resolve('skip');
    if (job.policy === 'rename') return resolve('rename');
    // Minta keputusan user via frontend (polling /api/jobs/:id)
    let srcStat = null;
    try { srcStat = fs.statSync(file.source); } catch (_) {}
    job.conflictQueue = job.conflictQueue || [];
    job.conflictQueue.push({
      info: {
        source: file.source,
        dest: file.dest,
        srcSize: file.size,
        srcSizeText: formatBytes(file.size),
        srcMtime: srcStat ? new Date(srcStat.mtimeMs).toLocaleString('id-ID') : '-',
        dstSize: dstStat ? dstStat.size : 0,
        dstSizeText: dstStat ? formatBytes(dstStat.size) : '-',
        dstMtime: dstStat ? new Date(dstStat.mtimeMs).toLocaleString('id-ID') : '-'
      },
      resolve
    });
    pumpConflictQueue(job);
  });
}

// Kuras antrean konflik (dipakai saat cancel): semua penunggu dilepas sebagai 'skip'
function drainConflictQueue(job, choice = 'skip') {
  const waiting = job.conflictQueue || [];
  job.conflictQueue = [];
  // Panggil pump aktif DULU selagi slotnya masih valid, baru bersihkan sisanya
  const active = job._activePump;
  if (active) {
    try { active(choice, false); } catch (_) {}
  }
  job._activePump = null;
  job._resolvingConflict = false;
  job.conflict = null;
  for (const item of waiting) {
    try { item.resolve(choice); } catch (_) {}
  }
}

async function copyFileTask(job, file) {
  await waitIfPausedOrConflict(job);
  if (job.cancelled) throw new Error('CANCELLED_BY_USER');

  // Pastikan folder tujuan ada
  await fsp.mkdir(path.dirname(file.dest), { recursive: true });

  // Conflict handling
  let dest = file.dest;
  let exists = await pathExists(dest);
  if (exists) {
    let dstStat = null;
    try { dstStat = await fsp.stat(dest); } catch (_) {}
    const isSameFile = dstStat && !dstStat.isDirectory();
    if (isSameFile) {
      const choice = await resolveConflictFor(job, file, dstStat);
      if (job.cancelled) throw new Error('CANCELLED_BY_USER');
      if (choice === 'skip') {
        job.skippedFiles++;
        job.doneFiles++;
        // Byte yang di-skip tetap dihitung agar progress tidak macet
        job.copiedBytes += file.size;
        return;
      } else if (choice === 'rename') {
        dest = uniqueDestName(dest);
        file.dest = dest;
      } else {
        // overwrite: hapus tujuan dulu (terutama jika read-only)
        try { await fsp.unlink(dest); } catch (_) {}
        try { await fsp.rm(dest, { recursive: true, force: true }); } catch (_) {}
      }
    } else {
      // Tujuan adalah folder sedangkan sumber file (atau sebaliknya) -> rename otomatis
      dest = uniqueDestName(dest);
      file.dest = dest;
    }
  }

  await waitIfPausedOrConflict(job);
  job.currentFile = file.source;
  broadcastTick(job);

  // File besar: wajib pegang slot global dulu (gantian antar job, cegah thrashing)
  const needsSlot = file.size > LARGE_FILE;
  if (needsSlot) {
    job.currentFile = '⏳ Menunggu giliran disk: ' + file.source;
    await acquireLargeSlot(job);
    if (job.cancelled) { releaseLargeSlot(job); throw new Error('CANCELLED_BY_USER'); }
    job.currentFile = file.source;
  }
  try {
    // Coba-otomatis: glitch sesaat (kabel goyang, drive tidur) sembuh sendiri
    // tanpa menggagalkan seluruh job. Maks 3x percobaan dengan backoff.
    const MAX_FILE_ATTEMPTS = 3;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        await copyOneFile(file.source, dest, job, (delta) => {
          job.copiedBytes += delta;
          job._tickBytes += delta;
        });
        break; // sukses
      } catch (e) {
        if (e.message === 'CANCELLED_BY_USER' || job.cancelled) throw e;
        if (attempt >= MAX_FILE_ATTEMPTS) {
          throw new Error(`Gagal ${attempt}x menyalin "${file.source}" — ${friendlyReason(e)}`);
        }
        job.currentFile = `↻ Mencoba lagi (${attempt + 1}/${MAX_FILE_ATTEMPTS}): ` + file.source;
        await sleepAbortable(job, attempt * 2000); // jeda 2 dtk, 4 dtk, ...
      }
    }
  } finally {
    if (needsSlot) releaseLargeSlot(job);
  }

  // Move: hapus sumber setelah copy sukses
  if (job.operation === 'move') {
    try { await fsp.unlink(file.source); } catch (_) {}
  }
  job.doneFiles++;
}

// Pesan error ramah untuk kegagalan baca/tulis (mis. penyimpanan terputus)
function friendlyReason(e) {
  const msg = (e && e.message) || String(e);
  const code = (e && e.code) || '';
  if (/CANCELLED_BY_USER/.test(msg)) return msg;
  if (code === 'ENOENT' || /no such file/i.test(msg)) return 'file sumber hilang/tidak terbaca (penyimpanan terputus?)';
  if (code === 'EIO' || /unknown error, read|unknown error, write/i.test(msg)) return 'perangkat tidak merespons (kabel/drive terputus?)';
  if (code === 'ENOSPC') return 'ruang disk tujuan penuh';
  if (code === 'EPERM' || code === 'EACCES') return 'akses ditolak (izin/lock?)';
  if (code === 'EBUSY') return 'file sedang dipakai aplikasi lain';
  return msg;
}

function sleepAbortable(job, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (job.cancelled) return reject(new Error('CANCELLED_BY_USER'));
      if (Date.now() - t0 >= ms) return resolve();
      setTimeout(tick, 150);
    };
    tick();
  });
}
async function runPool(job, fileList, concurrency) {
  let idx = 0;
  let failed = null;
  const workers = [];
  async function lane() {
    while (idx < fileList.length) {
      if (job.cancelled) throw new Error('CANCELLED_BY_USER');
      if (failed) return;
      const i = idx++;
      try {
        await copyFileTask(job, fileList[i]);
      } catch (e) {
        if (e.message === 'CANCELLED_BY_USER') throw e;
        failed = failed || e;
        // Lanjut file lain? Tidak — hentikan pool agar error terlihat jelas.
        throw e;
      }
    }
  }
  const lanes = [];
  for (let k = 0; k < Math.min(concurrency, fileList.length); k++) lanes.push(lane());
  await Promise.all(lanes);
}

function broadcastTick(job) {
  // Dipanggil tiap update penting; speed dihitung oleh ticker interval
}

async function runJob(job) {
  job.status = 'scanning';
  job.startedAt = Date.now();
  job._tickBytes = 0;
  job.speed = 0;

  // Ticker kecepatan + ETA
  job._ticker = setInterval(() => {
    const bytes = job._tickBytes || 0;
    job._tickBytes = 0;
    job.speed = bytes * 2; // interval 500ms -> x2 = per detik
    const remain = Math.max(job.totalBytes - job.copiedBytes, 0);
    job.eta = job.speed > 0 ? Math.ceil(remain / job.speed) : null;
  }, 500);

  try {
    // 1. Expand rekursif per sumber + hitung total
    const groups = await expandSources(job.sources, job.destDir, job);
    if (job.cancelled) throw new Error('CANCELLED_BY_USER');
    const allFiles = groups.flatMap((g) => g.files);
    job.totalFiles = allFiles.length;
    job.totalBytes = allFiles.reduce((a, f) => a + f.size, 0);

    // Buat struktur folder di tujuan
    for (const g of groups) {
      for (const d of g.dirs) {
        if (job.cancelled) throw new Error('CANCELLED_BY_USER');
        if (await pathExists(d)) {
          const st = await fsp.stat(d).catch(() => null);
          if (st && !st.isDirectory()) {
            const nd = uniqueDestName(d);
            await fsp.mkdir(nd, { recursive: true });
          } else {
            await fsp.mkdir(d, { recursive: true });
          }
        } else {
          await fsp.mkdir(d, { recursive: true });
        }
      }
    }

    if (allFiles.length === 0) {
      job.status = 'done';
      job.finishedAt = Date.now();
      // Move folder kosong: hapus sumber
      if (job.operation === 'move') {
        for (const s of job.sources) {
          try {
            const st = await fsp.stat(s);
            if (st.isDirectory()) await fsp.rm(s, { recursive: true, force: true });
          } catch (_) {}
        }
      }
      clearInterval(job._ticker);
      return;
    }

    job.status = 'active';

    // 2. Urutan pengerjaan: file lepas dulu, lalu tiap folder satu-per-satu
    // sampai tuntas. Di dalam tiap grup tetap smart transfer (PRD):
    // file besar sekuensial, file kecil konkuren.
    const transferFileList = async (files) => {
      const large = files.filter((f) => f.size > LARGE_FILE);
      const small = files.filter((f) => f.size < SMALL_FILE);
      const medium = files.filter((f) => f.size >= SMALL_FILE && f.size <= LARGE_FILE);
      // File besar satu-per-satu (maksimal throughput disk, cegah thrashing)
      for (const f of large) {
        await copyFileTask(job, f);
      }
      // File sedang: konkurensi 4
      if (medium.length) await runPool(job, medium, CONCURRENCY_MEDIUM);
      // File kecil: konkurensi 12 (atasi overhead metadata)
      if (small.length) await runPool(job, small, CONCURRENCY_SMALL);
    };

    const looseFiles = groups.filter((g) => !g.isDir).flatMap((g) => g.files);
    const folderGroups = groups.filter((g) => g.isDir);
    if (looseFiles.length) await transferFileList(looseFiles);
    for (const g of folderGroups) {
      if (job.cancelled) throw new Error('CANCELLED_BY_USER');
      job.currentFile = `📁 ${g.label}`;
      if (g.files.length) await transferFileList(g.files);
    }

    if (job.cancelled) throw new Error('CANCELLED_BY_USER');

    // Move: bersihkan folder sumber yang sudah kosong
    if (job.operation === 'move') {
      for (const s of job.sources) {
        try {
          const st = await fsp.stat(s).catch(() => null);
          if (st && st.isDirectory()) {
            // hanya hapus jika kosong (hindari hapus file yang di-skip)
            const rest = await fsp.readdir(s).catch(() => null);
            if (rest && rest.length === 0) await fsp.rmdir(s).catch(() => {});
            else if (rest) {
              // coba hapus rekursif sisa yang memang sudah tercopy semua
              if (job.skippedFiles === 0) await fsp.rm(s, { recursive: true, force: true }).catch(() => {});
            }
          }
        } catch (_) {}
      }
    }

    job.status = 'done';
    job.finishedAt = Date.now();
    job.copiedBytes = job.totalBytes;
    job.currentFile = '';
  } catch (e) {
    if (e.message === 'CANCELLED_BY_USER' || job.cancelled) {
      job.status = 'cancelled';
      job.error = 'Dibatalkan pengguna';
      // Hentikan semua worker aktif
      for (const h of job.cancelHooks.splice(0)) { try { h(); } catch (_) {} }
      for (const w of [...job.workers]) { try { w.terminate(); } catch (_) {} }
    } else {
      job.status = 'error';
      job.error = e.message;
    }
    job.finishedAt = Date.now();
  } finally {
    clearInterval(job._ticker);
    job.workers.clear();
    job.conflict = null;
    releaseLargeSlot(job); // pengaman: jangan biarkan slot nyangkut di job ini
  }
}

// ---------------- HTTP server ----------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // ---- API ----
    if (url.pathname === '/api/drives' && req.method === 'GET') {
      const drives = await getDrives();
      return sendJson(res, 200, { drives, home: os.homedir() });
    }

    if (url.pathname === '/api/list' && req.method === 'GET') {
      const p = url.searchParams.get('path') || os.homedir();
      try {
        const data = await listDir(p);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (url.pathname === '/api/mkdir' && req.method === 'POST') {
      const body = await readBody(req);
      const p = normalizePath(body.path);
      if (!p) return sendJson(res, 400, { error: 'Path tidak valid' });
      try {
        await fsp.mkdir(p, { recursive: true });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (url.pathname === '/api/rename' && req.method === 'POST') {
      const body = await readBody(req);
      const from = normalizePath(body.from);
      const to = normalizePath(body.to);
      if (!from || !to) return sendJson(res, 400, { error: 'Path tidak valid' });
      try {
        await fsp.rename(from, to);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (url.pathname === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      let ok = 0;
      const errors = [];
      for (const p of paths) {
        try { await fsp.rm(p, { recursive: true, force: true }); ok++; }
        catch (e) { errors.push(`${p}: ${e.message}`); }
      }
      return sendJson(res, 200, { ok, errors });
    }

    if (url.pathname === '/api/transfer' && req.method === 'POST') {
      const body = await readBody(req);
      const { operation, sources, destDir } = body;
      if (!['copy', 'move'].includes(operation)) return sendJson(res, 400, { error: 'operation harus copy/move' });
      if (!Array.isArray(sources) || !sources.length) return sendJson(res, 400, { error: 'Pilih dulu file/folder sumber' });
      const dest = normalizePath(destDir);
      if (!dest) return sendJson(res, 400, { error: 'Folder tujuan tidak valid' });
      try {
        const st = await fsp.stat(dest);
        if (!st.isDirectory()) return sendJson(res, 400, { error: 'Tujuan harus folder' });
      } catch {
        return sendJson(res, 400, { error: 'Folder tujuan tidak ditemukan' });
      }
      // Cegah copy folder ke dalam dirinya sendiri
      for (const s of sources) {
        const ns = normalizePath(s);
        if (dest === ns || dest.startsWith(ns + path.sep)) {
          return sendJson(res, 400, { error: 'Tidak bisa copy/move ke dalam folder itu sendiri: ' + ns });
        }
      }
      // Buang sumber yang bersarang (folder + isinya dicentang bersamaan)
      const cleanSources = dedupeNestedSources(sources);
      if (!cleanSources.length) return sendJson(res, 400, { error: 'Pilih dulu file/folder sumber' });
      const id = 'job-' + (++jobSeq);
      const job = {
        id, operation, sources: cleanSources, destDir: dest,
        status: 'queued', totalFiles: 0, doneFiles: 0, skippedFiles: 0,
        totalBytes: 0, copiedBytes: 0, speed: 0, eta: null, currentFile: '',
        error: null, conflict: null, policy: null,
        paused: false, cancelled: false,
        workers: new Set(), cancelHooks: [],
        startedAt: null, finishedAt: null
      };
      jobs.set(id, job);
      pendingQueue.push(id);
      processQueue();
      return sendJson(res, 200, { id });
    }

    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      return sendJson(res, 200, { jobs: [...jobs.values()].map(publicJob).reverse() });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(\/(pause|resume|cancel|resolve|retry))?$/);
    if (jobMatch && req.method !== 'OPTIONS') {
      const id = jobMatch[1];
      const action = jobMatch[3] || null;
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { error: 'Job tidak ditemukan' });

      if (!action && req.method === 'GET') return sendJson(res, 200, publicJob(job));

      if (action === 'pause' && req.method === 'POST') {
        job.paused = true;
        if (job.status === 'active') job.status = 'paused';
        for (const w of job.workers) { try { w.postMessage({ cmd: 'pause' }); } catch (_) {} }
        return sendJson(res, 200, publicJob(job));
      }
      if (action === 'resume' && req.method === 'POST') {
        job.paused = false;
        if (job.status === 'paused') job.status = 'active';
        for (const w of job.workers) { try { w.postMessage({ cmd: 'resume' }); } catch (_) {} }
        return sendJson(res, 200, publicJob(job));
      }
      if (action === 'cancel' && req.method === 'POST') {
        job.cancelled = true;
        job.paused = false;
        drainConflictQueue(job, 'skip');
        for (const h of job.cancelHooks.splice(0)) { try { h(); } catch (_) {} }
        for (const w of [...job.workers]) { try { w.postMessage({ cmd: 'cancel' }); } catch (_) {} }
        // Palu godam: worker yang masih hidup 3 dtk sesudah cancel -> terminate paksa.
        // Menjamin tombol Batal selalu bisa melepas job yang macet (stuck).
        setTimeout(() => {
          for (const w of [...(job.workers || [])]) { try { w.terminate(); } catch (_) {} }
        }, 3000);
        return sendJson(res, 200, publicJob(job));
      }
      if (action === 'retry' && req.method === 'POST') {
        if (!['error', 'cancelled'].includes(job.status)) {
          return sendJson(res, 400, { error: 'Hanya job yang gagal/dibatalkan yang bisa diulang' });
        }
        // Reset total -> antre ulang dari awal dengan sumber & tujuan yang sama.
        // File yang sudah tercopy akan memicu dialog konflik (Timpa/Lewati/Rename)
        // sehingga retry + "Lewati semua" ≈ lanjutkan dari yang sudah selesai.
        job.status = 'queued';
        job.totalFiles = 0; job.doneFiles = 0; job.skippedFiles = 0;
        job.totalBytes = 0; job.copiedBytes = 0; job.speed = 0; job.eta = null;
        job.currentFile = ''; job.error = null; job.conflict = null;
        job.conflictQueue = []; job._activePump = null; job._resolvingConflict = false;
        job.paused = false; job.cancelled = false; job.scannedFiles = 0;
        job._tickBytes = 0;
        job.workers.clear(); job.cancelHooks.splice(0);
        dropLargeSlotWaiter(job.id);
        pendingQueue.push(id);
        processQueue();
        return sendJson(res, 200, publicJob(job));
      }
      if (action === 'resolve' && req.method === 'POST') {
        const body = await readBody(req);
        const choice = body.action;
        if (!['overwrite', 'skip', 'rename'].includes(choice)) return sendJson(res, 400, { error: 'action harus overwrite/skip/rename' });
        if (job._activePump) {
          const p = job._activePump;
          p(choice, !!body.applyAll);
          return sendJson(res, 200, { ok: true, pending: (job.conflictQueue || []).length });
        }
        return sendJson(res, 400, { error: 'Tidak ada konflik yang menunggu' });
      }
    }

    // ---- Static ----
    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
    try {
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      const data = await fsp.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.json' ? 'application/json'
        : 'application/octet-stream';
      // Jangan cache UI di Electron/Chromium: selalu pakai versi terbaru dari disk
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
      res.end(data);
      return;
    } catch (_) {
      // fallback ke index.html untuk path tak dikenal
      if (!url.pathname.startsWith('/api/')) {
        try {
          const data = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
          return;
        } catch (_) {}
      }
      return sendText(res, 404, 'Not found');
    }
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

function startServer(port = PORT) {
  return new Promise((resolve) => {
    // Hindari double-listen saat dimuat dari Electron (main.js)
    if (server.listening) return resolve(server);
    server.listen(port, '127.0.0.1', () => {
      console.log('');
      console.log('==================================================');
      console.log('  Dual-Pane Fast File Manager berjalan!');
      console.log(`  Buka browser ke:  http://localhost:${port}`);
      console.log('  Tekan Ctrl+C untuk berhenti.');
      console.log('==================================================');
      console.log('');
      resolve(server);
    });
  });
}

module.exports = { startServer, server, acquireLargeSlot, releaseLargeSlot, largeSlot };

if (require.main === module) {
  startServer(PORT);
}
