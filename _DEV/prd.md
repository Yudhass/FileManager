Product Requirements Document (PRD): Dual-Pane Fast File Manager
1. Ringkasan Eksekutif
Aplikasi ini adalah file manager desktop berbasis Node.js (menggunakan framework seperti Electron) yang mengusung antarmuka dual-pane (panel ganda). Aplikasi ini dirancang khusus untuk mempermudah dan mempercepat proses navigasi, penyalinan (Copy), dan pemindahan (Move) data bervolume besar antar direktori atau perangkat penyimpanan, menargetkan efisiensi waktu dan penggunaan sumber daya sistem (RAM/CPU) yang minimal.

2. Tujuan Produk
Menyediakan antarmuka visual yang intuitif (Kiri = Sumber, Kanan = Tujuan) agar pengguna terhindar dari kesalahan copy-paste.

Mencapai kecepatan transfer disk yang mendekati batas maksimal hardware (native OS speed).

Menyediakan visibilitas proses transfer (kecepatan, sisa waktu, file yang sedang diproses) tanpa membuat antarmuka pengguna (UI) freeze atau lag.

3. Kebutuhan Antarmuka & Pengalaman Pengguna (UI/UX)
Split View (Dual-Pane): Layar terbagi dua secara vertikal. Masing-masing panel memiliki:

Address bar / Breadcrumbs untuk navigasi folder.

Tabel daftar file/folder (Nama, Ukuran, Tipe, Tanggal Modifikasi).

Tombol pintasan cepat ke drive lokal (C:, D:, atau mount point USB).

Action Bar (Tengah/Bawah): Tombol aksi cepat (F5: Copy, F6: Move, F8: Delete).

Transfer Queue Window: Jendela pop-up atau panel bawah yang menampilkan progres keseluruhan, progres file saat ini, kecepatan transfer (MB/s), dan estimasi waktu selesai (ETA).

4. Fitur Fungsional Utama (Core Features)
Navigasi Direktori Independen: Panel kiri dan kanan dapat menavigasi direktori sistem file lokal secara terpisah.

Operasi Copy & Move: Memindahkan atau menyalin file tunggal, banyak file, maupun direktori besar beserta isinya (rekursif).

Manajemen Antrean (Queueing): Transfer data tidak dilakukan serentak secara brutal yang membuat disk bottleneck, melainkan dimasukkan ke dalam antrean (Queue) yang dikontrol.

Pause, Resume, & Cancel: Pengguna dapat menjeda proses transfer dan melanjutkannya kembali.

Conflict Handling: Jika file di tujuan sudah ada, muncul dialog: Overwrite (Timpa), Skip (Lewati), Rename (Ubah Nama), atau Compare Size/Date.

5. Analisis & Strategi Optimasi Kecepatan (Core Engineering)
Untuk mencapai kecepatan transfer file yang efektif dan efisien di ekosistem Node.js, kita tidak bisa menggunakan fungsi standar seperti fs.readFileSync atau fs.copyFileSync secara langsung pada file besar, karena akan memblokir event loop atau memakan RAM secara berlebihan. Berikut adalah strategi optimasinya:

A. Penggunaan Node.js Streams (Piping)
Analisis: Membaca file 10GB ke dalam RAM sekaligus akan membuat aplikasi crash.

Solusi: Gunakan fs.createReadStream() dan fs.createWriteStream(). Data dipindahkan dalam bentuk "potongan kecil" (chunks) melalui metode .pipe() atau API stream.pipeline. Ini menjaga penggunaan RAM tetap stabil di bawah 50MB berapapun ukuran filenya.

B. Implementasi worker_threads (Multi-threading)
Analisis: Node.js berjalan pada satu thread utama (Single Threaded). Jika thread utama sibuk membaca disk (I/O) terus-menerus, UI aplikasi (di Electron) akan terasa lag atau freeze.

Solusi: Pindahkan seluruh logika copy/move ke Node.js worker_threads. Thread utama hanya bertugas merender UI dan menerima pesan progres (misal: "50% selesai") dari worker thread via IPC (Inter-Process Communication).

C. Manajemen Konkurensi Berdasarkan Ukuran File
Analisis: Menyalin 10.000 file kecil (1KB) satu per satu secara berurutan (sequential) sangat lambat karena overhead sistem file. Sebaliknya, menyalin 10 file besar (1GB) secara bersamaan (paralel) akan menyebabkan Disk Thrashing (kepala pembaca HDD/SSD melompat-lompat) yang membunuh kecepatan disk.

Solusi Algoritma (Smart Transfer):

Untuk File Besar (> 100MB): Lakukan transfer secara sekuensial (1 file pada satu waktu) untuk memaksimalkan throughput pembacaan disk.

Untuk File Kecil (< 5MB): Gunakan konkurensi terkontrol (misal: memproses 10 - 20 file kecil secara bersamaan menggunakan Promise.all dengan pembatas seperti library p-limit).

D. Tuning Buffer Size (highWaterMark)
Secara default, stream Node.js membaca file dalam ukuran chunk 64KB. Untuk SSD NVMe modern, ukuran ini terlalu kecil.

Kita dapat meningkatkan parameter highWaterMark menjadi 1MB - 4MB (1024 * 1024 * 4) pada ReadStream untuk mengurangi jumlah pemanggilan I/O ke sistem operasi, sehingga proses transfer jauh lebih cepat.

6. Spesifikasi Teknologi
Desktop Framework: Electron (membungkus web app menjadi aplikasi desktop dengan akses ke OS/sistem file).

Frontend UI: React.js atau Vue.js, dikombinasikan dengan TailwindCSS untuk antarmuka yang bersih dan ringan.

Backend Logic (Node.js):

fs dan fs/promises (Modul bawaan untuk akses sistem file).

stream (Untuk transfer data efisien).

worker_threads (Untuk proses background non-blocking).

chokidar (Opsional: untuk mendeteksi perubahan folder secara real-time jika ada file yang ditambahkan/dihapus dari luar aplikasi).

7. Timeline & Fase Pengembangan
Fase 1 (MVP - 2 Minggu): Setup UI Dual-Pane, navigasi direktori (klik masuk folder, back), implementasi fs.readdir untuk menampilkan list file.

Fase 2 (Core Engine - 2 Minggu): Membangun Worker Thread khusus untuk logika Copy/Move menggunakan Streams, serta menghitung ukuran direktori rekursif.

Fase 3 (Optimasi & UI Feedback - 1 Minggu): Menambahkan progress bar (menghitung bytes transfer per detik), sistem antrean (Queue), dan resolusi konflik (Timpa/Skip).

Fase 4 (Testing & Release - 1 Minggu): Pengujian beban (transfer 100GB data acak) dan perbandingan kecepatan dengan file explorer bawaan OS (Windows Explorer / macOS Finder).

Berikut adalah contoh implementasi menggunakan Node.js. Agar kodenya terstruktur dengan baik, kita akan membaginya menjadi dua bagian:

copy-worker.js: File ini berisi logika worker thread yang bertugas melakukan copy file menggunakan Stream dengan highWaterMark yang sudah dioptimasi, serta menghitung progresnya.

main.js: File ini adalah thread utama (bisa dibayangkan sebagai proses utama Electron/UI Anda) yang memanggil worker dan menerima laporan progres tanpa mengalami blocking.

1. Kode Worker Thread (copy-worker.js)
File ini berjalan di background sehingga proses I/O disk yang berat tidak akan mengganggu antarmuka pengguna (UI).

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

async function executeCopy() {
    const { source, destination } = workerData;

    try {
        // Dapatkan ukuran total file untuk kalkulasi persentase
        const stat = fs.statSync(source);
        const totalSize = stat.size;
        let copiedSize = 0;
        let lastReportedProgress = -1;

        // Optimasi 1: Atur buffer size (highWaterMark) lebih besar dari default (64KB).
        // Di sini kita gunakan 4MB per chunk agar baca/tulis ke SSD jauh lebih cepat.
        const CHUNK_SIZE = 4 * 1024 * 1024; 
        
        const readStream = fs.createReadStream(source, { highWaterMark: CHUNK_SIZE });
        const writeStream = fs.createWriteStream(destination);

        // Stream perantara (Transform) untuk mencegat aliran data dan menghitung progres
        const progressTracker = new Transform({
            transform(chunk, encoding, callback) {
                copiedSize += chunk.length;
                const progress = Math.floor((copiedSize / totalSize) * 100);
                
                // Optimasi 2: Cegah IPC Flooding. 
                // Jangan kirim pesan setiap chunk lewat, kirim hanya jika persentase berubah.
                if (progress > lastReportedProgress) {
                    parentPort.postMessage({ 
                        status: 'progress', 
                        progress: progress, 
                        copied: copiedSize, 
                        total: totalSize 
                    });
                    lastReportedProgress = progress;
                }
                
                // Lanjutkan chunk ke writeStream
                callback(null, chunk);
            }
        });

        // Optimasi 3: Gunakan pipeline agar memory leak terhindar jika terjadi error di tengah jalan
        await pipeline(
            readStream,
            progressTracker,
            writeStream
        );

        // Beri tahu main thread bahwa proses selesai
        parentPort.postMessage({ status: 'done' });

    } catch (error) {
        // Tangkap error (misal: disk penuh, akses ditolak)
        parentPort.postMessage({ status: 'error', message: error.message });
    }
}

executeCopy();

2. Kode Main Thread (main.js)
File ini bertugas memanggil worker dan bisa Anda integrasikan dengan UI Anda.
const { Worker } = require('worker_threads');
const path = require('path');

/**
 * Fungsi untuk meng-copy file menggunakan worker thread.
 * Mengembalikan Promise agar mudah di-await di fungsi lain.
 */
function copyFileFast(source, destination) {
    return new Promise((resolve, reject) => {
        // Path menuju file worker
        const workerPath = path.join(__dirname, 'copy-worker.js');
        
        // Buat worker baru dan kirim data path sumber dan tujuan
        const worker = new Worker(workerPath, {
            workerData: { source, destination }
        });

        // Dengarkan pesan yang dikirim dari worker
        worker.on('message', (message) => {
            if (message.status === 'progress') {
                // Di sini Anda bisa mengupdate Progress Bar di UI Electron/React
                // Karena ini berjalan di thread terpisah, UI tidak akan freeze (lag)
                console.log(`[UI Tetap Responsif] Progres: ${message.progress}% - (${(message.copied / 1024 / 1024).toFixed(2)} MB / ${(message.total / 1024 / 1024).toFixed(2)} MB)`);
            } 
            else if (message.status === 'done') {
                console.log('✅ File berhasil di-copy!');
                resolve();
            } 
            else if (message.status === 'error') {
                reject(new Error(message.message));
            }
        });

        // Tangani jika worker crash
        worker.on('error', (err) => {
            reject(err);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker berhenti dengan exit code ${code}`));
            }
        });
    });
}

// ==========================================
// Contoh Penggunaan
// ==========================================
async function run() {
    console.log('Memulai proses copy file besar...');
    const sourceFile = 'C:/Path/Ke/File/VideoBesar.mp4'; // Sesuaikan path-nya
    const destFile = 'D:/Path/Tujuan/VideoBesar_copy.mp4';

    try {
        await copyFileFast(sourceFile, destFile);
        console.log('Semua proses selesai.');
    } catch (error) {
        console.error('Terjadi kesalahan:', error.message);
    }
}

// Uncomment untuk menjalankan tes
// run();

💡 Penjelasan Teknikal Mengapa Ini Cepat & Responsif:
Tidak Memblokir Event Loop (No UI Freeze): Karena menggunakan worker_threads, proses pembacaan (read) dan penulisan (write) disk dialihkan sepenuhnya ke proses CPU mandiri di latar belakang. Anda tetap bisa mengklik tombol di UI atau menavigasi folder di panel lain dengan mulus.

highWaterMark: 4 * 1024 * 1024: Sistem operasi lebih suka membaca data besar sekaligus dibanding kecil-kecil berkali-kali. Default fs adalah 64KB, yang mana memakan banyak iterasi I/O. Meningkatkannya menjadi 4MB akan membuat SSD/NVMe bekerja lebih maksimal.

IPC Throttling (progress > lastReportedProgress): Inter-Process Communication (mengirim pesan dari Worker ke Main Thread) itu cukup memakan resource. Jika chunk stream di-post setiap 4MB melewati pipa, itu bisa melempar ribuan pesan per detik. Membatasi pengiriman hanya saat angka persentase berubah memastikan Main Thread tidak kebanjiran event.