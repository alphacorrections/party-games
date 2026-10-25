// ---------------------------------------------------------------------------
// A 3D die, built from six real faces so the tumble is a genuine rotation,
// not a sprite flip. Pips are laid out on a 3x3 grid per face.
//
//   const d = mountDie(container)
//   await d.roll(4)        -> tumbles for ~1.4s and settles with 4 facing you
//   d.idle()               -> gentle hover while waiting
// ---------------------------------------------------------------------------

import { reducedMotion } from './fx.js';

// Which 3x3 cells are filled for each value.
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8]
};

// Rotation that brings each face value to the front. Face layout:
//   front=1  back=6  right=3  left=4  top=2  bottom=5   (opposites sum to 7)
const FACE_ROT = {
  1: [0, 0],
  6: [0, 180],
  3: [0, -90],
  4: [0, 90],
  2: [-90, 0],
  5: [90, 0]
};

function face(value, cls) {
  const cells = Array.from({ length: 9 }, (_, i) =>
    `<i class="${PIPS[value].includes(i) ? 'pip' : ''}"></i>`).join('');
  return `<div class="dface ${cls}">${cells}</div>`;
}

export function dieHTML() {
  return `
    <div class="dscene">
      <div class="die">
        ${face(1, 'f-front')}${face(6, 'f-back')}
        ${face(3, 'f-right')}${face(4, 'f-left')}
        ${face(2, 'f-top')}${face(5, 'f-bottom')}
      </div>
      <div class="dshadow"></div>
    </div>`;
}

export function mountDie(container) {
  container.innerHTML = dieHTML();
  const die = container.querySelector('.die');
  const scene = container.querySelector('.dscene');
  let spins = 0;

  function set(rx, ry, extraTurns = 0) {
    // Add whole extra turns so the tumble always travels, even when the new
    // face is adjacent to the old one.
    const tx = rx + 360 * extraTurns;
    const ty = ry + 360 * extraTurns;
    die.style.transform = `rotateX(${tx}deg) rotateY(${ty}deg)`;
  }

  return {
    idle() {
      scene.classList.add('idle');
      scene.classList.remove('rolling', 'landed');
    },

    roll(value) {
      return new Promise(resolve => {
        const [rx, ry] = FACE_ROT[value] || FACE_ROT[1];
        scene.classList.remove('idle', 'landed');
        if (reducedMotion()) {
          die.style.transition = 'none';
          set(rx, ry, 0);
          scene.classList.add('landed');
          return resolve();
        }
        spins += 2 + Math.floor(Math.random() * 2);
        scene.classList.add('rolling');
        die.style.transition = 'transform 1.4s cubic-bezier(.17,.84,.44,1)';
        // Start from a slightly random pose so successive rolls differ.
        requestAnimationFrame(() => set(rx, ry, spins));
        const done = () => {
          die.removeEventListener('transitionend', done);
          scene.classList.remove('rolling');
          scene.classList.add('landed');
          resolve();
        };
        die.addEventListener('transitionend', done);
        setTimeout(done, 1600);   // belt and braces if transitionend never fires
      });
    }
  };
}
