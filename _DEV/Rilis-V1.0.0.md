# Rilis — Fast File Manager

Panduan rilis resmi aplikasi desktop **Dual-Pane Fast File Manager**.
File ini untuk maintainer / yang mempublish ke GitHub Releases.

---

## 1. Rilis Aktif — v1.0.0 (14 Okt 2026)

Rilis awal. Commit: `e48ab19` — "V1.0.0 - Init project sc for filemanager on copy or move file data".

### Artefak (folder `dist/`)

| File | Ukuran | Keterangan |
|---|---|---|
| `Fast File Manager Setup 1.0.0.exe` | ±106 MB (111.159.250 byte) | Installer NSIS. Install sekali → Start Menu/Desktop shortcut + uninstaller. |
| `FastFileManager-Portable.exe` | ±105,8 MB (110.929.217 byte) | Portable. Double-klik langsung jalan, bisa dibawa di flashdisk. |

> Kedua file mayoritas berisi runtime Electron (±106 MB). Ini normal, bukan bug.

File `*.blockmap`, `builder-debug.yml`, dan folder `dist/Portable/` adalah hasil sampingan
`electron-builder` — **jangan upload ke Releases**, dan `dist/` tetap diabaikan git
(lihat `.gitignore`).

### Verifikasi integritas (SHA-256)

Hash dihitung saat build 14 Okt 2026, PowerShell `Get-FileHash`:

```
Fast File Manager Setup 1.0.0.exe
97208430436C66BF937C87A1AF08CD0473A8398271FB8965785CFDEAF08727C8

FastFileManager-Portable.exe
344B6B0F7C7FA64E9E70DC6EFEC36A19050D35C408C6F3F6F0EC6D537B734A4B
```

Cek ulang sebelum upload:

```powershell
Get-FileHash "dist\Fast File Manager Setup 1.0.0.exe" -Algorithm SHA256
Get-FileHash "dist\FastFileManager-Portable.exe" -Algorithm SHA256
```

### Isi rilis v1.0.0

- UI dual-pane independen (kiri = sumber, kanan = tujuan): address bar + breadcrumbs,
  tabel Nama/Ukuran/Tipe/Modifikasi, sortir kolom, pintasan drive.
- Aksi cepat: `F5` Copy → panel sebelah, `F6` Move, `F8` Delete, `F7` Folder baru.
- Engine transfer: stream 4 MB/chunk, `worker_threads` (UI tidak freeze), progres
  real-time (kecepatan, ETA, file berjalan).
- Smart transfer: file `>100 MB` sekuensial, file `<5 MB` konkuren 12, sisanya pool 4.
- Paralel antar job + slot global 1-per-1 untuk file besar (anti disk-thrashing).
- Pause / Resume / Cancel (terminate paksa + bersih file parsial), auto-refresh panel.
- Conflict handling: Timpa / Lewati / Rename + "berlaku untuk semua".
- Retry otomatis 3x per file + tombol **Coba lagi**, watchdog anti-stuck 120 dtk.
- Build: `Build-Exe.bat` → installer NSIS + portable EXE.
- Syarat runtime pengguna: **tidak perlu install Node.js** — cukup salah satu EXE di atas.
  Syarat Windows 10/11 64-bit.

### Batasan yang diketahui (v1.0.0)

- Ikon masih default Electron (belum pasang `icon.ico` custom, belum code signing
  → Windows SmartScreen mungkin menampilkan peringatan; klik *More info → Run anyway*).
- Belum ada: verifikasi checksum otomatis, mode sinkronisasi folder, riwayat transfer
  persisten, dukungan Linux/macOS (lihat `README.md` → Roadmap).

---

## 2. Cara install untuk pengguna (copy-paste ke GitHub Releases)

```markdown
## Fast File Manager v1.0.0

File manager dual-pane untuk copy/move data besar secepat batas hardware disk.

### Download
- **Installer (disarankan):** `Fast File Manager Setup 1.0.0.exe` — install sekali,
  muncul di Start Menu/Desktop.
- **Portable:** `FastFileManager-Portable.exe` — langsung double-klik, tanpa install.

### Cara pakai
1. Buka aplikasi. Panel kiri = sumber, panel kanan = tujuan (klik panel untuk aktif).
2. Pilih file/folder → `F5` Copy / `F6` Move → mendarat di panel sebelah.
3. Pantau progres (kecepatan, ETA) di panel transfer bawah. Bisa Pause/Resume/Cancel.

Syarat: Windows 10/11 64-bit. Tidak perlu install Node.js.
Jika SmartScreen muncul (aplikasi belum code-signed): More info → Run anyway.
```

---

## 3. Cara publish rilis baru (maintainer)

### 3.1 Siapkan versi

1. Naikkan `version` di `package.json` (mis. `1.0.1`).
2. Pastikan `main.js`, `preload.js`, `server.js`, `transfer-worker.js`,
   `public/index.html` ada dan `node --check server.js main.js` lolos.
3. Uji manual: copy/move folder besar, konflik (timpa/lewati/rename), pause/resume,
   cancel, retry saat drive diputus.

### 3.2 Build EXE

```bat
Build-Exe.bat
```

Hasil di `dist\`. Catat ukuran file + hash:

```powershell
Get-ChildItem dist\*.exe | Select-Object Name, Length
Get-FileHash "dist\Fast File Manager Setup X.Y.Z.exe" -Algorithm SHA256
Get-FileHash "dist\FastFileManager-Portable.exe" -Algorithm SHA256
```

### 3.3 Push + tag

```bat
git add -A
git commit -m "V1.0.1 - <ringkasan>"
git tag v1.0.1
git push origin main --tags
```

### 3.4 Buat GitHub Release

1. GitHub → repo → **Releases → Draft a new release** → pilih tag `v1.0.1`.
2. Judul: `v1.0.1 - <nama ringkas>`.
3. Upload **hanya 2 file EXE** (installer + portable).
4. Isi deskripsi: salin template seksi 2 di atas, sesuaikan versi + tambah
   seksi `### Yang berubah` (daftar commit/fitur/fix).
5. Publish. Update tabel riwayat di bawah.

---

## 4. Riwayat rilis

| Versi | Tanggal | Artefak | Catatan |
|---|---|---|---|
| v1.0.0 | 2026-10-14 | `Fast File Manager Setup 1.0.0.exe`, `FastFileManager-Portable.exe` | Rilis awal: dual-pane + smart transfer engine + installer/portable. |

---

## 5. File terkait

- Spesifikasi produk: [`prd.md`](prd.md)
- Panduan umum + build: [`../README.md`](../README.md)
- Build script: [`../Build-Exe.bat`](../Build-Exe.bat)
- Launcher dev: [`../Jalankan-FileManager.bat`](../Jalankan-FileManager.bat)
