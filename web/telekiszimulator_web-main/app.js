'use strict';

/* ---------- Segédek ---------- */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e[k] = v;
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
}
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.gif'];
const ext = n => (n.match(/\.[^.]*$/) || [''])[0].toLowerCase();
const sanitize = t => {
    const s = t.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/\.+$/, '');
    return s.trim() || 'tortenet';
};

/* ---------- IndexedDB (a Stories mappa megfelelője) ---------- */
const DB = {
    db: null,
    open() {
        return new Promise((res, rej) => {
            const r = indexedDB.open('teleki-szimulator', 1);
            r.onupgradeneeded = () => {
                r.result.createObjectStore('stories', { keyPath: 'dir' });
                r.result.createObjectStore('media');
            };
            r.onsuccess = () => { this.db = r.result; res(); };
            r.onerror = () => rej(r.error);
        });
    },
    tx(store, mode, fn) {
        return new Promise((res, rej) => {
            const t = this.db.transaction(store, mode);
            const rq = fn(t.objectStore(store));
            t.oncomplete = () => res(rq && rq.result);
            t.onerror = () => rej(t.error);
        });
    },
    async list() {
        const all = await this.tx('stories', 'readonly', s => s.getAll());
        return all.sort((a, b) => a.title.localeCompare(b.title, 'hu'));
    },
    get: dir => DB.tx('stories', 'readonly', s => s.get(dir)),
    put: story => DB.tx('stories', 'readwrite', s => s.put(story)),
    async remove(dir) {
        await this.tx('stories', 'readwrite', s => s.delete(dir));
        await this.removeAllMedia(dir);
    },
    getMedia: (dir, f) => DB.tx('media', 'readonly', s => s.get(dir + '/' + f)),
    putMedia: (dir, f, blob) => DB.tx('media', 'readwrite', s => s.put(blob, dir + '/' + f)),
    delMedia: (dir, f) => f ? DB.tx('media', 'readwrite', s => s.delete(dir + '/' + f)) : Promise.resolve(),
    range: dir => IDBKeyRange.bound(dir + '/', dir + '/\uffff'),
    async removeAllMedia(dir) {
        await this.tx('media', 'readwrite', s => s.delete(this.range(dir)));
    },
    async moveStory(from, to, story) {
        const keys = await this.tx('media', 'readonly', s => s.getAllKeys(this.range(from)));
        for (const k of keys) {
            const blob = await this.tx('media', 'readonly', s => s.get(k));
            await this.tx('media', 'readwrite', s => s.put(blob, to + '/' + k.slice(from.length + 1)));
        }
        await this.tx('stories', 'readwrite', s => s.delete(from));
        await this.removeAllMedia(from);
        story.dir = to;
        await this.put(story);
    }
};

/* ---------- Tárolás nélküli ZIP (export) ---------- */
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0, cdSize = 0;
    for (const { name, data } of entries) {
        const nameBytes = enc.encode(name);
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);
        local.setUint16(8, 0, true);
        local.setUint16(10, 0, true);
        local.setUint16(12, 0x21, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);
        parts.push(local.buffer, nameBytes, data);

        const cen = new DataView(new ArrayBuffer(46));
        cen.setUint32(0, 0x02014b50, true);
        cen.setUint16(4, 20, true);
        cen.setUint16(6, 20, true);
        cen.setUint16(8, 0x0800, true);
        cen.setUint16(10, 0, true);
        cen.setUint16(12, 0, true);
        cen.setUint16(14, 0x21, true);
        cen.setUint32(16, crc, true);
        cen.setUint32(20, data.length, true);
        cen.setUint32(24, data.length, true);
        cen.setUint16(28, nameBytes.length, true);
        cen.setUint32(42, offset, true);
        central.push(cen.buffer, nameBytes);
        cdSize += 46 + nameBytes.length;
        offset += 30 + nameBytes.length + data.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/* ---------- Színpad: kép / gif / videó / hang ---------- */
function makeStage(placeholder, extraClass = '') {
    const root = h('div', { class: 'stage-box ' + extraClass });
    const note = h('div', { class: 'note', text: placeholder });
    root.append(note);
    let node = null, url = null;
    const api = {
        root,
        release() {
            if (node) {
                if (node.tagName === 'VIDEO') { node.pause(); node.removeAttribute('src'); node.load(); }
                node.remove(); node = null;
            }
            if (url) { URL.revokeObjectURL(url); url = null; }
        },
        clear(msg) { api.release(); note.textContent = msg; note.style.display = 'flex'; },
        show(blob, fileName) {
            api.release();
            url = URL.createObjectURL(blob);
            const e = ext(fileName);
            if (IMG_EXT.includes(e)) {
                node = h('img', { src: url, alt: '' });
                node.addEventListener('error', () => {
                    note.textContent = 'Ezt a fájlt nem sikerült megnyitni.'; note.style.display = 'flex';
                });
                note.style.display = 'none';
            } else {
                const audioOnly = e === '.mp3';
                node = h('video', { src: url, loop: true, autoplay: true, playsInline: true });
                node.volume = 0.6;
                if (audioOnly) {
                    node.style.visibility = 'hidden';
                    note.textContent = 'Hang lejátszása folyamatban.';
                    note.style.display = 'flex';
                } else note.style.display = 'none';
                node.addEventListener('error', () => {
                    note.textContent = 'Ezt a fájlt nem sikerült lejátszani.'; note.style.display = 'flex';
                });
                node.play().catch(() => { });
            }
            root.insertBefore(node, note);
        }
    };
    return api;
}

/* ---------- Alkalmazás váz ---------- */
const App = {
    host: $('#app'),
    current: null,
    mount(view, title) {
        this.current?.dispose?.();
        this.current = view;
        this.host.replaceChildren(view.root);
        document.title = title;
    },
    home() {
        const root = h('div', { class: 'view center' },
            h('div', { class: 'card home' },
                h('div', { class: 'bar accent' }),
                h('h1', { text: 'Teleki szimulátor' }),
                h('p', { class: 'muted center-text', text: 'Szerkeszd a történetet, vagy játszd végig.', style: 'margin:8px 0 0' }),
                h('button', { class: 'green big', style: 'margin-top:24px', text: 'Szerkesztő', onclick: () => App.editor() }),
                h('button', { class: 'primary big', style: 'margin-top:12px', text: 'Játék', onclick: () => App.player() })
            ));
        this.mount({ root }, 'Teleki szimulátor');
    },
    editor() { this.mount(new Editor(), 'Teleki szimulátor – szerkesztő'); },
    player() { this.mount(new Player(), 'Teleki szimulátor – játék'); }
};

/* ---------- Játékos ---------- */
class Player {
    constructor() {
        this.scenes = new Map();
        this.dir = null;
        this.started = false;
        this.stage = makeStage('Nincs média.', 'stage-main');
        this.root = h('div', { class: 'view player' });
        this.buildPicker();
    }
    dispose() { this.stage.release(); }

    async buildPicker() {
        this.started = false; this.scenes.clear(); this.dir = null;
        this.stage.release();
        const stories = await DB.list();
        const combo = h('select', {});
        combo.append(h('option', { value: '', text: '' }));
        stories.forEach(s => combo.append(h('option', { value: s.dir, text: s.title })));
        combo.selectedIndex = 0;
        combo.addEventListener('change', () => {
            if (this.started || !combo.value) return;
            const story = stories.find(s => s.dir === combo.value);
            if (!story.scenes.some(sc => sc.id && sc.id.trim())) {
                alert('Ebben a történetben még nincs jelenet.'); combo.selectedIndex = 0; return;
            }
            this.start(story);
        });
        const status = h('div', {
            class: 'picker-status', text: stories.length === 0
                ? 'Még nincs történet. Először a szerkesztőben lehet egyet készíteni.'
                : 'A lista a mentett történeteket mutatja.'
        });
        const card = h('div', { class: 'card picker' },
            h('div', { class: 'bar green' }),
            h('h1', { text: 'Játék' }),
            h('p', {
                class: 'muted center-text', style: 'margin:8px 0 16px',
                text: 'Válassz történetet. Indítás után ezen a körön már nem lehet másikat választani.'
            }),
            combo, status,
            h('button', { class: 'picker-close', text: 'Bezárás', onclick: () => App.home() }));
        this.root.replaceChildren(h('div', { class: 'center' }, card));
    }

    start(story) {
        this.dir = story.dir;
        story.scenes.filter(s => s.id && s.id.trim()).forEach(s => this.scenes.set(s.id, s));
        const startId = this.scenes.has(story.start) ? story.start : story.scenes[0].id;
        this.started = true;
        this.heading = h('div', { class: 'story-heading', text: story.title });
        this.titleEl = h('div', { class: 'scene-title' });
        this.textEl = h('div', { class: 'scene-text' });
        this.choicesEl = h('div', { class: 'choices' });
        const col = h('div', { class: 'stage-col' },
            this.heading, this.stage.root, this.titleEl, this.textEl, this.choicesEl);
        this.root.replaceChildren(
            h('button', { class: 'close', text: 'Bezárás', onclick: () => App.home() }), col);
        this.show(this.scenes.get(startId));
    }

    show(scene) {
        this.titleEl.textContent = (scene.title || '').trim() ? scene.title : 'Jelenet';
        this.textEl.textContent = scene.text || '';
        this.choicesEl.replaceChildren();
        this.showMedia(scene);
        if (!scene.choices || scene.choices.length === 0) {
            this.choicesEl.append(h('button', {
                class: 'primary', text: 'Vissza a történetekhez',
                onclick: () => this.buildPicker()
            }));
            return;
        }
        scene.choices.forEach(c => this.choicesEl.append(h('button', {
            class: 'primary', text: (c.label || '').trim() ? c.label : 'Tovább',
            onclick: () => this.follow(c.next)
        })));
    }
    follow(id) {
        const s = this.scenes.get(id);
        if (s) this.show(s); else alert('Ehhez a választáshoz még nincs jelenet.');
    }
    async showMedia(scene) {
        this.stage.release();
        if (!scene.media) { this.stage.clear('Nincs média.'); return; }
        const blob = await DB.getMedia(this.dir, scene.media);
        if (!blob) { this.stage.clear('A médiafájl nem található.'); return; }
        this.stage.show(blob, scene.media);
    }
}

/* ---------- Szerkesztő ---------- */
class Editor {
    constructor() {
        this.stories = [];
        this.dir = null; this.start = ''; this.savedTitle = '';
        this.scenes = [];
        this.editingId = null; this.picked = null; this.savedMedia = '';
        this.selectedId = null;
        this.dirty = false; this.loading = false;
        this.rows = [];
        this.preview = makeStage('Itt jelenik meg a kiválasztott média.');
        this.build();
        this.init();
    }
    dispose() { this.preview.release(); }

    build() {
        this.storyCombo = h('select', { onchange: () => this.onStoryChange() });
        this.nameBox = h('input', { type: 'text', onblur: () => this.onNameBlur() });
        this.topbar = h('div', { class: 'topbar' },
            h('label', { text: 'Mentett történetek' }), this.storyCombo, h('span'),
            h('label', { text: 'Történet neve' }), this.nameBox, h('span'),
            h('button', { class: 'new', text: 'Új történet', onclick: () => this.newStory() }),
            h('button', { text: 'Bezárás', onclick: () => this.close() }));

        this.listEl = h('div', { class: 'scene-list' });
        this.emptyHint = h('div', { class: 'empty', text: 'Még nincs mentett jelenet.' });
        this.delBtn = h('button', { text: 'Jelenet törlése', disabled: true, onclick: () => this.deleteScene() });
        this.importInput = h('input', {
            type: 'file', multiple: true, webkitdirectory: true, style: 'display:none',
            onchange: e => this.importStory(e.target.files)
        });
        const left = h('div', { class: 'panel' },
            h('h3', { text: 'Jelenetek' }),
            h('div', { style: 'flex:1;position:relative;overflow:hidden;display:flex' },
                this.listEl, this.emptyHint),
            h('div', { class: 'list-actions' },
                h('button', { text: 'Új jelenet', onclick: () => this.newScene() }),
                this.delBtn,
                h('div', { class: 'io-row' },
                    h('button', { text: 'Export', onclick: () => this.exportStory() }),
                    h('button', { text: 'Import (mappa)', onclick: () => this.importInput.click() })),
                h('div', {
                    class: 'hint-small',
                    text: 'A csillag az egyetlen kezdőjelenet, a négyzet egy záró jelenet. A többi szint szerint rendezett.'
                })));
        this.listEl.style.cssText = 'flex:1;overflow:auto';

        // Űrlap
        this.idText = h('div', { class: 'scene-id' });
        this.titleBox = h('input', { type: 'text', oninput: () => this.touch() });
        this.levelBox = h('input', { type: 'text', oninput: () => this.touch() });
        this.endingBox = h('input', { type: 'checkbox', onchange: () => { this.updateLevel(); this.touch(); } });
        this.textBox = h('textarea', { rows: 6, style: 'min-height:110px;margin:4px 0 14px', oninput: () => this.touch() });
        this.mediaName = h('div', { class: 'media-name', text: 'Nincs média' });
        this.mediaInput = h('input', {
            type: 'file', style: 'display:none',
            accept: '.png,.jpg,.jpeg,.bmp,.gif,.mp4,.wmv,.mp3', onchange: e => this.onBrowse(e.target.files[0])
        });
        this.choicesPanel = h('div');
        this.choiceHead = h('div', { class: 'choice-head' },
            h('span', { text: 'Felirat' }), h('span', { text: 'Céljelenet' }), h('span'));
        this.endingHint = h('div', {
            class: 'muted', style: 'margin-bottom:8px',
            text: 'Választás nélkül a lejátszóban nincs tovább gomb. A záró jelenetet a jelölőnégyzet jelöli.'
        });
        this.startBtn = h('button', { text: 'Ez legyen a kezdőjelenet', onclick: () => this.setStart() });

        this.formPanel = h('div', { style: 'display:none' },
            this.idText,
            h('div', { class: 'row2' },
                h('span', { class: 'lbl', text: 'Jelenet címe' }),
                h('span', { class: 'lbl', text: 'Szint', style: 'grid-column:2' }),
                this.titleBox, this.levelBox,
                h('label', { class: 'chk' }, this.endingBox, document.createTextNode('Záró jelenet'))),
            h('div', { text: 'Jelenet szövege' }), this.textBox,
            h('div', { text: 'Média' }),
            h('div', { class: 'media-row' }, this.mediaName,
                h('button', { text: 'Tallózás...', onclick: () => this.mediaInput.click() })),
            this.mediaInput,
            h('div', {
                class: 'muted', style: 'margin:0 0 16px',
                text: 'png vagy jpg kép, gif animáció, mp4 videó vagy mp3 hang. A program a jelenet számával menti, például 1.gif.'
            }),
            h('div', { style: 'font-weight:600', text: 'Választások' }),
            h('div', {
                class: 'muted', style: 'margin:2px 0 8px',
                text: 'A felirat kerül a gombra. A cél egy már elmentett jelenet. Üres cél később is beállítható.'
            }),
            this.choiceHead, this.choicesPanel, this.endingHint,
            h('button', { style: 'margin-top:4px;padding:6px 10px', text: 'Új választás', onclick: () => this.addChoice() }),
            h('div', { class: 'actions' },
                h('button', { class: 'primary', text: 'Jelenet mentése', onclick: () => this.saveScene() }),
                this.startBtn));
        this.placeholder = h('div', {
            class: 'placeholder',
            text: 'A bal oldali lista a mentett jeleneteké. Az Új jelenet gomb megnyitja ezt az adatlapot. Mentés után a jelenet megjelenik a listában, kattintásra pedig újra szerkeszthető.'
        });
        const mid = h('div', { class: 'panel form' }, this.placeholder, this.formPanel);

        this.previewStatus = h('div', { class: 'preview-status', text: 'Nincs kiválasztott média.' });
        const right = h('div', { class: 'panel' },
            h('h3', { text: 'Média előnézet' }),
            h('div', { class: 'preview-wrap' }, this.preview.root),
            this.previewStatus);

        this.statusEl = h('div', { class: 'status', text: 'A történetek a böngésző tárolójába kerülnek.' });
        this.root = h('div', { class: 'view editor' }, this.topbar,
            h('div', { class: 'cols' }, left, mid, right), this.statusEl, this.importInput);
    }

    async init() {
        await this.refreshStories();
        const latest = [...this.stories].sort((a, b) => (b.modified || 0) - (a.modified || 0))[0];
        if (latest) { await this.refreshStories(latest.dir); this.loadStory(latest); }
        else this.setStatus(null);
    }

    setStatus(msg) {
        this.statusEl.textContent = msg || 'A történetek a böngésző tárolójába kerülnek.';
    }
    touch() { if (!this.loading) this.dirty = true; }
    confirmDiscard() { return confirm('Elmentetlen változtatások vannak. Eldobod őket?'); }
    tryLeave() { if (this.dirty && !this.confirmDiscard()) return false; this.preview.release(); return true; }
    close() { if (this.tryLeave()) App.home(); }

    async refreshStories(selectDir) {
        this.stories = await DB.list();
        this.suppressStory = true;
        this.storyCombo.replaceChildren(h('option', { value: '', text: '' }));
        this.stories.forEach(s => this.storyCombo.append(h('option', { value: s.dir, text: s.title })));
        this.storyCombo.value = selectDir || '';
        this.suppressStory = false;
    }

    onStoryChange() {
        if (this.suppressStory) return;
        const dir = this.storyCombo.value;
        if (!dir || dir === this.dir) return;
        if (this.dirty && !this.confirmDiscard()) { this.storyCombo.value = this.dir || ''; return; }
        this.loadStory(this.stories.find(s => s.dir === dir));
    }

    loadStory(story) {
        this.loading = true;
        this.dir = story.dir;
        this.start = story.start || '';
        if (this.start && !story.scenes.some(s => s.id === this.start)) this.start = story.scenes[0]?.id || '';
        this.savedTitle = (story.title || '').trim();
        this.nameBox.value = this.savedTitle;
        this.scenes = story.scenes.map(s => ({ ...s, choices: (s.choices || []).map(c => ({ ...c })) }));
        this.selectedId = null;
        this.sortScenes();
        this.hideForm();
        this.placeholder.textContent = this.scenes.length === 0
            ? 'Ebben a történetben még nincs jelenet. Az Új jelenet gombbal vehetsz fel egyet, vagy törölheted a történetet.'
            : 'Válassz egy jelenetet a listából a módosításhoz, vagy vegyél fel egy újat.';
        this.loading = false; this.dirty = false;
        this.setStatus('Történet megnyitva.');
    }

    newStory() {
        if (this.dirty && !this.confirmDiscard()) return;
        this.suppressStory = true; this.storyCombo.value = ''; this.suppressStory = false;
        this.dir = null; this.start = ''; this.savedTitle = ''; this.scenes = [];
        this.nameBox.value = ''; this.selectedId = null;
        this.hideForm();
        this.placeholder.textContent = 'Új történet. Add meg a nevét felül, majd vedd fel az első jelenetet.';
        this.renderList(); this.setStatus(null); this.nameBox.focus();
    }

    async onNameBlur() {
        if (this.loading || !this.dir) return;
        const title = this.nameBox.value.trim();
        if (!title) { this.nameBox.value = this.savedTitle; return; }
        if (title === this.savedTitle && sanitize(title) === this.dir) return;
        try {
            await this.ensureDir(title);
            await this.saveStoryFile();
            this.savedTitle = title;
            await this.refreshStories(this.dir);
            this.setStatus('A történet neve elmentve.');
        } catch (e) { this.nameBox.value = this.savedTitle; alert(e.message); }
    }

    /* --- jelenetlista --- */
    sortScenes() {
        const rank = s => s.id === this.start ? 0 : s.ending ? 2 : 1;
        const lvl = s => (s.id === this.start || s.ending) ? 0 : s.level;
        this.scenes.sort((a, b) => rank(a) - rank(b) || lvl(a) - lvl(b)
            || (a.title || '').localeCompare(b.title || '', 'hu', { sensitivity: 'base' })
            || (parseInt(a.id) || 1e9) - (parseInt(b.id) || 1e9));
        this.renderList();
    }
    label(s) {
        const t = (s.title || '').trim() ? s.title.replace(/\r?\n/g, ' ') : '(nincs cím)';
        const st = s.id === this.start;
        if (st && s.ending) return '★■' + t;
        if (st) return '★' + t;
        if (s.ending) return '■' + t;
        return s.level + '-' + t;
    }
    updateDelBtn() {
        const emptyStory = !!this.dir && this.scenes.length === 0;
        this.delBtn.textContent = emptyStory ? 'Történet törlése' : 'Jelenet törlése';
        this.delBtn.disabled = emptyStory ? false : !this.selectedId;
    }
    renderList() {
        this.listEl.replaceChildren(...this.scenes.map(s => h('div', {
            class: 'scene-item' + (s.id === this.selectedId ? ' selected' : ''),
            text: this.label(s),
            onclick: () => this.selectScene(s.id)
        })));
        this.emptyHint.style.display = this.scenes.length ? 'none' : 'flex';
        this.updateDelBtn();
    }
    selectScene(id) {
        if (id === this.editingId) { this.selectedId = id; this.renderList(); return; }
        if (this.dirty && !this.confirmDiscard()) return;
        this.selectedId = id;
        this.renderList();
        this.loadScene(this.scenes.find(s => s.id === id));
    }

    newScene() {
        if (this.dirty && !this.confirmDiscard()) return;
        this.selectedId = null; this.renderList();
        this.loading = true;
        this.showForm();
        this.editingId = null; this.picked = null; this.savedMedia = ''; this.dirty = false;
        this.idText.textContent = 'Új jelenet';
        this.titleBox.value = ''; this.endingBox.checked = false;
        const lv = this.scenes.filter(s => !s.ending).map(s => s.level);
        this.levelBox.value = this.scenes.length === 0 ? 0 : (lv.length ? Math.max(...lv) : 0);
        this.updateLevel();
        this.textBox.value = ''; this.mediaName.textContent = 'Nincs média';
        this.clearRows(); this.addChoiceRow('', '');
        this.stopPreview(); this.updateStartBtn();
        this.loading = false; this.titleBox.focus();
    }

    async loadScene(scene) {
        this.loading = true;
        this.showForm();
        this.editingId = scene.id; this.picked = null; this.savedMedia = scene.media || '';
        this.idText.textContent = 'Jelenet száma: ' + scene.id;
        this.titleBox.value = scene.title;
        this.levelBox.value = scene.ending ? '' : scene.level;
        this.endingBox.checked = !!scene.ending;
        this.updateLevel();
        this.textBox.value = scene.text;
        this.mediaName.textContent = scene.media || 'Nincs média';
        this.clearRows();
        scene.choices.forEach(c => this.addChoiceRow(c.label, c.next));
        this.updateHint();
        this.updateStartBtn();
        this.loading = false; this.dirty = false;
        await this.playStored(scene.media);
    }

    showForm() { this.placeholder.style.display = 'none'; this.formPanel.style.display = 'block'; }
    hideForm() {
        this.loading = true;
        this.editingId = null; this.picked = null; this.savedMedia = ''; this.dirty = false;
        this.clearRows(); this.stopPreview();
        this.formPanel.style.display = 'none'; this.placeholder.style.display = 'block';
        this.updateStartBtn(); this.renderList();
        this.loading = false;
    }

    /* --- szint / kezdőjelenet --- */
    skipLevel() {
        const cur = this.editingId != null && this.editingId === this.start;
        const first = this.editingId == null && !this.start;
        return this.endingBox.checked || cur || first;
    }
    updateLevel() {
        const skip = this.skipLevel();
        this.levelBox.disabled = skip;
        if (skip) this.levelBox.value = '';
    }
    updateStartBtn() {
        const isCur = this.editingId != null && this.editingId === this.start;
        this.startBtn.disabled = !(this.editingId != null && this.dir && !isCur);
        this.startBtn.textContent = isCur ? 'Ez a kezdőjelenet' : 'Ez legyen a kezdőjelenet';
        this.updateLevel();
    }
    async setStart() {
        if (this.editingId == null || !this.dir) {
            alert('Először mentsd a jelenetet. Az első mentett jelenet automatikusan a kezdő.'); return;
        }
        this.start = this.editingId;
        this.sortScenes(); await this.saveStoryFile();
        this.refreshTargets(); this.updateStartBtn();
        this.setStatus('Kezdőjelenet beállítva.');
    }

    /* --- választások --- */
    addChoice() { const r = this.addChoiceRow('', ''); this.dirty = true; r.lab.focus(); }
    addChoiceRow(label, next) {
        const lab = h('input', { type: 'text', value: label || '', oninput: () => this.touch() });
        const sel = h('select', { onchange: () => this.touch() });
        this.fillTargets(sel, next);
        const row = { lab, sel };
        row.el = h('div', { class: 'choice-row' }, lab, sel,
            h('button', {
                text: 'Elvesz', onclick: () => {
                    row.el.remove(); this.rows = this.rows.filter(r => r !== row); this.updateHint(); this.touch();
                }
            }));
        this.choicesPanel.append(row.el);
        this.rows.push(row); this.updateHint();
        return row;
    }
    clearRows() { this.rows = []; this.choicesPanel.replaceChildren(); this.updateHint(); }
    updateHint() {
        const has = this.rows.length > 0;
        this.endingHint.style.display = has ? 'none' : 'block';
        this.choiceHead.style.display = has ? 'grid' : 'none';
    }
    fillTargets(sel, selected) {
        sel.replaceChildren(h('option', { value: '', text: '— nincs —' }),
            ...this.scenes.map(s => h('option', { value: s.id, text: this.label(s) })));
        sel.value = this.scenes.some(s => s.id === selected) ? selected : '';
    }
    refreshTargets() { this.rows.forEach(r => this.fillTargets(r.sel, r.sel.value)); }
    readChoices() {
        const out = [];
        for (const r of this.rows) {
            const label = r.lab.value.trim(); let next = r.sel.value;
            if (!label && !next) continue;
            if (!label) { alert('Minden választásnak kell egy felirat.'); r.lab.focus(); return null; }
            if (next && !this.scenes.some(s => s.id === next)) next = '';
            out.push({ label, next });
        }
        return out;
    }

    /* --- média --- */
    onBrowse(file) {
        if (!file) return;
        if (![...IMG_EXT, '.mp4', '.wmv', '.mp3'].includes(ext(file.name))) { alert('Nem támogatott fájltípus.'); return; }
        this.picked = file;
        this.mediaName.textContent = file.name;
        this.preview.show(file, file.name);
        this.previewStatus.textContent = file.name;
        this.dirty = true;
        this.mediaInput.value = '';
    }
    async playStored(fileName) {
        if (!fileName || !this.dir) { this.stopPreview(); return; }
        const blob = await DB.getMedia(this.dir, fileName);
        if (blob) { this.preview.show(blob, fileName); this.previewStatus.textContent = fileName; }
        else this.stopPreview();
    }
    stopPreview() {
        this.preview.clear('Itt jelenik meg a kiválasztott média.');
        this.previewStatus.textContent = 'Nincs kiválasztott média.';
    }

    /* --- mentés --- */
    nextId() {
        return String(1 + Math.max(0, ...this.scenes.map(s => parseInt(s.id)).filter(n => !isNaN(n))));
    }
    async ensureDir(title) {
        const desired = sanitize(title);
        if (!this.dir) {
            if (await DB.get(desired)) throw new Error('Ezen a néven már van történet. Nyisd meg a mentett történetek listájából.');
            this.dir = desired;
            await DB.put({ dir: desired, title, start: this.start, scenes: this.scenes, modified: Date.now() });
            return;
        }
        if (desired === this.dir) return;
        if (await DB.get(desired)) throw new Error('Ezen a néven már van másik történet.');
        this.preview.release();
        await DB.moveStory(this.dir, desired, { title, start: this.start, scenes: this.scenes, modified: Date.now() });
        this.dir = desired;
    }
    async saveStoryFile() {
        if (!this.dir) return;
        await DB.put({
            dir: this.dir, title: this.nameBox.value.trim(), start: this.start,
            scenes: JSON.parse(JSON.stringify(this.scenes)), modified: Date.now()
        });
    }

    async saveScene() {
        const title = this.nameBox.value.trim();
        if (!title) { alert('Add meg a történet nevét felül.'); this.nameBox.focus(); return; }
        const sceneTitle = this.titleBox.value.trim();
        if (!sceneTitle) { alert('Add meg a jelenet címét. Ez jelenik meg a bal oldali listában.'); this.titleBox.focus(); return; }
        const ending = this.endingBox.checked;
        let level = 0;
        if (!this.skipLevel()) {
            const t = this.levelBox.value.trim();
            level = /^\d+$/.test(t) ? parseInt(t) : NaN;
            if (isNaN(level)) { alert('A szint egy nulla vagy nagyobb egész szám legyen, például 0, 1 vagy 2.'); this.levelBox.focus(); return; }
        }
        const text = this.textBox.value.trim();
        if (!text) { alert('A jelenet szövegét add meg.'); this.textBox.focus(); return; }
        const choices = this.readChoices();
        if (!choices) return;

        const isNew = this.editingId == null;
        const id = this.editingId ?? this.nextId();
        const prevMedia = this.savedMedia;
        let scene = null;
        try {
            await this.ensureDir(title);
            let mediaFile = this.savedMedia;
            if (this.picked) {
                this.preview.release();
                mediaFile = id + ext(this.picked.name);
                await DB.putMedia(this.dir, mediaFile, this.picked);
            }
            if (isNew) {
                scene = { id, title: sceneTitle, level, ending, text, media: mediaFile, choices };
                this.scenes.push(scene);
                if (!this.start) this.start = id;
            } else {
                scene = this.scenes.find(s => s.id === id);
                Object.assign(scene, { title: sceneTitle, level, ending, text, media: mediaFile, choices });
            }
            this.selectedId = id;
            this.sortScenes();
            await this.saveStoryFile();
            if (prevMedia && prevMedia !== mediaFile) await DB.delMedia(this.dir, prevMedia);

            this.editingId = id; this.savedMedia = mediaFile;
            this.picked = null; this.savedTitle = title; this.dirty = false;
            this.idText.textContent = 'Jelenet száma: ' + id;
            this.mediaName.textContent = mediaFile || 'Nincs média';
            this.updateStartBtn(); this.refreshTargets(); this.renderList();
            await this.playStored(mediaFile);
            await this.refreshStories(this.dir);
            this.setStatus(isNew ? 'Új jelenet elmentve.' : 'Jelenet módosítva.');
        } catch (e) {
            if (isNew && scene) {
                this.scenes = this.scenes.filter(s => s !== scene);
                if (this.start === scene.id) this.start = this.scenes[0]?.id || '';
                this.sortScenes();
            }
            alert('A mentés nem sikerült.\n\n' + e.message);
        }
    }

    async deleteScene() {
        if (this.dir && this.scenes.length === 0) { await this.deleteStory(); return; }
        const scene = this.scenes.find(s => s.id === this.selectedId);
        if (!scene || !this.dir) return;
        if (!confirm('Törlöd ezt a jelenetet?\n\n' + this.label(scene) + '\n\nA rá mutató választások célja üres lesz.')) return;
        try {
            this.preview.release();
            await DB.delMedia(this.dir, scene.media);
            this.scenes.forEach(o => o.choices.forEach(c => { if (c.next === scene.id) c.next = ''; }));
            this.scenes = this.scenes.filter(s => s !== scene);
            if (this.start === scene.id) this.start = this.scenes[0]?.id || '';
            this.selectedId = null;
            this.sortScenes(); await this.saveStoryFile();
            this.hideForm();
            this.placeholder.textContent = this.scenes.length === 0
                ? 'Ebben a történetben még nincs jelenet. Az Új jelenet gombbal vehetsz fel egyet, vagy törölheted a történetet.'
                : 'Válassz egy jelenetet a listából a módosításhoz, vagy vegyél fel egy újat.';
            this.setStatus('Jelenet törölve.');
        } catch (e) { alert('A törlés nem sikerült.\n\n' + e.message); }
    }

    async deleteStory() {
        const title = this.nameBox.value.trim() || this.dir;
        if (!confirm('Törlöd ezt a történetet?\n\n' + title + '\n\nA történet és minden hozzá tartozó fájl törlődik.')) return;
        try {
            this.preview.release();
            await DB.remove(this.dir);
            this.dir = null; this.start = ''; this.savedTitle = '';
            this.scenes = []; this.selectedId = null; this.dirty = false;
            this.nameBox.value = '';
            await this.refreshStories();
            const next = this.stories[0];
            if (next) {
                await this.refreshStories(next.dir);
                this.loadStory(next);
            } else {
                this.hideForm();
                this.placeholder.textContent = 'Nincs mentett történet. Az Új történet gombbal készíthetsz egyet.';
                this.renderList();
            }
            this.setStatus('Történet törölve.');
        } catch (e) { alert('A törlés nem sikerült.\n\n' + e.message); }
    }

    /* --- export / import (Stories/<név>/story.json + media/) --- */
    async exportStory() {
        if (!this.dir) { alert('Nincs megnyitott történet.'); return; }
        if (this.dirty && !this.confirmDiscard()) return;
        const story = await DB.get(this.dir);
        const json = JSON.stringify({
            title: story.title,
            start: story.start || '',
            scenes: story.scenes.map(s => ({
                id: s.id, title: s.title, level: s.level, ending: !!s.ending,
                text: s.text, media: s.media || '',
                choices: s.choices.map(c => ({ label: c.label, next: c.next }))
            }))
        }, null, 2);
        const enc = new TextEncoder();
        const entries = [{ name: `${this.dir}/story.json`, data: enc.encode(json) }];
        const seen = new Set();
        for (const s of story.scenes) {
            if (!s.media || seen.has(s.media)) continue;
            seen.add(s.media);
            const blob = await DB.getMedia(this.dir, s.media);
            if (blob) entries.push({ name: `${this.dir}/media/${s.media}`, data: new Uint8Array(await blob.arrayBuffer()) });
        }
        const a = h('a', { href: URL.createObjectURL(makeZip(entries)), download: this.dir + '.zip' });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        this.setStatus('Exportálva. A zip tartalmát a projekt Stories mappájába kell kicsomagolni.');
    }

    async importStory(fileList) {
        const files = [...(fileList || [])];
        this.importInput.value = '';
        if (!files.length) return;
        const jsonFile = files.find(f => f.name.toLowerCase() === 'story.json');
        if (!jsonFile) { alert('Válaszd ki a történet mappáját (benne a story.json és a media mappa).'); return; }
        if (this.dirty && !this.confirmDiscard()) return;
        try {
            const d = JSON.parse(await jsonFile.text());
            const story = {
                title: (d.title ?? '').trim(),
                start: d.start ?? '',
                scenes: (d.scenes ?? []).map(s => ({
                    id: s.id ?? '', title: s.title ?? '', level: Number(s.level) || 0, ending: !!s.ending,
                    text: s.text ?? '', media: (s.media ?? '').split(/[\\/]/).pop(),
                    choices: (s.choices ?? []).map(c => ({ label: c.label ?? '', next: c.next ?? '' }))
                }))
            };
            const rel = jsonFile.webkitRelativePath || '';
            const folder = rel.includes('/') ? rel.split('/')[0] : '';
            if (!story.title) story.title = folder || 'Importált történet';
            let dir = sanitize(folder || story.title);
            while (await DB.get(dir)) dir += '_uj';

            await DB.put({ dir, ...story, modified: Date.now() });
            const allowed = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.mp4', '.wmv', '.mp3'];
            for (const f of files) {
                if (f === jsonFile || !allowed.includes(ext(f.name))) continue;
                await DB.putMedia(dir, f.name, f);
            }
            await this.refreshStories(dir);
            this.loadStory(await DB.get(dir));
            this.setStatus('Történet importálva.');
        } catch (e) { alert('Az importálás nem sikerült.\n\n' + e.message); }
    }
}

/* ---------- Indítás ---------- */
DB.open().then(() => App.home());
window.addEventListener('beforeunload', e => {
    if (App.current instanceof Editor && App.current.dirty) { e.preventDefault(); e.returnValue = ''; }
});