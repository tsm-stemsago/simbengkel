/* =====================================================================
 * SIM Bengkel TSM — TAHAP 2 (add-on)
 *   1. Paket alat (job sheet)      : tab "Paket Alat" + tombol "Pakai" di form pinjam
 *   2. QR alat                     : cetak label QR (admin) + scan QR (form pinjam / pencarian)
 *   3. Pengingat WhatsApp 1-klik   : kartu di Dashboard (admin), pesan siap kirim lewat wa.me
 *
 * Cara pasang: unggah file ini ke repositori (sejajar index.html) lalu tambahkan SATU baris
 * tepat sebelum </body> di index.html (setelah blok <script> utama):
 *
 *     <script src="tahap2.js"></script>
 *
 * Cara batal: hapus baris tersebut. Tidak ada data yang diubah oleh file ini selain
 * koleksi baru `paket_alat` (aturannya sudah ada di firestore.rules).
 * ===================================================================== */
(function () {
    'use strict';

    if (typeof window.tsmApp !== 'function') {
        console.error('tahap2.js harus dimuat SETELAH skrip utama index.html.');
        return;
    }

    const QR_GEN_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    const QR_SCAN_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
    const MAX_PAKET_ITEMS = (typeof MAX_LOAN_ITEMS === 'number') ? MAX_LOAN_ITEMS : 15;   // paket harus muat di satu pengajuan

    // ---------- Pemuat pustaka (lazy, sekali saja) ----------
    const _lazy = {};
    function loadLib(src, isReady) {
        if (isReady()) return Promise.resolve();
        if (_lazy[src]) return _lazy[src];
        _lazy[src] = new Promise((ok, no) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = ok;
            s.onerror = () => { delete _lazy[src]; no(new Error('Pustaka QR gagal dimuat. Periksa koneksi internet.')); };
            document.head.appendChild(s);
        });
        return _lazy[src];
    }

    let qrInstance = null;   // di luar state Alpine agar tidak dibungkus proxy reaktif

    const fmtTgl = s => { const p = String(s || '').split('-'); return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : String(s || '-'); };
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // =====================================================================
    // STATE & METODE TAMBAHAN
    // =====================================================================
    function makeExt() {
        return {
            // ---- state ----
            paketList: [], paketLoading: false, paketSearch: '', paketPilihId: '', modalPaket: false,
            formPaket: { id: null, nama: '', deskripsi: '', aktif: true, items: [{ alatId: '', searchAlatQuery: '', jumlah: 1 }] },
            qrScan: { open: false, mode: 'loan', msg: '', err: false, manual: '' },
            _lastScan: { kode: '', at: 0 },
            reminded: {},

            // ---- getter ----
            get paketAktif() { return (this.paketList || []).filter(p => p.aktif !== false); },
            get filteredPaket() {
                const q = (this.paketSearch || '').toLowerCase().trim();
                return (this.paketList || []).filter(p =>
                    (this.isStaff || p.aktif !== false) &&
                    ((p.nama || '') + ' ' + (p.deskripsi || '') + ' ' + (p.items || []).map(i => i.namaAlat).join(' ')).toLowerCase().includes(q));
            },

            // =============================================================
            // 1. PAKET ALAT
            // =============================================================
            async loadPaket() {
                if (!this.currentUser) return;
                this.paketLoading = true;
                try {
                    const snap = await db.collection('paket_alat').get();   // 1 read per dokumen paket, sekali per login
                    this.paketList = snap.docs.map(d => ({ ...d.data(), id: d.id }))
                        .filter(p => Array.isArray(p.items))
                        .sort((a, b) => String(a.nama).localeCompare(String(b.nama)));
                } catch (e) {
                    console.warn('Paket alat:', e.message);
                } finally {
                    this.paketLoading = false;
                }
            },
            paketItemOk(it) {
                const a = (this.alatList || []).find(x => x.id === it.alatId);
                return !!a && Number(a.jumlahTersedia || 0) >= Number(it.jumlah || 1);
            },
            canEditPaket(p) {
                if (this.isAdmin) return true;
                return this.userRole === 'guru' && String(p.dibuatOleh || '').toLowerCase() === String((this.currentUser && this.currentUser.email) || '').toLowerCase();
            },
            openPaketModal(p) {
                if (!this.isStaff) { showToastGlobal('Akses Ditolak', 'Hanya guru/admin yang dapat mengelola paket alat.', 'error'); return; }
                if (p) {
                    if (!this.canEditPaket(p)) { showToastGlobal('Akses Ditolak', 'Guru hanya dapat mengubah paket buatannya sendiri.', 'error'); return; }
                    this.formPaket = {
                        id: p.id, nama: p.nama || '', deskripsi: p.deskripsi || '', aktif: p.aktif !== false,
                        items: (p.items || []).map(it => {
                            const a = (this.alatList || []).find(x => x.id === it.alatId);
                            const kode = (a && a.kodeAlat) || it.kodeAlat || '';
                            return { alatId: it.alatId, searchAlatQuery: (kode ? kode + ' — ' : '') + ((a && a.namaAlat) || it.namaAlat || ''), jumlah: Number(it.jumlah) || 1 };
                        })
                    };
                } else {
                    this.formPaket = { id: null, nama: '', deskripsi: '', aktif: true, items: [{ alatId: '', searchAlatQuery: '', jumlah: 1 }] };
                }
                this.modalPaket = true;
            },
            addPaketItem() {
                if (this.formPaket.items.length >= MAX_PAKET_ITEMS) { showToastGlobal('Batas Tercapai', 'Maksimal ' + MAX_PAKET_ITEMS + ' jenis alat per paket.', 'error'); return; }
                this.formPaket.items.push({ alatId: '', searchAlatQuery: '', jumlah: 1 });
            },
            removePaketItem(i) { this.formPaket.items.splice(i, 1); },
            filterPaketAlat(q, idx) {
                q = (q || '').toLowerCase().trim();
                const chosen = new Set(this.formPaket.items.map((it, i) => i === idx ? '' : it.alatId).filter(Boolean));
                return (this.alatList || [])
                    .filter(a => !chosen.has(a.id) && ((a.kodeAlat || '') + ' ' + (a.namaAlat || '') + ' ' + (a.merk || '')).toLowerCase().includes(q))
                    .sort((a, b) => String(a.namaAlat).localeCompare(String(b.namaAlat)))
                    .slice(0, 60);
            },
            pickPaketAlat(item, a) {
                item.alatId = a.id;
                item.searchAlatQuery = (a.kodeAlat ? a.kodeAlat + ' — ' : '') + a.namaAlat;
            },
            async savePaket() {
                if (this.actionLoading || !this.isStaff) return;
                const F = this.formPaket;
                const nama = String(F.nama || '').trim();
                const desk = String(F.deskripsi || '').trim();
                if (!nama || nama.length > 100) { showToastGlobal('Validasi Gagal', 'Nama paket wajib diisi (maks. 100 karakter).', 'error'); return; }
                if (desk.length > 300) { showToastGlobal('Validasi Gagal', 'Deskripsi maksimal 300 karakter.', 'error'); return; }
                if (!F.items.length || F.items.length > MAX_PAKET_ITEMS) { showToastGlobal('Validasi Gagal', 'Paket harus berisi 1 sampai ' + MAX_PAKET_ITEMS + ' jenis alat.', 'error'); return; }
                const seen = new Set(), items = [];
                for (const it of F.items) {
                    const a = (this.alatList || []).find(x => x.id === it.alatId);
                    const q = Number(it.jumlah);
                    if (!a) { showToastGlobal('Validasi Gagal', 'Pilih alat dari daftar (alat yang diarsipkan harus dihapus dari paket).', 'error'); return; }
                    if (!Number.isInteger(q) || q <= 0 || q > 1000) { showToastGlobal('Validasi Gagal', 'Jumlah "' + a.namaAlat + '" harus bilangan bulat 1–1000.', 'error'); return; }
                    if (seen.has(a.id)) { showToastGlobal('Validasi Gagal', '"' + a.namaAlat + '" dipilih lebih dari satu kali.', 'error'); return; }
                    seen.add(a.id);
                    items.push({ alatId: a.id, kodeAlat: String(a.kodeAlat || ''), namaAlat: String(a.namaAlat || ''), jumlah: q });
                }
                this.actionLoading = true;
                try {
                    const me = this.currentUser.email.toLowerCase();
                    const ts = firebase.firestore.FieldValue.serverTimestamp();
                    const b = db.batch();
                    if (F.id) {
                        const old = this.paketList.find(p => p.id === F.id);
                        if (!old || !this.canEditPaket(old)) throw new Error('Anda tidak berhak mengubah paket ini.');
                        b.update(db.collection('paket_alat').doc(F.id), { nama, deskripsi: desk, items, aktif: !!F.aktif, updatedAt: ts });
                        txAudit(b, 'SAVE_PAKET', 'Ubah paket "' + nama + '" (' + items.length + ' jenis alat)' + (F.aktif ? '' : ' — nonaktif'));
                    } else {
                        const id = crypto.randomUUID();
                        b.set(db.collection('paket_alat').doc(id), { id, nama, deskripsi: desk, items, aktif: !!F.aktif, dibuatOleh: me, createdAt: ts, updatedAt: ts });
                        txAudit(b, 'SAVE_PAKET', 'Buat paket "' + nama + '" (' + items.length + ' jenis alat)');
                    }
                    await b.commit();
                    this.modalPaket = false;
                    showToastGlobal('Tersimpan', 'Paket "' + nama + '" disimpan.');
                    await this.loadPaket();
                } catch (e) {
                    showToastGlobal('Gagal Menyimpan Paket', friendlyError(e), 'error');
                } finally {
                    this.actionLoading = false;
                }
            },
            async deletePaket(p) {
                if (this.actionLoading || !this.canEditPaket(p)) return;
                if (!confirm('Hapus paket "' + p.nama + '"? Riwayat peminjaman tidak terpengaruh.')) return;
                this.actionLoading = true;
                try {
                    const b = db.batch();
                    b.delete(db.collection('paket_alat').doc(p.id));
                    txAudit(b, 'DELETE_PAKET', 'Hapus paket "' + p.nama + '"');
                    await b.commit();
                    showToastGlobal('Terhapus', 'Paket dihapus.');
                    await this.loadPaket();
                } catch (e) {
                    showToastGlobal('Gagal Menghapus', friendlyError(e), 'error');
                } finally {
                    this.actionLoading = false;
                }
            },
            // Isi form pinjam dari paket: alat yang habis dilewati, jumlah dibatasi sesuai stok tersedia.
            terapkanPaket() {
                const p = (this.paketList || []).find(x => x.id === this.paketPilihId);
                if (!p) { showToastGlobal('Pilih Paket', 'Pilih paket terlebih dahulu.', 'error'); return; }
                const items = [], catatan = [];
                (p.items || []).forEach(it => {
                    const a = (this.alatList || []).find(x => x.id === it.alatId);
                    const sisa = a ? Number(a.jumlahTersedia || 0) : 0;
                    if (!a || sisa <= 0) { catatan.push(it.namaAlat + ' (habis)'); return; }
                    const q = Math.min(Number(it.jumlah) || 1, sisa);
                    if (q < Number(it.jumlah)) catatan.push(it.namaAlat + ' (hanya ' + q + ')');
                    items.push({ alatId: a.id, searchAlatQuery: (a.kodeAlat ? a.kodeAlat + ' — ' : '') + a.namaAlat, jumlah: q });
                });
                if (!items.length) { showToastGlobal('Paket Tidak Dapat Dipakai', 'Semua alat dalam paket ini sedang habis.', 'error'); return; }
                this.formStudentLoan.items = items.slice(0, MAX_PAKET_ITEMS);
                if (!String(this.formStudentLoan.keperluan || '').trim()) this.formStudentLoan.keperluan = ('Job sheet: ' + p.nama).slice(0, 200);
                showToastGlobal(catatan.length ? 'Paket Diisi (sebagian)' : 'Paket Diisi', catatan.length ? 'Dilewati/dikurangi: ' + catatan.join(', ') : items.length + ' jenis alat dimasukkan ke form.', catatan.length ? 'error' : 'success');
            },
            pakaiPaket(p) {
                if (p.aktif === false) { showToastGlobal('Paket Nonaktif', 'Paket ini sedang dinonaktifkan.', 'error'); return; }
                this.openModal('studentLoan');
                if (Alpine.store('modals').studentLoan) { this.paketPilihId = p.id; this.terapkanPaket(); }
            },

            // =============================================================
            // 2. QR ALAT
            // =============================================================
            cariAlatByKode(txt) {
                const raw = String(txt || '').trim();
                if (!raw) return null;
                const cands = [raw, raw.split(/[:\/=?#&\s]+/).filter(Boolean).pop() || ''].map(s => s.toLowerCase());
                for (const c of cands) {
                    const a = (this.alatList || []).find(x => String(x.kodeAlat || '').trim().toLowerCase() === c);
                    if (a) return a;
                }
                return null;
            },
            async openQrScan(mode) {
                if (!this.isAuthenticated) return;
                this.qrScan = { open: true, mode, msg: 'Menyiapkan kamera...', err: false, manual: '' };
                await this.$nextTick();
                try {
                    await loadLib(QR_SCAN_SRC, () => window.Html5Qrcode);
                    qrInstance = new window.Html5Qrcode('qr-reader');
                    await qrInstance.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 } },
                        txt => this.onQrText(txt), () => { });
                    this.qrScan.msg = 'Arahkan kamera ke QR pada alat.';
                } catch (e) {
                    this.qrScan.err = true;
                    this.qrScan.msg = 'Kamera tidak dapat dipakai (' + (e && e.message ? e.message : e) + '). Ketik kode alat secara manual di bawah.';
                }
            },
            async closeQrScan() {
                this.qrScan.open = false;
                const inst = qrInstance; qrInstance = null;
                try { if (inst) { if (inst.isScanning) await inst.stop(); inst.clear(); } } catch (e) { /* abaikan */ }
            },
            onQrText(txt) {
                const now = Date.now(), kode = String(txt || '').trim();
                if (kode === this._lastScan.kode && now - this._lastScan.at < 2000) return;   // cegah baca ganda saat QR masih di depan kamera
                this._lastScan = { kode, at: now };
                this.procesKode(kode);
            },
            submitQrManual() {
                const v = String(this.qrScan.manual || '').trim();
                if (!v) return;
                this.procesKode(v);
                this.qrScan.manual = '';
            },
            procesKode(txt) {
                const a = this.cariAlatByKode(txt);
                if (!a) { this.qrScan.err = true; this.qrScan.msg = 'Kode "' + String(txt).slice(0, 40) + '" tidak dikenal.'; return false; }
                const mode = this.qrScan.mode;
                if (mode === 'loan') {
                    const sisa = Number(a.jumlahTersedia || 0);
                    if (sisa <= 0) { this.qrScan.err = true; this.qrScan.msg = a.namaAlat + ' — stok habis.'; return false; }
                    const items = this.formStudentLoan.items;
                    const ada = items.find(it => it.alatId === a.id);
                    if (ada) {
                        if (Number(ada.jumlah) >= sisa) { this.qrScan.err = true; this.qrScan.msg = a.namaAlat + ' — sudah maksimal (' + sisa + ').'; return false; }
                        ada.jumlah = Number(ada.jumlah || 0) + 1;
                    } else {
                        let row = items.find(it => !it.alatId && !String(it.searchAlatQuery || '').trim());
                        if (!row) {
                            if (items.length >= MAX_PAKET_ITEMS) { this.qrScan.err = true; this.qrScan.msg = 'Maksimal ' + MAX_PAKET_ITEMS + ' jenis alat per pengajuan.'; return false; }
                            items.push({ alatId: '', searchAlatQuery: '', jumlah: 1 });
                            row = items[items.length - 1];
                        }
                        this.pickAlat(row, a);
                    }
                    this.qrScan.err = false;
                    this.qrScan.msg = '✔ ' + a.namaAlat + ' ditambahkan. Scan lagi atau tekan Selesai.';
                } else if (mode === 'cariLoan') {
                    this.searchLoan = a.namaAlat; this.currentPageLoan = 1; this.closeQrScan();
                } else {
                    this.searchAlat = a.kodeAlat; this.currentPageAlat = 1; this.closeQrScan();
                }
                if (navigator.vibrate) navigator.vibrate(60);
                return true;
            },
            // Cetak label QR untuk alat yang tampil pada hasil pencarian Inventaris Alat (admin).
            async cetakLabelQr() {
                if (!this.isAdmin) { showToastGlobal('Akses Ditolak', 'Hanya admin yang dapat mencetak label QR.', 'error'); return; }
                const list = this.filteredAlat;
                if (!list.length) { showToastGlobal('Tidak Ada Data', 'Tidak ada alat untuk dicetak.', 'error'); return; }
                const w = window.open('', '_blank');          // harus dibuka langsung dari klik agar tidak diblokir pop-up
                if (!w) { showToastGlobal('Pop-up Diblokir', 'Izinkan pop-up untuk situs ini lalu coba lagi.', 'error'); return; }
                w.document.write('<p style="font-family:sans-serif;padding:16px">Membuat ' + list.length + ' label QR...</p>');
                let holder = null;
                try {
                    await loadLib(QR_GEN_SRC, () => window.QRCode);
                    holder = document.createElement('div');
                    holder.style.cssText = 'position:absolute;left:-9999px;top:0';
                    document.body.appendChild(holder);
                    const cells = [];
                    for (const a of list) {
                        holder.innerHTML = '';
                        new window.QRCode(holder, { text: String(a.kodeAlat || ''), width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.M });
                        const cv = holder.querySelector('canvas');
                        const img = holder.querySelector('img');
                        const src = cv ? cv.toDataURL('image/png') : (img ? img.src : '');
                        cells.push('<div class="l"><img src="' + src + '" alt=""><div class="k">' + esc(a.kodeAlat) + '</div><div class="n">' + esc(a.namaAlat) + '</div><div class="r">' + esc(a.lokasiRak || '') + '</div></div>');
                    }
                    const css = 'body{margin:0;font-family:Arial,sans-serif}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}.l{border:1px dashed #94a3b8;border-radius:3mm;padding:3mm;text-align:center;break-inside:avoid;page-break-inside:avoid}.l img{width:30mm;height:30mm}.k{font:bold 11pt monospace;margin-top:1mm}.n{font-size:9pt;line-height:1.2;margin-top:1mm}.r{font-size:8pt;color:#475569;margin-top:1mm}@page{size:A4;margin:8mm}';
                    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Label QR Alat</title><style>' + css + '</style></head><body><div class="g">' + cells.join('') + '</div><script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>';
                    w.document.open(); w.document.write(html); w.document.close();
                } catch (e) {
                    try { w.close(); } catch (x) { /* abaikan */ }
                    showToastGlobal('Gagal Membuat Label', e.message || String(e), 'error');
                } finally {
                    if (holder && holder.remove) holder.remove();
                }
            },

            // =============================================================
            // 3. PENGINGAT WHATSAPP (admin)
            // =============================================================
            waNormalize(hp) {
                let d = String(hp || '').replace(/[^0-9]/g, '');
                if (d.startsWith('62')) { /* sudah format internasional */ }
                else if (d.startsWith('0')) d = '62' + d.slice(1);
                else if (d.startsWith('8')) d = '62' + d;
                else return '';
                return (d.length >= 10 && d.length <= 15) ? d : '';
            },
            waUrl(g) {
                const num = this.waNormalize(g.noHp);
                if (!num) return '';
                const lines = g.items.slice(0, 10).map(l => '• ' + l.namaAlat + ' ×' + l.jumlah + ' (batas kembali ' + fmtTgl(l.jatuhTempo) + ')');
                if (g.items.length > 10) lines.push('• dan ' + (g.items.length - 10) + ' alat lainnya');
                const msg = [
                    "Assalamu'alaikum, " + g.nama + ' (' + g.kelas + ').', '',
                    'Pengingat dari Toolman Bengkel ' + ((this.settings && this.settings.singkatanBengkel) || 'TSM') + ':',
                    g.terlambat ? 'Alat berikut SUDAH MELEWATI batas pengembalian:' : 'Alat berikut jatuh tempo pengembaliannya hari ini/besok:',
                    ...lines, '', 'Mohon segera dikembalikan ke bengkel. Terima kasih.'
                ].join('\n');
                return 'https://wa.me/' + num + '?text=' + encodeURIComponent(msg);
            },
            get reminderGroups() {
                if (!this.isAdmin) return [];
                const today = localDateStr();
                const besok = localDateStr(new Date(Date.now() + 864e5));
                const map = new Map();
                (this.loanList || []).forEach(l => {
                    if (!HOLDING_STATUS.includes(l.status) || !l.jatuhTempo || l.jatuhTempo > besok) return;
                    const key = String(l.emailPengaju || l.namaPeminjam || l.id).toLowerCase();
                    if (!map.has(key)) map.set(key, { key, nama: l.namaPeminjam, kelas: l.kelas, noHp: l.noHp || '', items: [], paling: l.jatuhTempo });
                    const g = map.get(key);
                    g.items.push(l);
                    if (l.jatuhTempo < g.paling) g.paling = l.jatuhTempo;
                    if (!g.noHp && l.noHp) g.noHp = l.noHp;
                });
                return [...map.values()].map(g => {
                    const ringkas = g.items.slice(0, 3).map(l => l.namaAlat + ' ×' + l.jumlah).join('; ') + (g.items.length > 3 ? ' +' + (g.items.length - 3) + ' lainnya' : '');
                    const gg = { ...g, ringkas, terlambat: g.paling < today };
                    gg.url = this.waUrl(gg);
                    return gg;
                }).sort((a, b) => a.paling.localeCompare(b.paling));
            },
            markReminded(key) { this.reminded = { ...this.reminded, [key]: true }; }
        };
    }

    // =====================================================================
    // PEMBUNGKUS tsmApp(): menambah state/metode tanpa mengubah kode utama
    // =====================================================================
    const baseFactory = window.tsmApp;
    window.tsmApp = function () {
        const base = baseFactory();
        Object.defineProperties(base, Object.getOwnPropertyDescriptors(makeExt()));   // salin termasuk getter (tanpa mengeksekusinya)

        const oSetup = base.setupFirestoreListeners;
        base.setupFirestoreListeners = function () { oSetup.apply(this, arguments); this.loadPaket(); };

        const oReset = base.resetData;
        base.resetData = function () { oReset.apply(this, arguments); this.paketList = []; this.paketPilihId = ''; this.reminded = {}; };

        const oOpen = base.openModal;
        base.openModal = function (type) { if (type === 'studentLoan') this.paketPilihId = ''; return oOpen.apply(this, arguments); };
        return base;
    };

    // =====================================================================
    // SISIPAN ANTARMUKA (dijalankan sinkron, sebelum Alpine memulai)
    // =====================================================================
    const HTML_NAV = '<button @click="activeTab = \'paket\'" :class="activeTab === \'paket\' ? \'bg-md3-primaryContainer text-md3-primary font-bold shadow-sm\' : \'text-slate-600 hover:bg-slate-100\'" class="px-4 py-2 rounded-md3-full text-xs flex items-center space-x-2 whitespace-nowrap transition"><i class="fa-solid fa-box-open"></i><span>Paket Alat</span><span class="ml-1 px-2 py-0.5 text-[10px] rounded-md3-full bg-slate-100 text-slate-700" x-show="paketAktif.length > 0" x-text="paketAktif.length"></span></button>';

    const HTML_TAB_PAKET = `
<div x-show="activeTab === 'paket'" class="space-y-4" x-cloak>
    <div class="bg-white p-4 rounded-[24px] border border-md3-surfaceVariant shadow-sm max-w-5xl mx-auto flex flex-col sm:flex-row gap-3 items-center no-print">
        <input type="search" x-model="paketSearch" placeholder="Cari paket / job sheet atau nama alat..." class="flex-1 w-full p-3 sm:p-2.5 border border-md3-surfaceVariant rounded-2xl text-sm sm:text-xs focus:ring-2 focus:ring-md3-primary focus:outline-none bg-slate-50">
        <div class="flex gap-2 w-full sm:w-auto">
            <button type="button" @click="loadPaket()" :disabled="paketLoading" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-3 sm:py-2.5 rounded-md3-full text-xs transition disabled:opacity-50" title="Muat ulang"><i class="fa-solid fa-rotate" :class="paketLoading ? 'fa-spin' : ''"></i></button>
            <button type="button" x-show="isStaff" @click="openPaketModal(null)" class="flex-1 sm:flex-none bg-md3-primary hover:bg-blue-800 text-white font-bold px-5 py-3 sm:py-2.5 rounded-md3-full text-xs shadow transition whitespace-nowrap"><i class="fa-solid fa-plus mr-1"></i> Buat Paket</button>
        </div>
    </div>
    <p class="max-w-5xl mx-auto text-[11px] text-slate-500 px-1">Paket = kumpulan alat untuk satu job sheet. Tombol <b>Pakai</b> mengisi form peminjaman otomatis; alat yang habis dilewati. Hijau = stok cukup, merah = stok kurang.</p>
    <div class="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-4">
        <template x-for="p in filteredPaket" :key="p.id">
            <div class="bg-white rounded-[24px] border border-md3-surfaceVariant shadow-sm p-5 space-y-3">
                <div class="flex justify-between items-start gap-2">
                    <div class="min-w-0">
                        <h4 class="font-bold text-slate-900 text-sm" x-text="p.nama"></h4>
                        <p class="text-[11px] text-slate-500" x-show="p.deskripsi" x-text="p.deskripsi"></p>
                    </div>
                    <span class="shrink-0 px-2.5 py-1 rounded-md3-full text-[10px] font-bold uppercase" :class="p.aktif === false ? 'bg-slate-200 text-slate-600' : 'bg-emerald-100 text-emerald-800'" x-text="p.aktif === false ? 'Nonaktif' : 'Aktif'"></span>
                </div>
                <div class="flex flex-wrap gap-1.5">
                    <template x-for="(it, i) in p.items" :key="i">
                        <span class="px-2.5 py-1 rounded-xl text-[11px] font-semibold border" :class="paketItemOk(it) ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'" x-text="it.namaAlat + ' ×' + it.jumlah"></span>
                    </template>
                </div>
                <p class="text-[10px] text-slate-400" x-show="isStaff" x-text="'Dibuat oleh ' + String(p.dibuatOleh || '-').split('@')[0]"></p>
                <div class="flex flex-wrap gap-1.5 pt-1">
                    <button type="button" @click="pakaiPaket(p)" :disabled="p.aktif === false" class="bg-md3-primary hover:bg-blue-800 text-white px-4 py-2 rounded-xl text-[11px] font-bold shadow-sm transition disabled:opacity-40"><i class="fa-solid fa-hand-holding-hand mr-1"></i> Pakai</button>
                    <template x-if="canEditPaket(p)"><button type="button" @click="openPaketModal(p)" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded-xl text-[11px] font-bold transition"><i class="fa-solid fa-pen-to-square mr-1"></i> Edit</button></template>
                    <template x-if="canEditPaket(p)"><button type="button" @click="deletePaket(p)" :disabled="actionLoading" class="bg-red-50 hover:bg-red-100 text-red-600 px-3 py-2 rounded-xl text-[11px] font-bold transition disabled:opacity-50"><i class="fa-solid fa-trash-can mr-1"></i> Hapus</button></template>
                </div>
            </div>
        </template>
    </div>
    <p x-show="!paketLoading && filteredPaket.length === 0" class="text-center text-slate-400 text-sm py-8 font-medium">Belum ada paket alat.</p>
</div>`;

    const HTML_REMINDER = `
<div x-show="isAdmin && reminderGroups.length > 0" class="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-xs text-emerald-950 space-y-2 no-print">
    <p class="font-bold"><i class="fa-brands fa-whatsapp mr-1"></i> Pengingat pengembalian (terlambat / jatuh tempo hari ini &amp; besok): <span x-text="reminderGroups.length"></span> peminjam</p>
    <div class="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar">
        <template x-for="g in reminderGroups" :key="g.key">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white border border-emerald-100 rounded-xl p-2.5">
                <div class="min-w-0">
                    <p class="font-bold text-slate-900 truncate" x-text="g.nama + ' (' + g.kelas + ')'"></p>
                    <p class="text-[11px] text-slate-600" x-text="g.ringkas"></p>
                    <p class="text-[10px] font-bold" :class="g.terlambat ? 'text-red-600' : 'text-amber-700'" x-text="(g.terlambat ? 'TERLAMBAT sejak ' : 'Jatuh tempo ') + g.paling"></p>
                </div>
                <template x-if="g.url"><a :href="g.url" target="_blank" rel="noopener" @click="markReminded(g.key)" class="shrink-0 px-4 py-2 rounded-xl text-[11px] font-bold text-center transition" :class="reminded[g.key] ? 'bg-slate-200 text-slate-600' : 'bg-emerald-700 hover:bg-emerald-800 text-white'"><i class="fa-brands fa-whatsapp mr-1"></i><span x-text="reminded[g.key] ? 'Kirim lagi' : 'Kirim WA'"></span></a></template>
                <template x-if="!g.url"><span class="text-[10px] text-red-600 font-bold shrink-0">No. HP tidak valid</span></template>
            </div>
        </template>
    </div>
</div>`;

    const HTML_LOAN_HELPER = `
<div class="space-y-2">
    <div x-show="paketAktif.length > 0" class="bg-violet-50 border border-violet-200 rounded-2xl p-3 space-y-2">
        <label class="font-bold text-violet-900"><i class="fa-solid fa-box-open mr-1"></i> Pakai Paket Alat / Job Sheet (opsional)</label>
        <div class="flex gap-2">
            <select x-model="paketPilihId" class="flex-1 min-w-0 p-3 sm:p-2.5 bg-white border rounded-xl text-sm sm:text-xs">
                <option value="">— Pilih paket —</option>
                <template x-for="p in paketAktif" :key="p.id"><option :value="p.id" x-text="p.nama + ' (' + p.items.length + ' alat)'"></option></template>
            </select>
            <button type="button" @click="terapkanPaket()" :disabled="!paketPilihId" class="px-4 py-2 bg-violet-700 hover:bg-violet-800 text-white font-bold rounded-xl transition disabled:opacity-40">Isi</button>
        </div>
    </div>
    <button type="button" @click="openQrScan('loan')" class="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-2xl transition"><i class="fa-solid fa-qrcode mr-1"></i> Scan QR alat untuk menambah</button>
</div>`;

    const HTML_ALAT_BAR = `
<div class="flex gap-2 w-full sm:w-auto">
    <button type="button" @click="openQrScan('cariAlat')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-2.5 rounded-md3-full text-xs flex items-center space-x-1 transition whitespace-nowrap"><i class="fa-solid fa-qrcode"></i><span>Scan</span></button>
    <button type="button" x-show="isAdmin" @click="cetakLabelQr()" class="bg-slate-900 hover:bg-slate-800 text-amber-400 font-bold px-4 py-2.5 rounded-md3-full text-xs flex items-center space-x-1 transition whitespace-nowrap" title="Cetak label QR untuk alat yang tampil"><i class="fa-solid fa-print"></i><span>Label QR</span></button>
</div>`;

    const HTML_LOAN_SCAN_BTN = '<button type="button" @click="openQrScan(\'cariLoan\')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-3 sm:py-2.5 rounded-2xl text-xs transition whitespace-nowrap" title="Scan QR alat"><i class="fa-solid fa-qrcode"></i><span class="sm:hidden ml-1">Scan QR</span></button>';

    const HTML_MODALS = `
<!-- TAHAP 2: MODAL PAKET ALAT -->
<div x-show="modalPaket" x-cloak class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm p-0 sm:p-4 no-print">
    <div class="bg-white rounded-t-[28px] sm:rounded-[28px] max-h-[92vh] overflow-y-auto custom-scrollbar max-w-xl w-full p-6 shadow-2xl space-y-4" @click.stop>
        <div class="flex justify-between items-center border-b pb-3">
            <div>
                <h3 class="font-bold text-slate-900 text-sm" x-text="formPaket.id ? 'Edit Paket Alat' : 'Buat Paket Alat Baru'"></h3>
                <p class="text-[11px] text-md3-outline">Kumpulan alat untuk satu job sheet praktik</p>
            </div>
            <button type="button" @click="modalPaket = false" class="text-slate-400 hover:text-slate-600 p-1"><i class="fa-solid fa-xmark text-lg"></i></button>
        </div>
        <form @submit.prevent="savePaket()" class="space-y-3 text-xs">
            <div><label class="font-bold block mb-1 text-slate-700">Nama Paket / Job Sheet <span class="text-red-500">*</span></label><input type="text" x-model="formPaket.nama" required maxlength="100" placeholder="Contoh: Tune Up Motor Injeksi" class="w-full p-3 sm:p-2.5 bg-slate-50 border rounded-xl text-sm sm:text-xs focus:ring-2 focus:ring-md3-primary focus:outline-none"></div>
            <div><label class="font-bold block mb-1 text-slate-700">Deskripsi</label><input type="text" x-model="formPaket.deskripsi" maxlength="300" placeholder="Opsional" class="w-full p-3 sm:p-2.5 bg-slate-50 border rounded-xl text-sm sm:text-xs focus:ring-2 focus:ring-md3-primary focus:outline-none"></div>
            <label class="flex items-center gap-2 font-bold"><input type="checkbox" x-model="formPaket.aktif" class="w-4 h-4"> Paket aktif (dapat dipakai siswa)</label>
            <div class="space-y-3">
                <div class="flex justify-between items-center gap-2">
                    <label class="font-bold text-slate-900"><i class="fa-solid fa-toolbox mr-1 text-md3-primary"></i> Isi Paket <span class="font-normal text-slate-400" x-text="'(' + formPaket.items.length + '/' + 15 + ')'"></span></label>
                    <button type="button" @click="addPaketItem()" class="bg-md3-primaryContainer text-md3-primary font-bold px-3 py-2 rounded-md3-full text-xs transition shadow-sm hover:bg-blue-200 whitespace-nowrap"><i class="fa-solid fa-plus mr-1"></i> Tambah Alat</button>
                </div>
                <template x-for="(item, index) in formPaket.items" :key="index">
                    <div class="p-3 bg-slate-50 rounded-2xl border relative space-y-2" x-data="{ openDropdown: false }" @click.outside="openDropdown = false">
                        <div class="flex justify-between items-center">
                            <span class="font-bold text-slate-700 text-[11px]" x-text="'Alat #' + (index + 1)"></span>
                            <template x-if="formPaket.items.length > 1"><button type="button" @click="removePaketItem(index)" class="text-red-500 hover:text-red-700 p-1"><i class="fa-solid fa-trash-can text-xs"></i></button></template>
                        </div>
                        <div class="grid grid-cols-3 gap-2">
                            <div class="col-span-2 relative">
                                <input type="text" x-model="item.searchAlatQuery" @focus="openDropdown = true" @input="item.alatId = ''; openDropdown = true" @keydown.escape="openDropdown = false" autocomplete="off" placeholder="Cari kode / nama alat..." class="w-full p-3 sm:p-2.5 border rounded-xl text-sm sm:text-xs focus:ring-2 focus:ring-md3-primary focus:outline-none" :class="item.alatId ? 'border-emerald-400 bg-emerald-50' : 'bg-white'">
                                <div x-show="openDropdown" class="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-xl max-h-56 overflow-y-auto custom-scrollbar" x-cloak>
                                    <template x-for="a in filterPaketAlat(item.searchAlatQuery, index)" :key="a.id">
                                        <button type="button" @click="pickPaketAlat(item, a); openDropdown = false" class="w-full text-left p-2.5 border-b border-slate-50 hover:bg-blue-50 flex justify-between items-center gap-2 text-xs">
                                            <span class="min-w-0"><span class="font-mono text-[10px] text-md3-primary block" x-text="a.kodeAlat || '-'"></span><span class="font-bold text-slate-900 block truncate" x-text="a.namaAlat"></span></span>
                                            <span class="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-md3-full bg-slate-100 text-slate-700" x-text="'Sisa ' + (a.jumlahTersedia || 0)"></span>
                                        </button>
                                    </template>
                                    <template x-if="filterPaketAlat(item.searchAlatQuery, index).length === 0"><div class="p-2.5 text-center text-slate-400 text-xs">Alat tidak ditemukan</div></template>
                                </div>
                            </div>
                            <div><input type="number" x-model.number="item.jumlah" min="1" step="1" required placeholder="Qty" class="w-full p-3 sm:p-2.5 bg-white border rounded-xl text-sm sm:text-xs font-bold text-center focus:ring-2 focus:ring-md3-primary focus:outline-none"></div>
                        </div>
                    </div>
                </template>
            </div>
            <div class="flex justify-end space-x-2 pt-3 border-t">
                <button type="button" @click="modalPaket = false" class="px-4 py-3 sm:py-2.5 bg-slate-100 hover:bg-slate-200 font-bold rounded-md3-full transition">Batal</button>
                <button type="submit" :disabled="actionLoading" class="px-5 py-3 sm:py-2.5 bg-md3-primary hover:bg-blue-800 text-white font-bold rounded-md3-full shadow transition disabled:opacity-50">Simpan Paket</button>
            </div>
        </form>
    </div>
</div>

<!-- TAHAP 2: MODAL SCAN QR -->
<div x-show="qrScan.open" x-cloak class="fixed inset-0 z-[55] flex items-end sm:items-center justify-center bg-slate-900/70 backdrop-blur-sm p-0 sm:p-4 no-print">
    <div class="bg-white rounded-t-[28px] sm:rounded-[28px] w-full sm:max-w-md p-5 shadow-2xl space-y-3 text-xs max-h-[92vh] overflow-y-auto" @click.stop>
        <div class="flex justify-between items-center border-b pb-2">
            <div>
                <h3 class="font-bold text-slate-900 text-sm"><i class="fa-solid fa-qrcode mr-1 text-md3-primary"></i> Scan QR Alat</h3>
                <p class="text-[11px] text-md3-outline" x-text="qrScan.mode === 'loan' ? 'Setiap scan menambah 1 unit alat ke form peminjaman' : 'Hasil scan dipakai untuk mencari data'"></p>
            </div>
            <button type="button" @click="closeQrScan()" class="text-slate-400 hover:text-slate-600 p-1"><i class="fa-solid fa-xmark text-lg"></i></button>
        </div>
        <div id="qr-reader" class="w-full overflow-hidden rounded-2xl bg-slate-100 min-h-[240px]"></div>
        <p class="font-semibold" :class="qrScan.err ? 'text-red-600' : 'text-slate-600'" x-text="qrScan.msg"></p>
        <form @submit.prevent="submitQrManual()" class="flex gap-2">
            <input type="text" x-model="qrScan.manual" autocomplete="off" placeholder="Atau ketik kode alat (mis. ALT-TSM-004)" class="flex-1 min-w-0 p-3 sm:p-2.5 border rounded-xl font-mono text-sm sm:text-xs focus:ring-2 focus:ring-md3-primary focus:outline-none">
            <button type="submit" class="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-amber-400 font-bold rounded-xl transition">Cari</button>
        </form>
        <button type="button" @click="closeQrScan()" class="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-md3-full transition">Selesai</button>
    </div>
</div>`;

    function inject() {
        const step = (nama, fn) => { try { fn(); } catch (e) { console.warn('tahap2.js: sisipan "' + nama + '" dilewati —', e.message); } };

        step('navigasi', () => {
            const nav = document.querySelector('nav');
            const tabs = Array.from(nav.querySelectorAll('button'));
            const after = tabs.find(b => (b.textContent || '').includes('Inventaris Alat'));
            if (after) after.insertAdjacentHTML('afterend', HTML_NAV);
            else nav.querySelector('div.flex').insertAdjacentHTML('beforeend', HTML_NAV);
        });
        step('tab paket', () => { document.querySelector('main').insertAdjacentHTML('beforeend', HTML_TAB_PAKET); });
        step('pengingat WA', () => { document.querySelector('[x-show="activeTab === \'dashboard\'"]').insertAdjacentHTML('afterbegin', HTML_REMINDER); });
        step('form pinjam', () => {
            const sec = document.querySelector('[x-text*="formStudentLoan.items.length"]').closest('.space-y-3');
            sec.insertAdjacentHTML('beforebegin', HTML_LOAN_HELPER);
        });
        step('bar alat', () => { document.querySelector('input[x-model="searchAlat"]').insertAdjacentHTML('afterend', HTML_ALAT_BAR); });
        step('scan peminjaman', () => { document.querySelector('input[x-model="searchLoan"]').insertAdjacentHTML('afterend', HTML_LOAN_SCAN_BTN); });
        step('modal', () => { document.body.insertAdjacentHTML('beforeend', HTML_MODALS); });
    }

    inject();
})();
