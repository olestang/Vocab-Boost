/*
  Train easter egg
  ----------------
  Requires no libraries. Intended for static sites / GitHub Pages.

  Call this after a correct answer:
    window.TrainEasterEgg?.maybeTrigger();

  Configuration is read from the existing global CONFIG object:
    CONFIG.trainEasterEggProbability

  Example: 0.001 = 0.1% chance per correct answer (about 1 in 1,000).

  Add ?train=1 to the URL to force the animation on the next correct answer
  while testing.
*/

(() => {
  'use strict';

  const DEFAULTS = {
    probability: 0.001,
    speedPxPerSecond: 430,
    trainWidthPx: 150,
    edgeInsetPx: 34,
    assetPath: 'train-easter-egg.svg',
    zIndex: 9999,
  };

  let active = false;

  function getProbability() {
    const configured = typeof CONFIG !== 'undefined'
      ? Number(CONFIG.trainEasterEggProbability)
      : DEFAULTS.probability;

    if (!Number.isFinite(configured)) return DEFAULTS.probability;
    return Math.min(1, Math.max(0, configured));
  }

  function shouldRun() {
    const params = new URLSearchParams(window.location.search);

    // Convenient deterministic test switch. With ?train=1, the next correct
    // answer always triggers the train.
    if (params.get('train') === '1') return true;

    // Respect the visitor's OS/browser reduced-motion preference.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;

    return Math.random() < getProbability();
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function angleDegrees(a, b) {
    return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  }

  function createTrain() {
    const train = document.createElement('img');
    train.src = DEFAULTS.assetPath;
    train.alt = '';
    train.setAttribute('aria-hidden', 'true');

    Object.assign(train.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${DEFAULTS.trainWidthPx}px`,
      height: 'auto',
      maxWidth: 'none',
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: String(DEFAULTS.zIndex),
      willChange: 'transform',
      transformOrigin: '50% 50%',
      filter: 'drop-shadow(0 5px 5px rgba(0, 0, 0, 0.18))',
    });

    document.body.appendChild(train);
    return train;
  }

  function buildRoute() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const margin = DEFAULTS.trainWidthPx * 0.8;
    const inset = Math.min(DEFAULTS.edgeInsetPx, Math.max(12, height * 0.06));

    // Direction changes happen just outside the viewport, so the train exits
    // one edge and naturally re-enters on the next leg of the route.
    return [
      { x: width + margin, y: height - inset },
      { x: -margin,        y: height - inset },
      { x: width + margin, y: inset },
      { x: -margin,        y: inset },
      { x: -margin,        y: height + margin },
    ];
  }

  async function animateRoute(train, points) {
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i];
      const to = points[i + 1];
      const angle = angleDegrees(from, to);
      const duration = Math.max(
        250,
        distance(from, to) / DEFAULTS.speedPxPerSecond * 1000,
      );

      const fromTransform = `translate(${from.x}px, ${from.y}px) translate(-50%, -50%) rotate(${angle}deg)`;
      const toTransform = `translate(${to.x}px, ${to.y}px) translate(-50%, -50%) rotate(${angle}deg)`;

      const animation = train.animate(
        [
          { transform: fromTransform },
          { transform: toTransform },
        ],
        {
          duration,
          easing: 'linear',
          fill: 'forwards',
        },
      );

      try {
        await animation.finished;
      } catch {
        return;
      }
    }
  }

  async function run() {
    if (active) return;
    active = true;

    const train = createTrain();
    const route = buildRoute();

    try {
      await animateRoute(train, route);
    } finally {
      train.remove();
      active = false;
    }
  }

  function maybeTrigger() {
    if (active || !shouldRun()) return false;
    void run();
    return true;
  }

  // Public API used by app.js. Nothing is triggered automatically on load.
  window.TrainEasterEgg = Object.freeze({
    maybeTrigger,
    run, // Handy for console testing without changing probability.
  });
})();
