/*
  Vocational English trainer
  --------------------------
  Content lives in vocabulary.json. Keep vocabulary IDs stable after release,
  because localStorage progress is keyed by those IDs.

  Vocabulary conventions:
  - english: canonical English answer shown to pupils.
  - norwegian: canonical Norwegian answer shown to pupils.
  - acceptedEnglish / acceptedNorwegian: additional accepted answers, hidden from normal UI.
  - confusions: explicit common mistakes. These are checked BEFORE generic typo detection.
  - definition: enables English-only questions at higher mastery.
  - example: shown as context/hint/feedback.
  - registerPair: optional everyday/professional-language pair.
  - questions: optional richer context questions. Supported types: fillBlank, naturalSentence.
*/

const CONFIG = {
  storageKey: 'vocationalEnglishTrainer',
  schemaVersion: 1,
  sessionSize: 20,
  masteryThreshold: 4,
  contextUnlockRatio: 0.8,
  rescueAfterWrongCount: 2,
  wrongRepeatMinGap: 3,
  wrongRepeatMaxGap: 7,
  maxRequeuesPerWord: 3,
  submitLockAfterErrorMs: 750,
  timedAccuracyThreshold: 0.9,
  fiveMinuteMs: 5 * 60 * 1000,
  rareCelebrationProbability: 0.025,
  reviewIntervalsDays: [1, 3, 7, 14, 30],
  audioQuestionChance: 0.15,
};

let CONTENT = null;
let WORDS_BY_ID = new Map();
let MODULES_BY_ID = new Map();
let ALL_ENGLISH_ANSWERS = new Map();
let STORE = null;
let SESSION = null;
let CURRENT_QUESTION = null;
let ANSWER_LOCKED = false;
let tickTimer = null;

const params = new URLSearchParams(window.location.search);
const CLASSROOM_MODE = params.get('classroom') === 'true';

if (CLASSROOM_MODE) document.body.classList.add('classroom-mode');

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('keydown', handleGlobalKeydown);

async function init() {
  try {
    const response = await fetch('vocabulary.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    CONTENT = await response.json();
    indexContent();
    STORE = loadStore();
    ensureContentState();
    saveStore();

    const challengeId = params.get('challenge');
    if (challengeId) {
      const challenge = CONTENT.challenges?.[challengeId];
      if (challenge) {
        startChallenge(challengeId);
        return;
      }
      renderMessage(
        'Ukjent utfordring',
        `Fant ikke utfordringen «${challengeId}».`,
        'Til forsiden'
      );
      return;
    }

    renderHome();
  } catch (error) {
    console.error(error);
    document.getElementById('app').innerHTML = `
      <section class="app-card p-4 p-md-5">
        <h1 class="h3 mb-3">Kunne ikke laste innholdet</h1>
        <p class="text-secondary mb-0">Prøv å laste siden på nytt. Hvis du åpnet <code>index.html</code> direkte fra filsystemet, bruk VS Code Live Server eller GitHub Pages i stedet.</p>
      </section>`;
  }
}

function indexContent() {
  WORDS_BY_ID = new Map((CONTENT.words || []).map(word => [word.id, word]));
  MODULES_BY_ID = new Map((CONTENT.modules || []).map(module => [module.id, module]));
  ALL_ENGLISH_ANSWERS = new Map();

  for (const word of CONTENT.words || []) {
    const candidates = unique([word.english, ...(word.acceptedEnglish || [])]);
    for (const candidate of candidates) {
      ALL_ENGLISH_ANSWERS.set(normalize(candidate), word.id);
    }
  }
}

// ---------- Storage ----------

function defaultStore() {
  return {
    schemaVersion: CONFIG.schemaVersion,
    settings: {
      soundEnabled: true,
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false,
    },
    words: {},
    modules: {},
    starredWords: [],
    activity: {},
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw);
    return migrateStore(parsed);
  } catch (error) {
    console.warn('Could not read localStorage. Using a fresh session.', error);
    return defaultStore();
  }
}

function migrateStore(data) {
  if (!data || typeof data !== 'object') return defaultStore();
  const base = defaultStore();
  return {
    ...base,
    ...data,
    schemaVersion: CONFIG.schemaVersion,
    settings: { ...base.settings, ...(data.settings || {}) },
    words: data.words && typeof data.words === 'object' ? data.words : {},
    modules: data.modules && typeof data.modules === 'object' ? data.modules : {},
    starredWords: Array.isArray(data.starredWords) ? data.starredWords : [],
    activity: data.activity && typeof data.activity === 'object' ? data.activity : {},
  };
}

function saveStore() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(STORE));
  } catch (error) {
    console.warn('Could not save progress.', error);
  }
}

function ensureContentState() {
  for (const word of CONTENT.words || []) getWordState(word.id);
  for (const module of CONTENT.modules || []) getModuleState(module.id);
  STORE.starredWords = STORE.starredWords.filter(id => WORDS_BY_ID.has(id));
}

function getWordState(wordId) {
  if (!STORE.words[wordId]) {
    STORE.words[wordId] = {
      mastery: 0,
      status: 'new',
      correctCount: 0,
      wrongCount: 0,
      firstAttemptCorrectCount: 0,
      typoCount: 0,
      hintCount: 0,
      revealCount: 0,
      lastSeen: null,
      lastCorrect: null,
      reviewStage: 0,
      nextReview: null,
    };
  }
  return STORE.words[wordId];
}

function getModuleState(moduleId) {
  if (!STORE.modules[moduleId]) {
    STORE.modules[moduleId] = {
      started: false,
      completed: false,
      completedAt: null,
      bestTimeMs: null,
      bestAccuracy: null,
    };
  }
  return STORE.modules[moduleId];
}

// ---------- Home ----------

function renderHome() {
  clearTickTimer();
  document.getElementById('app').className = 'container app-shell py-4 py-md-5';
  SESSION = null;
  CURRENT_QUESTION = null;

  const app = document.getElementById('app');
  const startedModules = CONTENT.modules.filter(m => getModuleState(m.id).started);
  const attemptedWords = CONTENT.words.filter(w => {
    const s = getWordState(w.id);
    return s.correctCount + s.wrongCount + s.revealCount > 0;
  });
  const starredCount = STORE.starredWords.length;

  app.innerHTML = `
    <header class="d-flex align-items-center gap-3 mb-4 mb-md-5">
      <img src="logo.svg" width="58" height="58" alt="" class="rounded-3">
      <div>
        <div class="small-caps text-secondary">Lukas VGS · VG1 Helse og oppvekst</div>
        <h1 class="h2 mb-0">Vocational English</h1>
      </div>
    </header>

    <section class="mb-4 mb-md-5">
      <div class="d-flex justify-content-between align-items-end mb-3">
        <div>
          <h2 class="h5 mb-1">Hurtigøving</h2>
          <p class="text-secondary small mb-0">Velg en kort økt, eller fortsett i en modul.</p>
        </div>
        <button class="btn btn-sm btn-outline-secondary personal-only" id="settingsBtn">Innstillinger</button>
      </div>

      <div class="row g-3">
        <div class="col-12 col-md-6 col-xl-3">
          <button class="btn btn-primary w-100 quick-action p-3" data-action="five-minute">
            <strong class="d-block">5 min øving</strong>
            <span class="small opacity-75">Ny + vanskelig + repetisjon</span>
          </button>
        </div>
        <div class="col-12 col-md-6 col-xl-3">
          <button class="btn btn-outline-primary w-100 quick-action p-3" data-action="weakest" ${attemptedWords.length ? '' : 'disabled'}>
            <strong class="d-block">Mine vanskelige ord</strong>
            <span class="small text-secondary">De svakeste ordene akkurat nå</span>
          </button>
        </div>
        <div class="col-12 col-md-6 col-xl-3">
          <button class="btn btn-outline-primary w-100 quick-action p-3" data-action="mixed" ${startedModules.length >= 2 ? '' : 'disabled'}>
            <strong class="d-block">Blandet øving</strong>
            <span class="small text-secondary">Ord fra flere temaer</span>
          </button>
        </div>
        <div class="col-12 col-md-6 col-xl-3 personal-only">
          <button class="btn btn-outline-primary w-100 quick-action p-3" data-action="starred" ${starredCount ? '' : 'disabled'}>
            <strong class="d-block">Mine ord ★</strong>
            <span class="small text-secondary">${starredCount} ${starredCount === 1 ? 'ord' : 'ord'}</span>
          </button>
        </div>
      </div>
    </section>

    <section>
      <h2 class="h5 mb-3">Temaer</h2>
      <div class="row g-3" id="moduleGrid">
        ${CONTENT.modules.map(renderModuleCard).join('')}
      </div>
    </section>

    <footer class="mt-5 pt-3 border-top text-secondary small d-flex flex-wrap justify-content-between gap-2">
      <span>Framgangen lagres bare på denne enheten.</span>
      <span>Enter = svar/neste · H = hint</span>
    </footer>`;

  app.querySelector('[data-action="five-minute"]').addEventListener('click', startFiveMinute);
  app.querySelector('[data-action="weakest"]').addEventListener('click', startWeakest);
  app.querySelector('[data-action="mixed"]').addEventListener('click', startMixed);
  app.querySelector('[data-action="starred"]')?.addEventListener('click', startStarred);
  app.querySelector('#settingsBtn')?.addEventListener('click', renderSettings);

  app.querySelectorAll('[data-module-start]').forEach(button => {
    button.addEventListener('click', () => startModule(button.dataset.moduleStart, 'standard'));
  });
  app.querySelectorAll('[data-module-review]').forEach(button => {
    button.addEventListener('click', () => startModule(button.dataset.moduleReview, 'review'));
  });
  app.querySelectorAll('[data-module-timed]').forEach(button => {
    button.addEventListener('click', () => startModule(button.dataset.moduleTimed, 'timed'));
  });
  app.querySelectorAll('[data-module-context]').forEach(button => {
    button.addEventListener('click', () => startModule(button.dataset.moduleContext, 'context'));
  });
}

function renderModuleCard(module) {
  const words = wordsForModule(module.id);
  const learned = words.filter(w => isLearned(w.id)).length;
  const due = words.filter(w => isDue(w.id)).length;
  const ratio = words.length ? learned / words.length : 0;
  const moduleState = getModuleState(module.id);
  const pct = Math.round(ratio * 100);
  const primaryLabel = moduleState.started ? 'Fortsett' : 'Start';
  const status = moduleState.completed
    ? `✓ Fullført${due ? ` · ${due} klare for repetisjon` : ''}`
    : moduleState.started ? 'Påbegynt' : 'Ikke startet';
  const best = moduleState.bestTimeMs ? `Beste tid: ${formatDuration(moduleState.bestTimeMs)}` : '';

  return `
    <div class="col-12 col-md-6">
      <article class="app-card module-card h-100 p-4" style="--module-accent:${escapeAttr(module.accent || '#0d6efd')}">
        <div class="d-flex justify-content-between gap-3 align-items-start mb-3">
          <div>
            <div class="small-caps text-secondary">${escapeHtml(module.titleEn)}</div>
            <h3 class="h4 mb-1">${escapeHtml(module.titleNo)}</h3>
            <div class="small text-secondary">${escapeHtml(status)}</div>
          </div>
          <div class="fw-semibold">${learned} / ${words.length}</div>
        </div>
        <div class="progress mb-3" role="progressbar" aria-label="Framgang" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar" style="width:${pct}%; background:${escapeAttr(module.accent || '#0d6efd')}"></div>
        </div>
        <p class="small text-secondary mb-3">${escapeHtml(module.description || '')}</p>
        ${best ? `<div class="small text-secondary mb-3 personal-only">${escapeHtml(best)}</div>` : ''}
        <div class="d-flex flex-wrap gap-2">
          ${due && moduleState.completed
            ? `<button class="btn btn-primary" data-module-review="${escapeAttr(module.id)}">Repeter</button>`
            : `<button class="btn btn-primary" data-module-start="${escapeAttr(module.id)}">${primaryLabel}</button>`}
          ${ratio >= CONFIG.contextUnlockRatio
            ? `<button class="btn btn-outline-secondary" data-module-context="${escapeAttr(module.id)}">I kontekst</button>` : ''}
          ${ratio >= CONFIG.contextUnlockRatio
            ? `<button class="btn btn-outline-secondary personal-only" data-module-timed="${escapeAttr(module.id)}">Tidsmodus</button>` : ''}
        </div>
      </article>
    </div>`;
}

function renderSettings() {
  clearTickTimer();
  document.getElementById('app').className = 'container app-shell py-4 py-md-5';
  const soundChecked = STORE.settings.soundEnabled ? 'checked' : '';
  document.getElementById('app').innerHTML = `
    <section class="app-card p-4 p-md-5">
      <button class="btn btn-sm btn-outline-secondary mb-4" id="settingsBack">← Tilbake</button>
      <h1 class="h3 mb-4">Innstillinger</h1>

      <div class="form-check form-switch mb-4">
        <input class="form-check-input" type="checkbox" role="switch" id="soundToggle" ${soundChecked}>
        <label class="form-check-label" for="soundToggle">Tillat lydknapp</label>
      </div>

      <div class="border-top pt-4">
        <h2 class="h5">Lokal framgang</h2>
        <p class="text-secondary">Alt lagres i nettleserens localStorage på denne enheten.</p>
        <button class="btn btn-outline-danger" id="resetProgress">Nullstill framgang</button>
      </div>
    </section>`;

  document.getElementById('settingsBack').addEventListener('click', renderHome);
  document.getElementById('soundToggle').addEventListener('change', event => {
    STORE.settings.soundEnabled = event.target.checked;
    saveStore();
  });
  document.getElementById('resetProgress').addEventListener('click', () => {
    if (!window.confirm('Vil du nullstille all framgang på denne enheten?')) return;
    STORE = defaultStore();
    ensureContentState();
    saveStore();
    renderHome();
  });
}

// ---------- Session creation ----------

function startModule(moduleId, mode = 'standard') {
  const module = MODULES_BY_ID.get(moduleId);
  if (!module) return;

  const moduleState = getModuleState(moduleId);
  moduleState.started = true;
  saveStore();

  let candidates = wordsForModule(moduleId);
  if (mode === 'review') candidates = candidates.filter(w => isDue(w.id));

  const selected = selectWeightedWords(candidates, Math.min(CONFIG.sessionSize, candidates.length), {
    includeLearned: mode !== 'review',
  });

  if (!selected.length) {
    renderMessage('Ingen ord klare', 'Det er ingen ord klare for denne økten akkurat nå.', 'Til forsiden');
    return;
  }

  beginSession({
    title: module.titleNo,
    mode,
    moduleIds: [moduleId],
    words: selected,
    timed: mode === 'timed',
  });
}

function startFiveMinute() {
  const startedIds = CONTENT.modules.filter(m => getModuleState(m.id).started).map(m => m.id);
  const pool = startedIds.length
    ? CONTENT.words.filter(w => startedIds.includes(w.module))
    : CONTENT.words;
  const selected = selectWeightedWords(pool, Math.min(CONFIG.sessionSize, pool.length));
  beginSession({
    title: '5 min øving',
    mode: 'fiveMinute',
    moduleIds: unique(selected.map(w => w.module)),
    words: selected,
    timeLimitMs: CONFIG.fiveMinuteMs,
  });
}

function startWeakest() {
  const attempted = CONTENT.words.filter(w => {
    const s = getWordState(w.id);
    return s.correctCount + s.wrongCount + s.revealCount > 0;
  });
  const selected = [...attempted]
    .sort((a, b) => weaknessScore(b.id) - weaknessScore(a.id))
    .slice(0, 10);
  if (!selected.length) return renderHome();
  beginSession({
    title: 'Mine vanskelige ord',
    mode: 'weakest',
    moduleIds: unique(selected.map(w => w.module)),
    words: shuffle(selected),
  });
}

function startMixed() {
  const startedIds = CONTENT.modules.filter(m => getModuleState(m.id).started).map(m => m.id);
  const pool = CONTENT.words.filter(w => startedIds.includes(w.module));
  const selected = selectWeightedWords(pool, Math.min(CONFIG.sessionSize, pool.length));
  beginSession({
    title: 'Blandet øving',
    mode: 'mixed',
    moduleIds: startedIds,
    words: selected,
  });
}

function startStarred() {
  const pool = STORE.starredWords.map(id => WORDS_BY_ID.get(id)).filter(Boolean);
  const selected = selectWeightedWords(pool, Math.min(CONFIG.sessionSize, pool.length));
  if (!selected.length) return renderHome();
  beginSession({
    title: 'Mine ord ★',
    mode: 'starred',
    moduleIds: unique(selected.map(w => w.module)),
    words: selected,
  });
}

function startChallenge(challengeId) {
  const challenge = CONTENT.challenges[challengeId];
  const words = (challenge.words || []).map(id => WORDS_BY_ID.get(id)).filter(Boolean);
  if (!words.length) {
    renderMessage('Tom utfordring', 'Denne utfordringen inneholder ingen gyldige ord.', 'Til forsiden');
    return;
  }
  for (const moduleId of unique(words.map(w => w.module))) getModuleState(moduleId).started = true;
  saveStore();
  beginSession({
    title: challenge.title || 'Dagens utfordring',
    mode: challenge.mode || 'challenge',
    moduleIds: unique(words.map(w => w.module)),
    words: shuffle(words).slice(0, challenge.questionCount || words.length),
  });
}

function beginSession({ title, mode, moduleIds, words, timeLimitMs = null, timed = false }) {
  clearTickTimer();
  const now = Date.now();
  const queue = words.map(word => ({ wordId: word.id, repeat: false }));

  SESSION = {
    title,
    mode,
    moduleIds,
    queue,
    originalCount: queue.length,
    originalCompleted: 0,
    attempts: [],
    recentResults: [],
    wordWrongCounts: {},
    requeueCounts: {},
    usedWordIds: new Set(),
    startedAt: now,
    endAt: timeLimitMs ? now + timeLimitMs : null,
    timed: timed || mode === 'timed',
    awaitingNext: false,
    currentEntry: null,
    currentAttemptUsedHint: false,
    failedWordIds: new Set(),
    primaryAttempts: 0,
    primaryCorrect: 0,
  };

  renderNextQuestion();
  if (SESSION.endAt || SESSION.timed) tickTimer = setInterval(updateTimerLabel, 1000);
}

function selectWeightedWords(pool, count) {
  const available = [...pool];
  const selected = [];

  while (available.length && selected.length < count) {
    const weights = available.map(word => wordPriority(word.id));
    const index = weightedIndex(weights);
    selected.push(available.splice(index, 1)[0]);
  }
  return shuffle(selected);
}

function weightedIndex(weights) {
  const total = weights.reduce((sum, n) => sum + Math.max(0.01, n), 0);
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= Math.max(0.01, weights[i]);
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

function wordPriority(wordId) {
  const s = getWordState(wordId);
  let score = 1;
  score += Math.max(0, CONFIG.masteryThreshold - s.mastery) * 2.2;
  score += Math.min(8, s.wrongCount * 0.7);
  score += s.revealCount * 0.8;
  if (isDue(wordId)) score += 6;
  if (s.status === 'new') score += 2;
  if (STORE.starredWords.includes(wordId)) score += 1.5;
  return score;
}

function weaknessScore(wordId) {
  const s = getWordState(wordId);
  const daysSinceCorrect = s.lastCorrect
    ? Math.min(30, (Date.now() - new Date(s.lastCorrect).getTime()) / 86400000)
    : 10;
  return (s.wrongCount * 3) + (s.revealCount * 3) + s.hintCount + daysSinceCorrect - (s.correctCount * 0.7) - (s.mastery * 2);
}

// ---------- Questions ----------

function renderNextQuestion() {
  if (!SESSION) return;

  if (SESSION.endAt && Date.now() >= SESSION.endAt && SESSION.attempts.length > 0) {
    finishSession();
    return;
  }

  if (SESSION.mode === 'fiveMinute' && SESSION.queue.length < 5 && Date.now() < SESSION.endAt) {
    refillFiveMinuteQueue();
  }

  const entry = SESSION.queue.shift();
  if (!entry) {
    finishSession();
    return;
  }

  SESSION.currentEntry = entry;
  SESSION.awaitingNext = false;
  SESSION.currentAttemptUsedHint = false;
  ANSWER_LOCKED = false;

  CURRENT_QUESTION = buildQuestion(entry.wordId);
  renderTrainer();
}

function refillFiveMinuteQueue() {
  const startedIds = CONTENT.modules.filter(m => getModuleState(m.id).started).map(m => m.id);
  const pool = startedIds.length ? CONTENT.words.filter(w => startedIds.includes(w.module)) : CONTENT.words;
  const next = selectWeightedWords(pool, Math.min(10, pool.length));
  SESSION.queue.push(...next.map(word => ({ wordId: word.id, repeat: true })));
}

function buildQuestion(wordId) {
  const word = WORDS_BY_ID.get(wordId);
  const state = getWordState(wordId);
  const wrongThisSession = SESSION.wordWrongCounts[wordId] || 0;

  if (wrongThisSession >= CONFIG.rescueAfterWrongCount && SESSION.mode !== 'context') {
    return buildRescueQuestion(word);
  }

  if (SESSION.mode === 'context') return buildContextQuestion(word);

  if ('speechSynthesis' in window && STORE.settings.soundEnabled && state.mastery >= 2 && Math.random() < CONFIG.audioQuestionChance) {
    return {
      type: 'typed',
      direction: 'audio-en',
      wordId,
      prompt: '🔊 Lytt og skriv det du hører',
      context: 'Trykk på lydknappen hvis du vil høre uttrykket igjen.',
      answers: englishAnswers(word),
      canonicalAnswer: word.english,
      audioText: word.english,
      autoPlayAudio: true,
    };
  }

  if (state.mastery >= 3 && word.definition && Math.random() < 0.32) {
    return {
      type: 'typed',
      direction: 'definition-en',
      wordId,
      prompt: word.definition,
      context: 'Skriv det engelske ordet eller uttrykket.',
      answers: englishAnswers(word),
      canonicalAnswer: word.english,
      audioText: word.english,
    };
  }

  const reverseChance = state.mastery >= 2 ? 0.35 : 0.2;
  if (Math.random() < reverseChance) {
    return {
      type: 'typed',
      direction: 'en-no',
      wordId,
      prompt: word.english,
      context: word.example || '',
      answers: norwegianAnswers(word),
      canonicalAnswer: word.norwegian,
      audioText: word.english,
    };
  }

  return {
    type: 'typed',
    direction: 'no-en',
    wordId,
    prompt: word.norwegian,
    context: '',
    answers: englishAnswers(word),
    canonicalAnswer: word.english,
    audioText: word.english,
  };
}

function buildContextQuestion(word) {
  const custom = Array.isArray(word.questions) && word.questions.length
    ? sample(word.questions)
    : null;

  if (custom?.type === 'fillBlank') {
    return {
      type: 'typed',
      direction: 'context-en',
      wordId: word.id,
      prompt: custom.prompt,
      context: custom.instruction || 'Fyll inn riktig engelsk ord eller uttrykk.',
      answers: unique([custom.answer || word.english, ...(custom.accepted || [])]),
      canonicalAnswer: custom.answer || word.english,
      audioText: custom.prompt.replace(/_+/g, word.english),
    };
  }

  if (custom?.type === 'naturalSentence') {
    return {
      type: 'choice',
      direction: 'context-choice',
      wordId: word.id,
      prompt: custom.prompt || 'Hvilken setning høres mest naturlig ut?',
      context: custom.instruction || '',
      options: custom.options,
      correctIndex: custom.correct,
      canonicalAnswer: custom.options[custom.correct],
      audioText: word.english,
    };
  }

  return {
    type: 'typed',
    direction: 'definition-en',
    wordId: word.id,
    prompt: word.definition || word.norwegian,
    context: 'Svar på engelsk.',
    answers: englishAnswers(word),
    canonicalAnswer: word.english,
    audioText: word.english,
  };
}

function buildRescueQuestion(word) {
  const moduleWords = wordsForModule(word.module).filter(w => w.id !== word.id);
  const distractors = shuffle(moduleWords).slice(0, 3).map(w => w.english);
  const options = shuffle(unique([word.english, ...distractors])).slice(0, 4);
  if (!options.includes(word.english)) options[0] = word.english;
  return {
    type: 'choice',
    direction: 'rescue',
    wordId: word.id,
    prompt: word.norwegian,
    context: 'Velg riktig engelsk svar.',
    options: shuffle(options),
    canonicalAnswer: word.english,
    correctIndex: null,
    audioText: word.english,
  };
}

function renderTrainer() {
  const word = WORDS_BY_ID.get(CURRENT_QUESTION.wordId);
  const module = MODULES_BY_ID.get(word.module);
  const progress = SESSION.originalCount ? Math.round((SESSION.originalCompleted / SESSION.originalCount) * 100) : 0;
  const starred = STORE.starredWords.includes(word.id);
  const canSpeak = 'speechSynthesis' in window && STORE.settings.soundEnabled && CURRENT_QUESTION.audioText;

  document.getElementById('app').className = 'container trainer-shell py-4 py-md-5';
  document.getElementById('app').innerHTML = `
    <section>
      <div class="d-flex justify-content-between align-items-center gap-3 mb-3">
        <button class="btn btn-sm btn-outline-secondary" id="homeBtn">← Forsiden</button>
        <div class="text-end">
          <div class="small-caps text-secondary">${escapeHtml(SESSION.title)}</div>
          <div class="small text-secondary" id="timerLabel">${sessionStatusLabel()}</div>
        </div>
      </div>

      <div class="progress mb-2" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar" style="width:${progress}%; background:${escapeAttr(module?.accent || '#0d6efd')}"></div>
      </div>
      <div class="d-flex justify-content-between align-items-center mb-4">
        <span class="small text-secondary">${SESSION.originalCompleted} / ${SESSION.originalCount}</span>
        <div class="last-five d-flex gap-2" aria-label="Siste fem svar">${renderLastFive()}</div>
      </div>

      <article class="app-card p-4 p-md-5">
        <div class="d-flex justify-content-between align-items-start gap-3 mb-4">
          <span class="badge text-bg-light border">${escapeHtml(questionLabel(CURRENT_QUESTION))}</span>
          <div class="d-flex gap-2">
            ${canSpeak ? `<button class="btn btn-outline-secondary star-btn" id="speakBtn" aria-label="Hør engelsk">🔊</button>` : ''}
            <button class="btn btn-outline-secondary star-btn personal-only" id="starBtn" aria-label="${starred ? 'Fjern fra Mine ord' : 'Legg til i Mine ord'}" title="${starred ? 'I Mine ord' : 'Legg til i Mine ord'}">${starred ? '★' : '☆'}</button>
          </div>
        </div>

        <div class="question-prompt mb-3">${escapeHtml(CURRENT_QUESTION.prompt)}</div>
        ${CURRENT_QUESTION.context ? `<div class="question-context mb-4">${escapeHtml(CURRENT_QUESTION.context)}</div>` : '<div class="mb-4"></div>'}

        <div id="answerArea">${renderAnswerArea(CURRENT_QUESTION)}</div>

        <div id="feedback" class="mt-4" aria-live="assertive"></div>

        <div class="d-flex flex-wrap justify-content-between gap-2 mt-4" id="supportControls">
          <div class="d-flex flex-wrap gap-2">
            <button class="btn btn-sm btn-outline-secondary" id="hintBtn">Hint <span class="kbd-hint"><kbd>H</kbd></span></button>
            <button class="btn btn-sm btn-outline-secondary" id="revealBtn">Jeg vet ikke</button>
          </div>
          <span class="small text-secondary align-self-center personal-only">${escapeHtml(module?.titleNo || '')}</span>
        </div>
      </article>
    </section>`;

  document.getElementById('homeBtn').addEventListener('click', () => {
    if (SESSION?.attempts.length && !window.confirm('Avslutte denne økten og gå til forsiden? Framgangen du allerede har gjort er lagret.')) return;
    renderHome();
  });
  document.getElementById('speakBtn')?.addEventListener('click', () => speak(CURRENT_QUESTION.audioText));
  document.getElementById('starBtn')?.addEventListener('click', toggleCurrentStar);
  document.getElementById('hintBtn').addEventListener('click', showHint);
  document.getElementById('revealBtn').addEventListener('click', revealAnswer);

  if (CURRENT_QUESTION.type === 'typed') {
    const input = document.getElementById('answerInput');
    document.getElementById('submitBtn').addEventListener('click', handlePrimaryButton);
    setTimeout(() => input?.focus(), 0);
  } else {
    document.querySelectorAll('[data-choice-index]').forEach(button => {
      button.addEventListener('click', () => handleChoice(Number(button.dataset.choiceIndex)));
    });
  }

  if (CURRENT_QUESTION.autoPlayAudio) setTimeout(() => speak(CURRENT_QUESTION.audioText), 250);
}

function renderAnswerArea(question) {
  if (question.type === 'choice') {
    return `
      <div class="d-grid gap-2" id="choiceArea">
        ${question.options.map((option, index) => `
          <button class="btn btn-outline-primary choice-btn p-3" data-choice-index="${index}">${escapeHtml(option)}</button>
        `).join('')}
      </div>`;
  }

  return `
    <label for="answerInput" class="visually-hidden">Svar</label>
    <input id="answerInput" class="form-control answer-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Skriv svar …">
    <div class="d-grid mt-3">
      <button id="submitBtn" class="btn btn-primary btn-lg">Sjekk</button>
    </div>`;
}

function handlePrimaryButton() {
  if (!SESSION || ANSWER_LOCKED) return;
  if (SESSION.awaitingNext) {
    renderNextQuestion();
    return;
  }
  const input = document.getElementById('answerInput');
  const entered = input?.value || '';
  if (!normalize(entered)) {
    input?.focus();
    input?.classList.add('is-invalid');
    setTimeout(() => input?.classList.remove('is-invalid'), 600);
    return;
  }
  submitTypedAnswer(entered);
}

function submitTypedAnswer(entered) {
  const classification = classifyAnswer(CURRENT_QUESTION, entered);
  const isCorrect = ['exact', 'acceptedAlternative', 'likelyTypo'].includes(classification.type);
  recordAttempt({
    entered,
    classification: classification.type,
    correct: isCorrect,
    feedback: classification.feedback || null,
  });

  if (isCorrect) showCorrectFeedback(classification, entered);
  else showWrongFeedback(classification);
}

function handleChoice(index) {
  if (!SESSION || SESSION.awaitingNext || ANSWER_LOCKED) return;
  const question = CURRENT_QUESTION;
  const selected = question.options[index];
  const correct = question.direction === 'rescue'
    ? selected === question.canonicalAnswer
    : index === question.correctIndex;

  recordAttempt({
    entered: selected,
    classification: correct ? 'exact' : 'wrongWord',
    correct,
    feedback: null,
  });

  document.querySelectorAll('[data-choice-index]').forEach(button => button.disabled = true);
  if (correct) showCorrectFeedback({ type: 'exact' }, selected);
  else showWrongFeedback({ type: 'wrongWord' });
}

function classifyAnswer(question, enteredRaw) {
  const entered = normalize(enteredRaw);
  const answers = question.answers || [question.canonicalAnswer];
  const normalizedAnswers = answers.map(normalize);
  const canonical = normalize(question.canonicalAnswer);

  if (entered === canonical) return { type: 'exact' };
  if (normalizedAnswers.includes(entered)) return { type: 'acceptedAlternative' };

  const word = WORDS_BY_ID.get(question.wordId);
  if (question.direction !== 'en-no') {
    const confusion = (word.confusions || []).find(c => normalize(c.answer) === entered);
    if (confusion) return { type: 'knownConfusion', feedback: confusion.feedback };

    if (ALL_ENGLISH_ANSWERS.has(entered) && ALL_ENGLISH_ANSWERS.get(entered) !== word.id) {
      return { type: 'wrongWord' };
    }
  }

  const typoCandidate = bestTypoMatch(entered, normalizedAnswers);
  if (typoCandidate.isLikelyTypo) {
    return {
      type: 'likelyTypo',
      corrected: answers[typoCandidate.index],
      feedback: typoCandidate.feedback,
    };
  }

  return { type: 'wrongWord' };
}

function bestTypoMatch(entered, normalizedAnswers) {
  let best = { score: -Infinity, index: 0, distance: Infinity };

  normalizedAnswers.forEach((answer, index) => {
    if (!answer || !entered) return;
    const distance = damerauLevenshtein(entered, answer);
    const maxLen = Math.max(entered.length, answer.length);
    const normalizedDistance = distance / maxLen;
    let score = 0;

    if (distance === 1) score += 5;
    else if (distance === 2 && maxLen >= 8) score += 2.5;
    if (isAdjacentTransposition(entered, answer)) score += 3;
    if (Math.abs(entered.length - answer.length) === 1) score += 1.5;
    if (entered[0] === answer[0]) score += 0.7;
    if (entered.at(-1) === answer.at(-1)) score += 0.7;
    if (normalizedDistance <= 0.12) score += 2;
    else if (normalizedDistance <= 0.2) score += 1;
    if (maxLen <= 4) score -= 3;
    if (maxLen <= 6 && distance > 1) score -= 2;

    if (score > best.score) best = { score, index, distance };
  });

  const answer = normalizedAnswers[best.index] || '';
  const likely = best.score >= 4.5 && best.distance <= (answer.length >= 8 ? 2 : 1);
  let feedback = null;
  if (likely) {
    if (best.distance === 1 && Math.abs(entered.length - answer.length) === 1) feedback = 'Det ser ut som én bokstav mangler eller er ekstra.';
    else if (isAdjacentTransposition(entered, answer)) feedback = 'To bokstaver ser ut til å ha byttet plass.';
    else feedback = 'Dette ser ut som en liten stavefeil.';
  }

  return { isLikelyTypo: likely, index: best.index, feedback };
}

function recordAttempt({ entered, classification, correct, feedback }) {
  const word = WORDS_BY_ID.get(CURRENT_QUESTION.wordId);
  const state = getWordState(word.id);
  const entry = SESSION.currentEntry;
  const nowIso = new Date().toISOString();

  state.lastSeen = nowIso;
  if (SESSION.currentAttemptUsedHint) state.hintCount += 1;

  const attempt = {
    wordId: word.id,
    questionType: CURRENT_QUESTION.type,
    direction: CURRENT_QUESTION.direction,
    entered,
    classification,
    correct,
    usedHint: SESSION.currentAttemptUsedHint,
    repeat: !!entry.repeat,
    timestamp: nowIso,
    feedback,
  };
  SESSION.attempts.push(attempt);
  SESSION.recentResults.push(classification === 'likelyTypo' ? 'typo' : correct ? 'ok' : 'bad');
  SESSION.recentResults = SESSION.recentResults.slice(-5);

  if (!entry.repeat) {
    SESSION.originalCompleted += 1;
    SESSION.primaryAttempts += 1;
    if (correct) SESSION.primaryCorrect += 1;
  }

  if (correct) {
    applyCorrectResult(word.id, classification, CURRENT_QUESTION.direction);
    SESSION.wordWrongCounts[word.id] = 0;
  } else {
    applyWrongResult(word.id, classification);
    SESSION.failedWordIds.add(word.id);
    SESSION.wordWrongCounts[word.id] = (SESSION.wordWrongCounts[word.id] || 0) + 1;
    requeueWord(word.id);
  }

  updateActivity(1);
  updateModuleCompletion(word.module);
  saveStore();
  SESSION.awaitingNext = true;
}

function applyCorrectResult(wordId, classification, direction) {
  const state = getWordState(wordId);
  const wasLearned = state.mastery >= CONFIG.masteryThreshold;
  let gain = 1;

  if (classification === 'likelyTypo') gain = 0.5;
  if (SESSION.currentAttemptUsedHint) gain = Math.min(gain, 0.5);
  if (direction === 'rescue') gain = Math.min(gain, 0.25);
  if (direction === 'context-en' || direction === 'context-choice' || direction === 'definition-en') gain = Math.min(gain, 0.75);

  state.correctCount += 1;
  if (!SESSION.currentAttemptUsedHint && classification !== 'likelyTypo' && direction !== 'rescue') {
    state.firstAttemptCorrectCount += 1;
  }
  if (classification === 'likelyTypo') state.typoCount += 1;
  state.mastery = Math.min(CONFIG.masteryThreshold, roundHalf(state.mastery + gain));
  state.status = state.mastery >= CONFIG.masteryThreshold ? 'learned' : state.mastery > 0 ? 'learning' : 'new';
  state.lastCorrect = new Date().toISOString();

  if (!wasLearned && state.mastery >= CONFIG.masteryThreshold) {
    state.reviewStage = 0;
    state.nextReview = futureIso(CONFIG.reviewIntervalsDays[0]);
  } else if (wasLearned && isDue(wordId)) {
    state.reviewStage = Math.min(CONFIG.reviewIntervalsDays.length - 1, state.reviewStage + 1);
    state.nextReview = futureIso(CONFIG.reviewIntervalsDays[state.reviewStage]);
  }
}

function applyWrongResult(wordId, classification) {
  const state = getWordState(wordId);
  state.wrongCount += 1;
  if (classification === 'revealed') state.revealCount += 1;

  if (state.mastery >= CONFIG.masteryThreshold) {
    state.reviewStage = Math.max(0, state.reviewStage - 1);
    state.nextReview = futureIso(1);
  }
}

function requeueWord(wordId) {
  SESSION.requeueCounts[wordId] = SESSION.requeueCounts[wordId] || 0;
  if (SESSION.mode !== 'fiveMinute' && SESSION.requeueCounts[wordId] >= CONFIG.maxRequeuesPerWord) return;
  SESSION.requeueCounts[wordId] += 1;
  const gap = randomInt(CONFIG.wrongRepeatMinGap, CONFIG.wrongRepeatMaxGap);
  const insertAt = Math.min(gap, SESSION.queue.length);
  SESSION.queue.splice(insertAt, 0, { wordId, repeat: true });
}

function revealAnswer() {
  if (!SESSION || SESSION.awaitingNext || ANSWER_LOCKED) return;
  recordAttempt({
    entered: '',
    classification: 'revealed',
    correct: false,
    feedback: null,
  });
  const word = WORDS_BY_ID.get(CURRENT_QUESTION.wordId);
  renderFeedback('wrong', `
    <div class="fw-semibold mb-1">Riktig svar</div>
    <div class="fs-5">${escapeHtml(CURRENT_QUESTION.canonicalAnswer)}</div>
    ${word.example ? `<div class="small text-secondary mt-2">${escapeHtml(word.example)}</div>` : ''}
  `);
  prepareNextButton(true);
}

function showHint() {
  if (!SESSION || SESSION.awaitingNext) return;
  SESSION.currentAttemptUsedHint = true;
  const word = WORDS_BY_ID.get(CURRENT_QUESTION.wordId);
  let hint = word.definition || word.example || `Første bokstav: ${CURRENT_QUESTION.canonicalAnswer.charAt(0)}`;

  if (CURRENT_QUESTION.direction === 'en-no') hint = word.example || `Tenk på hvordan ordet brukes i en arbeidssituasjon.`;
  renderFeedback('info', `<strong>Hint:</strong> ${escapeHtml(hint)}`);
  document.getElementById('answerInput')?.focus();
}

function showCorrectFeedback(classification, entered) {
  const word = WORDS_BY_ID.get(CURRENT_QUESTION.wordId);
  let body = `<div class="fw-semibold fs-5">✓ Riktig</div>`;

  if (classification.type === 'likelyTypo') {
    body = ` 
    <div class="p-3 rounded" style="background-color: #fff3cd;">
      <div class="fw-semibold fs-5">✓ Riktig ord</div> 
      <div class="mt-1">
        Staving: <strong>${escapeHtml(classification.corrected || CURRENT_QUESTION.canonicalAnswer)}</strong>
      </div> 
      ${classification.feedback 
        ? `<div class="small text-secondary mt-1">${escapeHtml(classification.feedback)}</div>` 
        : ''}
    </div>`; 
  }

  if (word.registerPair) {
    body += `<div class="small text-secondary mt-2">Everyday: <strong>${escapeHtml(word.registerPair.everyday)}</strong> · Professional: <strong>${escapeHtml(word.registerPair.professional)}</strong></div>`;
  }

  if (Math.random() < CONFIG.rareCelebrationProbability && !STORE.settings.reducedMotion) {
    body += `<div class="celebration mt-2">🩺 Diagnosis: excellent vocabulary.</div>`;
  }

  renderFeedback('correct', body);
  prepareNextButton(false);
}

function showWrongFeedback(classification) {
  const word = WORDS_BY_ID.get(CURRENT_QUESTION.wordId);
  let body = `<div class="fw-semibold mb-1">Ikke helt.</div>`;

  if (classification.type === 'knownConfusion' && classification.feedback) {
    body += `<div>${escapeHtml(classification.feedback)}</div>`;
  }

  body += `<div class="mt-2">Riktig svar: <strong>${escapeHtml(CURRENT_QUESTION.canonicalAnswer)}</strong></div>`;
  if (word.example) body += `<div class="small text-secondary mt-2">${escapeHtml(word.example)}</div>`;

  renderFeedback('wrong', body);
  prepareNextButton(true);
}

function prepareNextButton(lockBriefly) {
  document.getElementById('hintBtn').disabled = true;
  document.getElementById('revealBtn').disabled = true;
  document.getElementById('answerInput')?.setAttribute('disabled', 'disabled');

  const submit = document.getElementById('submitBtn');
  if (submit) {
    submit.textContent = 'Neste';
    submit.disabled = !!lockBriefly;
  } else {
    const area = document.getElementById('answerArea');
    area.insertAdjacentHTML('beforeend', `<div class="d-grid mt-3"><button class="btn btn-primary btn-lg" id="nextChoiceBtn" ${lockBriefly ? 'disabled' : ''}>Neste</button></div>`);
    document.getElementById('nextChoiceBtn').addEventListener('click', renderNextQuestion);
  }

  if (lockBriefly) {
    ANSWER_LOCKED = true;
    setTimeout(() => {
      ANSWER_LOCKED = false;
      const button = document.getElementById('submitBtn') || document.getElementById('nextChoiceBtn');
      if (button) button.disabled = false;
    }, CONFIG.submitLockAfterErrorMs);
  }
}

function renderFeedback(type, html) {
  const feedback = document.getElementById('feedback');
  if (!feedback) return;
  feedback.className = `feedback-box p-3 feedback-${type}`;
  feedback.innerHTML = html;
}

function toggleCurrentStar() {
  const id = CURRENT_QUESTION?.wordId;
  if (!id) return;
  const index = STORE.starredWords.indexOf(id);
  if (index >= 0) STORE.starredWords.splice(index, 1);
  else STORE.starredWords.push(id);
  saveStore();

  const button = document.getElementById('starBtn');
  const starred = STORE.starredWords.includes(id);
  if (button) {
    button.textContent = starred ? '★' : '☆';
    button.title = starred ? 'I Mine ord' : 'Legg til i Mine ord';
    button.setAttribute('aria-label', starred ? 'Fjern fra Mine ord' : 'Legg til i Mine ord');
  }
}

// ---------- Session finish / recap ----------

function finishSession() {
  clearTickTimer();
  if (!SESSION) return;

  const elapsed = Date.now() - SESSION.startedAt;
  const accuracy = SESSION.primaryAttempts ? SESSION.primaryCorrect / SESSION.primaryAttempts : 0;

  if (SESSION.timed && SESSION.moduleIds.length === 1) {
    const moduleState = getModuleState(SESSION.moduleIds[0]);
    moduleState.bestAccuracy = Math.max(moduleState.bestAccuracy || 0, accuracy);
    if (accuracy >= CONFIG.timedAccuracyThreshold) {
      if (!moduleState.bestTimeMs || elapsed < moduleState.bestTimeMs) moduleState.bestTimeMs = elapsed;
    }
  }

  updateActivity(0, elapsed);
  saveStore();
  renderRecap(elapsed, accuracy);
}

function renderRecap(elapsed, accuracy) {
  const exact = SESSION.attempts.filter(a => ['exact', 'acceptedAlternative'].includes(a.classification)).length;
  const typos = SESSION.attempts.filter(a => a.classification === 'likelyTypo').length;
  const wrong = SESSION.attempts.filter(a => ['wrongWord', 'knownConfusion', 'revealed'].includes(a.classification)).length;
  const uniqueWords = new Set(SESSION.attempts.map(a => a.wordId)).size;
  const firstAttemptPct = Math.round(accuracy * 100);
  const failedIds = [...SESSION.failedWordIds];
  const message = recapMessage({ typos, wrong, accuracy });

  let timedRecord = '';
  if (SESSION.timed && SESSION.moduleIds.length === 1) {
    const moduleState = getModuleState(SESSION.moduleIds[0]);
    timedRecord = accuracy >= CONFIG.timedAccuracyThreshold
      ? `<p class="mb-1"><strong>Tid:</strong> ${formatDuration(elapsed)}</p><p class="small text-secondary">Rekord krever minst ${Math.round(CONFIG.timedAccuracyThreshold * 100)} % på første forsøk. Beste tid: ${moduleState.bestTimeMs ? formatDuration(moduleState.bestTimeMs) : '–'}</p>`
      : `<p class="mb-1"><strong>Tid:</strong> ${formatDuration(elapsed)}</p><p class="small text-secondary">Denne tiden teller ikke som rekord fordi første-forsøk-treff var under ${Math.round(CONFIG.timedAccuracyThreshold * 100)} %.</p>`;
  }

  document.getElementById('app').className = 'container trainer-shell py-4 py-md-5';
  document.getElementById('app').innerHTML = `
    <section class="app-card p-4 p-md-5">
      <div class="small-caps text-secondary mb-2">Oppsummering</div>
      <h1 class="h2 mb-4">${escapeHtml(SESSION.title)}</h1>

      <div class="row g-3 mb-4">
        <div class="col-6 col-md-3"><div class="border rounded-3 p-3 h-100"><div class="fs-4 fw-bold">${uniqueWords}</div><div class="small text-secondary">ord øvd på</div></div></div>
        <div class="col-6 col-md-3"><div class="border rounded-3 p-3 h-100"><div class="fs-4 fw-bold">${firstAttemptPct}%</div><div class="small text-secondary">første forsøk</div></div></div>
        <div class="col-6 col-md-3"><div class="border rounded-3 p-3 h-100"><div class="fs-4 fw-bold">${typos}</div><div class="small text-secondary">stavefeil</div></div></div>
        <div class="col-6 col-md-3"><div class="border rounded-3 p-3 h-100"><div class="fs-4 fw-bold">${wrong}</div><div class="small text-secondary">trenger mer øving</div></div></div>
      </div>

      <div class="alert alert-light border mb-4">${escapeHtml(message)}</div>
      ${timedRecord}

      <div class="d-flex flex-wrap gap-2 mt-4">
        <button class="btn btn-primary" id="recapHome">Til forsiden</button>
        ${failedIds.length ? `<button class="btn btn-outline-primary" id="practiceMistakes">Øv på feilene (${failedIds.length})</button>` : ''}
      </div>
    </section>`;

  document.getElementById('recapHome').addEventListener('click', renderHome);
  document.getElementById('practiceMistakes')?.addEventListener('click', () => {
    const words = failedIds.map(id => WORDS_BY_ID.get(id)).filter(Boolean);
    beginSession({
      title: 'Øv på feilene',
      mode: 'mistakes',
      moduleIds: unique(words.map(w => w.module)),
      words: shuffle(words),
    });
  });
}

function recapMessage({ typos, wrong, accuracy }) {
  if (typos >= 3 && wrong <= 2) return 'Du kjenner ordene godt, men bør øve litt mer på staving.';
  if (wrong >= 5) return 'Noen av ordene trenger mer øving. De vanskelige ordene vil dukke opp oftere senere.';
  if (accuracy >= 0.9) return 'Du husket de fleste ordene på første forsøk.';
  return 'God øving. Ordene du strevde med blir prioritert i senere økter.';
}

// ---------- Mastery / review ----------

function updateModuleCompletion(moduleId) {
  const moduleState = getModuleState(moduleId);
  const words = wordsForModule(moduleId);
  if (!words.length) return;
  if (words.every(w => isLearned(w.id))) {
    if (!moduleState.completed) moduleState.completedAt = new Date().toISOString();
    moduleState.completed = true;
  }
}

function isLearned(wordId) {
  return getWordState(wordId).mastery >= CONFIG.masteryThreshold;
}

function isDue(wordId) {
  const state = getWordState(wordId);
  return state.mastery >= CONFIG.masteryThreshold && !!state.nextReview && new Date(state.nextReview).getTime() <= Date.now();
}

function futureIso(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function updateActivity(attemptIncrement = 0, elapsedMs = 0) {
  const key = localDateKey(new Date());
  if (!STORE.activity[key]) STORE.activity[key] = { attempts: 0, minutes: 0, modules: [] };
  STORE.activity[key].attempts += attemptIncrement;
  if (elapsedMs) STORE.activity[key].minutes += Math.round(elapsedMs / 60000);
  if (SESSION) STORE.activity[key].modules = unique([...STORE.activity[key].modules, ...SESSION.moduleIds]);
}

// ---------- Keyboard / speech ----------

function handleGlobalKeydown(event) {
  if (!SESSION) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === 'Enter') {
    const primary = document.getElementById('submitBtn');
    const nextChoice = document.getElementById('nextChoiceBtn');
    if (primary && !primary.disabled) {
      event.preventDefault();
      handlePrimaryButton();
    } else if (nextChoice && !nextChoice.disabled) {
      event.preventDefault();
      renderNextQuestion();
    }
  }

  if ((event.key === 'h' || event.key === 'H') && !SESSION.awaitingNext) {
    const input = document.getElementById('answerInput');
    if (document.activeElement === input) return;
    event.preventDefault();
    showHint();
  }

  if (event.key === 'Escape') renderHome();
}

function speak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find(v => /^en-GB/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang)) || null;
  utterance.lang = utterance.voice?.lang || 'en-GB';
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}

// ---------- Helpers ----------

function wordsForModule(moduleId) {
  return CONTENT.words.filter(word => word.module === moduleId);
}

function englishAnswers(word) {
  return unique([word.english, ...(word.acceptedEnglish || [])]);
}

function norwegianAnswers(word) {
  return unique([word.norwegian, ...(word.acceptedNorwegian || [])]);
}

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('nb-NO')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim();
}

function damerauLevenshtein(a, b) {
  const da = {};
  const maxDist = a.length + b.length;
  const d = Array.from({ length: a.length + 2 }, () => Array(b.length + 2).fill(0));
  d[0][0] = maxDist;
  for (let i = 0; i <= a.length; i++) {
    d[i + 1][0] = maxDist;
    d[i + 1][1] = i;
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j + 1] = maxDist;
    d[1][j + 1] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    let db = 0;
    for (let j = 1; j <= b.length; j++) {
      const i1 = da[b[j - 1]] || 0;
      const j1 = db;
      let cost = 1;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        db = j;
      }
      d[i + 1][j + 1] = Math.min(
        d[i][j] + cost,
        d[i + 1][j] + 1,
        d[i][j + 1] + 1,
        d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1)
      );
    }
    da[a[i - 1]] = i;
  }
  return d[a.length + 1][b.length + 1];
}

function isAdjacentTransposition(a, b) {
  if (a.length !== b.length) return false;
  const diffs = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i);
  return diffs.length === 2
    && diffs[1] === diffs[0] + 1
    && a[diffs[0]] === b[diffs[1]]
    && a[diffs[1]] === b[diffs[0]];
}

function questionLabel(question) {
  const labels = {
    'no-en': 'Norsk → engelsk',
    'en-no': 'Engelsk → norsk',
    'definition-en': 'English only',
    'audio-en': 'Lytting',
    'rescue': 'Velg svar',
    'context-en': 'I kontekst',
    'context-choice': 'I kontekst',
  };
  return labels[question.direction] || 'Øving';
}

function renderLastFive() {
  const results = SESSION.recentResults.slice(-5);
  const padded = [...Array(Math.max(0, 5 - results.length)).fill('empty'), ...results];
  return padded.map(result => `<span class="${result === 'empty' ? '' : result}" title="${result}"></span>`).join('');
}

function sessionStatusLabel() {
  if (SESSION?.endAt) return timeRemainingLabel();
  if (SESSION?.mode === 'timed') return `Tid: ${formatDuration(Date.now() - SESSION.startedAt)}`;
  return SESSION?.mode === 'context' ? 'Kontekstøving' : 'Ordtrening';
}

function updateTimerLabel() {
  const label = document.getElementById('timerLabel');
  if (label) label.textContent = sessionStatusLabel();
}

function timeRemainingLabel() {
  const ms = Math.max(0, SESSION.endAt - Date.now());
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${m}:${s} igjen`;
}

function clearTickTimer() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function renderMessage(title, message, buttonLabel) {
  clearTickTimer();
  document.getElementById('app').className = 'container app-shell py-4 py-md-5';
  document.getElementById('app').innerHTML = `
    <section class="app-card p-4 p-md-5">
      <h1 class="h3">${escapeHtml(title)}</h1>
      <p class="text-secondary">${escapeHtml(message)}</p>
      <button class="btn btn-primary" id="messageHome">${escapeHtml(buttonLabel)}</button>
    </section>`;
  document.getElementById('messageHome').addEventListener('click', renderHome);
}

function sample(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function unique(array) {
  return [...new Set(array.filter(value => value !== undefined && value !== null && value !== ''))];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function roundHalf(value) {
  return Math.round(value * 2) / 2;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
