// ---------------------------------------------------------------------------
// Transport layer.
//
// Two interchangeable backends behind one interface so the game engines never
// know or care which is running:
//
//   FirebaseTransport - Realtime Database. Phones act as controllers, host
//                       screen casts to a TV, state is shared and persistent.
//   LocalTransport    - localStorage + BroadcastChannel. Single device (or
//                       several tabs on one device). No account needed.
//
// Interface:
//   await t.init()
//   await t.get(path)                -> value | null
//   await t.set(path, value)
//   await t.update(path, partial)
//   await t.remove(path)
//   t.subscribe(path, cb)            -> unsubscribe fn
//   await t.onDisconnectRemove(path)
//   t.mode                           -> 'firebase' | 'local'
// ---------------------------------------------------------------------------

import { FIREBASE_CONFIG, FIREBASE_SDK, FIREBASE_READY } from './config.js';

/* ------------------------------ Firebase -------------------------------- */

class FirebaseTransport {
  constructor() {
    this.mode = 'firebase';
  }

  async init() {
    const [appMod, dbMod, authMod] = await Promise.all([
      import(`${FIREBASE_SDK}/firebase-app.js`),
      import(`${FIREBASE_SDK}/firebase-database.js`),
      import(`${FIREBASE_SDK}/firebase-auth.js`)
    ]);
    this.fb = dbMod;
    this.app = appMod.initializeApp(FIREBASE_CONFIG);
    this.db = dbMod.getDatabase(this.app);

    // Anonymous sign-in. The database rules require auth != null, which keeps
    // random scanners that find the database URL out of the data. If you have
    // not switched Anonymous on in the Firebase console this throws, and the
    // app falls back to local mode rather than failing silently on every write.
    const auth = authMod.getAuth(this.app);
    await authMod.signInAnonymously(auth);
    this.uid = auth.currentUser ? auth.currentUser.uid : null;

    // Firebase's own connectivity flag; screens show a banner when it drops.
    this.connected = true;
    this._connCbs = [];
    dbMod.onValue(dbMod.ref(this.db, '.info/connected'), snap => {
      this.connected = Boolean(snap.val());
      for (const cb of this._connCbs) { try { cb(this.connected); } catch {} }
    });
    return this;
  }

  onConnection(cb) { this._connCbs.push(cb); cb(this.connected); return () => { this._connCbs = this._connCbs.filter(f => f !== cb); }; }

  _ref(path) {
    return this.fb.ref(this.db, path);
  }

  async get(path) {
    const snap = await this.fb.get(this._ref(path));
    return snap.exists() ? snap.val() : null;
  }

  async set(path, value) {
    return this.fb.set(this._ref(path), value);
  }

  async update(path, partial) {
    return this.fb.update(this._ref(path), partial);
  }

  async remove(path) {
    return this.fb.remove(this._ref(path));
  }

  subscribe(path, cb) {
    return this.fb.onValue(this._ref(path), snap => {
      cb(snap.exists() ? snap.val() : null);
    });
  }

  async onDisconnectRemove(path) {
    try {
      await this.fb.onDisconnect(this._ref(path)).remove();
    } catch (e) {
      console.warn('onDisconnect registration failed', e);
    }
  }

  async onDisconnectSet(path, value) {
    try {
      await this.fb.onDisconnect(this._ref(path)).set(value);
    } catch (e) {
      console.warn('onDisconnect registration failed', e);
    }
  }
}

/* -------------------------------- Local --------------------------------- */

const LOCAL_KEY = 'pg_db_v1';

function splitPath(path) {
  return String(path).split('/').filter(Boolean);
}

function readAt(root, parts) {
  let node = root;
  for (const p of parts) {
    if (node === null || typeof node !== 'object') return null;
    node = node[p];
    if (node === undefined) return null;
  }
  return node === undefined ? null : node;
}

function writeAt(root, parts, value) {
  if (parts.length === 0) return value === null ? {} : value;
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (node[p] === null || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  const last = parts[parts.length - 1];
  if (value === null) delete node[last];
  else node[last] = value;
  return root;
}

class LocalTransport {
  constructor() {
    this.mode = 'local';
    this.subs = [];
    try {
      this.channel = new BroadcastChannel('partygames');
      this.channel.onmessage = () => this._fanout();
    } catch {
      this.channel = null;
    }
    // Catch writes from other tabs even without BroadcastChannel.
    window.addEventListener('storage', e => {
      if (e.key === LOCAL_KEY) this._fanout();
    });
  }

  async init() {
    return this;
  }

  _read() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
    } catch {
      return {};
    }
  }

  _write(root) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(root));
    if (this.channel) {
      try { this.channel.postMessage({ t: Date.now() }); } catch {}
    }
    this._fanout();
  }

  _fanout() {
    const root = this._read();
    for (const s of this.subs) {
      const val = readAt(root, s.parts);
      const json = JSON.stringify(val);
      if (json !== s.last) {
        s.last = json;
        try { s.cb(val); } catch (e) { console.error(e); }
      }
    }
  }

  async get(path) {
    return readAt(this._read(), splitPath(path));
  }

  async set(path, value) {
    const root = this._read();
    this._write(writeAt(root, splitPath(path), value));
  }

  async update(path, partial) {
    const root = this._read();
    const parts = splitPath(path);
    const existing = readAt(root, parts);
    const merged = (existing && typeof existing === 'object')
      ? { ...existing, ...partial }
      : { ...partial };
    this._write(writeAt(root, parts, merged));
  }

  async remove(path) {
    const root = this._read();
    this._write(writeAt(root, splitPath(path), null));
  }

  subscribe(path, cb) {
    const sub = { parts: splitPath(path), cb, last: undefined };
    this.subs.push(sub);
    // Fire immediately with current value, matching Firebase onValue semantics.
    const val = readAt(this._read(), sub.parts);
    sub.last = JSON.stringify(val);
    queueMicrotask(() => cb(val));
    return () => {
      this.subs = this.subs.filter(s => s !== sub);
    };
  }

  async onDisconnectRemove() { /* no-op: single device */ }
  async onDisconnectSet()    { /* no-op: single device */ }
  onConnection(cb) { cb(true); return () => {}; }
}

/* ------------------------------- Factory -------------------------------- */

let _instance = null;

export async function getTransport() {
  if (_instance) return _instance;

  if (FIREBASE_READY) {
    try {
      _instance = await new FirebaseTransport().init();
      return _instance;
    } catch (e) {
      console.error('Firebase init failed, falling back to local mode.', e);
    }
  }
  _instance = await new LocalTransport().init();
  return _instance;
}

export { FirebaseTransport, LocalTransport };
