// ---------------------------------------------------------------------------
// Firebase config.
//
// Paste the config object from your Firebase console here (Project settings ->
// General -> Your apps -> Web app -> SDK setup and configuration -> Config).
//
// This is NOT a secret. Firebase web config is a public identifier and is meant
// to ship in client code. Access is controlled by the rules in
// firebase-rules.json, not by hiding these values.
//
// Leave it blank and the app runs in LOCAL mode: single-device pass-and-play,
// state kept in this browser only. Fill it in and phones become controllers.
// ---------------------------------------------------------------------------

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDTT_Ny1BEGrvlvxbzKLdfP2LRVYGUCKLM",
  authDomain: "k-games-111e9.firebaseapp.com",
  databaseURL: "https://k-games-111e9-default-rtdb.firebaseio.com",
  projectId: "k-games-111e9",
  storageBucket: "k-games-111e9.firebasestorage.app",
  messagingSenderId: "96723769942",
  appId: "1:96723769942:web:21a4676b9b63e1403eb9f7"
};

export const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/13.1.0";

// databaseURL is the one field the Realtime Database genuinely needs.
export const FIREBASE_READY = Boolean(
  FIREBASE_CONFIG.databaseURL && FIREBASE_CONFIG.apiKey
);

// Tunables
export const ROOM_TTL_MS      = 1000 * 60 * 60 * 6;  // rooms self-expire after 6h
export const ROOM_CODE_CHARS  = "ACDEFGHJKMNPQRTUVWXY349";  // no O/0, I/1, S/5, B/8
export const ROOM_CODE_LEN    = 4;
