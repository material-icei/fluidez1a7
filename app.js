/* =========================================================
   VUELA LEYENDO — lógica de la app
   ========================================================= */

const state = {
  studentName: '',
  grade: '1º grado',
  text: '',
  words: [],          // palabras normalizadas del texto original
  webAppUrl: '',
  recognizedWords: [], // palabras reconocidas en orden (tal como llegan)
  heardSet: new Set(), // índices de palabras del texto ya marcadas como escuchadas
  timeLeft: 60,
  timerId: null,
  startTimestamp: null,
  recognizing: false,
  recognition: null,
  mediaRecorder: null,
  audioChunks: [],
  audioBlob: null,
  finished: false,
};

/* ---------- utilidades de texto ---------- */
function normalizarPalabra(w) {
  return w
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos para comparar
    .replace(/[^a-zñ0-9]/g, '');
}

function tokenizarTexto(texto) {
  return texto
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean);
}

/* Alineación tipo LCS entre el texto original y lo escuchado,
   para contar cuántas palabras del texto fueron leídas correctamente y en orden. */
function calcularPalabrasCorrectas(originalNorm, escuchadoNorm) {
  const n = originalNorm.length;
  const m = escuchadoNorm.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (originalNorm[i - 1] && originalNorm[i - 1] === escuchadoNorm[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // reconstruir qué índices del original quedaron marcados como "correctos"
  const marcados = new Set();
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (originalNorm[i - 1] === escuchadoNorm[j - 1]) {
      marcados.add(i - 1);
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return { correctas: dp[n][m], indicesMarcados: marcados };
}

/* ---------- navegación entre pantallas ---------- */
function mostrarPantalla(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('screen--active'));
  document.getElementById(id).classList.add('screen--active');
}

/* ---------- pantalla menú: tarjetas de grado ---------- */
let gradoSeleccionado = 1;

document.querySelectorAll('.grade-card').forEach(card => {
  card.addEventListener('click', () => {
    gradoSeleccionado = Number(card.dataset.grade);
    abrirConfigParaGrado(gradoSeleccionado);
  });
});

function abrirConfigParaGrado(grado) {
  const sufijos = ['', 'º', 'º', 'º', 'º', 'º', 'º', 'º'];
  const badge = document.getElementById('config-grade-badge');
  badge.textContent = grado + 'º grado';

  // color del badge según grado
  const colores = ['','#FF6B5E','#FF9A3C','#C49A00','#4CAF7D','#2ABBA7','#2B7FB0','#7C5CBF'];
  badge.style.background = colores[grado] || 'var(--tinta)';

  // pre-completar el campo curso
  document.getElementById('input-grade').value = grado + 'º grado';

  // limpiar selección previa
  lecturaSeleccionadaId = null;
  document.getElementById('input-text').value = '';
  actualizarPreviewPalabras();

  renderBibliotecaFiltrada(grado);
  mostrarPantalla('screen-config');
}

/* ---------- pantalla configuración ---------- */
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwgvO-E20Zdo11eeN8GrVCCj-Sf8UwGjwOybWJ17H0BUglJoO3Bf8kU8nkVCCEE6XNSgg/exec';

const LECTURAS_DEFAULT = [
  { id: 'default-1', grado: 1, titulo: 'La gallina', texto: 'Las gallinas son aves. Las aves ponen huevos. Las crías se llaman pollitos. Sus cuerpos están cubiertos de plumas. Tienen pico, alas y dos patas. Las gallinas se alimentan de gusanos, insectos y semillas. Viven en un gallinero y tienen alas pero no vuelan.' },
  { id: 'default-2', grado: 1, titulo: 'La máquina', texto: 'Mi abuelo es inventor. Cuando fui a visitarlo, me invitó a su laboratorio. Tiene una máquina con muchos botones. Es una fábrica de gomitas de colores. Apretamos un botón y salieron miles de gomitas. Las llevé a la escuela para compartir con mis amigos.' },
  { id: 'default-3', grado: 1, titulo: 'Pedro, el conejo', texto: 'El conejo Pedro tiene ocho hermanos. Todos se preparan para ir a la escuela. Mamá les pone muchas zanahorias de merienda en la mochila. Pedro es muy distraído. Siempre se olvida su mochila en casa. Pero como tiene muchos hermanos, siempre alguno le convida zanahorias. Le encanta ir a la escuela y compartir con sus amigos. No falta nunca a clases.' },
  { id: 'default-4', grado: 1, titulo: 'La vaca Victoria', texto: 'La vaca Victoria se va de paseo, moviendo la cola con suave meneo. A su lado salta su ternero nuevo. ¡Es tan divertido correr en invierno!' },
  { id: 'default-5', grado: 1, titulo: 'Un teléfono inventado', texto: 'María y Luis son amigos. Les gusta jugar. Tienen una gran idea. Con dos vasos de plástico y un hilo de lana hacen un teléfono. María y Luis salieron felices a jugar con su nuevo invento.' },
];

/* ---- biblioteca: fuente principal = Google Sheet, respaldo = defaults ---- */
let lecturasCargadas = [...LECTURAS_DEFAULT]; // se reemplaza al cargar desde Sheet
let lecturaSeleccionadaId = null;

async function cargarLecturasDesdeSheet() {
  const listaEl = document.getElementById('library-list');
  listaEl.innerHTML = '<span style="color:var(--tinta-suave);font-size:0.9rem;padding:6px 4px">Cargando lecturas…</span>';
  try {
    const res = await fetch(WEB_APP_URL + '?action=lecturas');
    const json = await res.json();
    if (json.ok && Array.isArray(json.lecturas) && json.lecturas.length > 0) {
      lecturasCargadas = json.lecturas;
    } else {
      lecturasCargadas = [...LECTURAS_DEFAULT];
    }
  } catch {
    lecturasCargadas = [...LECTURAS_DEFAULT];
  }
  renderBibliotecaFiltrada(gradoSeleccionado);
}

function renderBiblioteca() {
  renderBibliotecaFiltrada(gradoSeleccionado);
}

function renderBibliotecaFiltrada(grado) {
  const lista = document.getElementById('library-list');
  lista.innerHTML = '';

  const filtradas = lecturasCargadas.filter(l => Number(l.grado) === Number(grado));

  if (filtradas.length === 0) {
    lista.innerHTML = '<span style="color:var(--tinta-suave);font-size:0.9rem">No hay lecturas cargadas para este grado en la planilla.</span>';
    return;
  }

  filtradas.forEach(lec => {
    const card = document.createElement('div');
    card.className = 'lib-card' + (lec.id === lecturaSeleccionadaId ? ' selected' : '');

    const btnTitulo = document.createElement('button');
    btnTitulo.className = 'lib-card-title';
    btnTitulo.textContent = lec.titulo;
    btnTitulo.type = 'button';
    btnTitulo.addEventListener('click', () => seleccionarLectura(lec.id));

    card.appendChild(btnTitulo);
    lista.appendChild(card);
  });
}

document.getElementById('btn-reload-readings').addEventListener('click', cargarLecturasDesdeSheet);

function seleccionarLectura(id) {
  const lec = lecturasCargadas.find(l => l.id === id);
  if (!lec) return;
  lecturaSeleccionadaId = id;
  inputText.value = lec.texto;
  actualizarPreviewPalabras();
  renderBiblioteca();
}

/* ---- resto de la configuración ---- */
const inputStudent = document.getElementById('input-student');
const inputGrade = document.getElementById('input-grade');
const inputText = document.getElementById('input-text');
const wordCountPreview = document.getElementById('word-count-preview');

function actualizarPreviewPalabras() {
  const n = tokenizarTexto(inputText.value).length;
  wordCountPreview.textContent = n > 0 ? `· ${n} palabras` : '';
}
inputText.addEventListener('input', () => {
  lecturaSeleccionadaId = null;
  renderBiblioteca();
  actualizarPreviewPalabras();
});

document.getElementById('back-from-config').addEventListener('click', () => mostrarPantalla('screen-menu'));

document.getElementById('btn-start-reading').addEventListener('click', () => {
  const nombre = inputStudent.value.trim();
  const texto = inputText.value.trim();
  if (!nombre) { alert('Falta escribir el nombre del alumno o alumna.'); inputStudent.focus(); return; }
  if (!texto) { alert('Falta seleccionar o escribir el texto que va a leer.'); return; }

  state.studentName = nombre;
  state.grade = inputGrade.value.trim() || '1º grado';
  state.text = texto;
  state.words = tokenizarTexto(texto);
  state.webAppUrl = WEB_APP_URL;

  prepararPantallaLectura();
  mostrarPantalla('screen-reading');
});

/* ---------- pantalla lectura ---------- */
const readingTextEl = document.getElementById('reading-text');
const btnRecord = document.getElementById('btn-record');
const recordBtnLabel = document.getElementById('record-btn-label');
const btnStop = document.getElementById('btn-stop');
const statWords = document.getElementById('stat-words');
const statStatus = document.getElementById('stat-status');
const statStatusLabel = document.getElementById('stat-status-label');
const timerSecondsEl = document.getElementById('timer-seconds');
const timerRingFg = document.getElementById('timer-ring-fg');
const readingHint = document.getElementById('reading-hint');
const mascotMouth = document.getElementById('mascot-mouth');

const RING_CIRCUMFERENCE = 439.8;

function prepararPantallaLectura() {
  document.getElementById('display-student').textContent = state.studentName;
  document.getElementById('display-grade').textContent = state.grade;

  readingTextEl.innerHTML = state.words
    .map((w, idx) => `<span class="word" data-idx="${idx}">${w}</span>`)
    .join(' ');

  state.timeLeft = 60;
  state.recognizedWords = [];
  state.heardSet = new Set();
  state.audioBlob = null;
  state.finished = false;
  timerSecondsEl.textContent = '60';
  timerRingFg.style.strokeDashoffset = '0';
  statWords.textContent = '0';
  statStatus.classList.remove('live');
  statStatus.textContent = '●';
  statStatusLabel.textContent = 'listo';
  btnRecord.classList.remove('recording');
  recordBtnLabel.textContent = 'Empezar a leer';
  btnStop.hidden = true;
  readingHint.textContent = 'Apretá el botón cuando estés listo o lista para leer en voz alta.';
  mascotMouth.setAttribute('d', 'M48 84 Q60 90 72 84');
}

document.getElementById('back-from-reading').addEventListener('click', () => {
  detenerTodo();
  mostrarPantalla('screen-menu');
});

/* --- Web Speech API (reconocimiento) --- */
function crearReconocedor() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = 'es-AR';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    let finalChunk = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalChunk += ' ' + event.results[i][0].transcript;
      }
    }
    if (finalChunk.trim()) {
      const nuevas = tokenizarTexto(finalChunk);
      state.recognizedWords.push(...nuevas);
      refrescarReconocimientoEnVivo();
    }
  };
  rec.onerror = (e) => {
    console.warn('Error de reconocimiento de voz:', e.error);
  };
  rec.onend = () => {
    if (state.recognizing && !state.finished) {
      // el navegador a veces corta el reconocimiento solo; lo reiniciamos si seguimos grabando
      try { rec.start(); } catch (_) {}
    }
  };
  return rec;
}

function refrescarReconocimientoEnVivo() {
  statWords.textContent = String(state.recognizedWords.length);

  const originalNorm = state.words.map(normalizarPalabra);
  const escuchadoNorm = state.recognizedWords.map(normalizarPalabra);
  const { indicesMarcados } = calcularPalabrasCorrectas(originalNorm, escuchadoNorm);

  document.querySelectorAll('#reading-text .word').forEach(span => {
    const idx = Number(span.dataset.idx);
    span.classList.toggle('word--heard', indicesMarcados.has(idx));
  });

  mascotMouth.setAttribute('d', indicesMarcados.size % 2 === 0
    ? 'M48 84 Q60 92 72 84'
    : 'M48 86 Q60 80 72 86');
}

/* --- grabación de audio --- */
async function iniciarGrabacionAudio() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.mediaRecorder = new MediaRecorder(stream);
  state.audioChunks = [];
  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) state.audioChunks.push(e.data);
  };
  state.mediaRecorder.start();
}

function detenerGrabacionAudio() {
  return new Promise((resolve) => {
    if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
      resolve();
      return;
    }
    state.mediaRecorder.onstop = () => {
      state.audioBlob = new Blob(state.audioChunks, { type: 'audio/webm' });
      state.mediaRecorder.stream.getTracks().forEach(t => t.stop());
      resolve();
    };
    state.mediaRecorder.stop();
  });
}

/* --- timer --- */
function iniciarTimer() {
  state.startTimestamp = Date.now();
  state.timerId = setInterval(() => {
    state.timeLeft -= 1;
    timerSecondsEl.textContent = String(Math.max(state.timeLeft, 0));
    const offset = RING_CIRCUMFERENCE * (1 - state.timeLeft / 60);
    timerRingFg.style.strokeDashoffset = String(offset);
    if (state.timeLeft <= 0) {
      finalizarLectura();
    }
  }, 1000);
}

function detenerTimer() {
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
}

/* --- botones de control --- */
btnRecord.addEventListener('click', async () => {
  if (state.recognizing) return;

  if (!('mediaDevices' in navigator)) {
    alert('Este navegador no permite acceder al micrófono.');
    return;
  }

  try {
    await iniciarGrabacionAudio();
  } catch (err) {
    alert('No se pudo acceder al micrófono. Revisá los permisos del navegador.');
    return;
  }

  state.recognition = crearReconocedor();
  if (state.recognition) {
    try { state.recognition.start(); } catch (_) {}
  } else {
    readingHint.textContent = 'Este navegador no reconoce el habla automáticamente; igual se va a grabar el audio.';
  }

  state.recognizing = true;
  state.finished = false;
  btnRecord.classList.add('recording');
  recordBtnLabel.textContent = 'Leyendo...';
  btnStop.hidden = false;
  statStatus.classList.add('live');
  statStatusLabel.textContent = 'grabando';
  readingHint.textContent = 'Leé en voz alta y clara. Se va a detener solo a los 60 segundos.';

  iniciarTimer();
});

btnStop.addEventListener('click', finalizarLectura);

async function detenerTodo() {
  detenerTimer();
  if (state.recognition) { try { state.recognition.stop(); } catch (_) {} }
  await detenerGrabacionAudio();
  state.recognizing = false;
}

async function finalizarLectura() {
  if (state.finished) return;
  state.finished = true;
  const elapsedSeconds = state.startTimestamp
    ? Math.min(60, (Date.now() - state.startTimestamp) / 1000)
    : 60;
  await detenerTodo();
  mostrarResultados(elapsedSeconds);
}

/* ---------- pantalla resultados ---------- */
function mostrarResultados(elapsedSeconds) {
  const originalNorm = state.words.map(normalizarPalabra);
  const escuchadoNorm = state.recognizedWords.map(normalizarPalabra);
  const { correctas } = calcularPalabrasCorrectas(originalNorm, escuchadoNorm);

  const totalLeidas = state.recognizedWords.length;
  const minutos = Math.max(elapsedSeconds, 1) / 60;
  const wpm = Math.round(totalLeidas / minutos);
  const totalTexto = state.words.length;
  const precision = totalLeidas > 0 ? Math.round((correctas / Math.max(totalLeidas, totalTexto)) * 100) : 0;

  document.getElementById('results-name').textContent = state.studentName;
  document.getElementById('result-wpm').textContent = String(wpm);
  document.getElementById('result-correct').textContent = String(correctas);
  document.getElementById('result-total').textContent = String(totalTexto);
  document.getElementById('result-accuracy').textContent = `${Math.min(precision, 100)}%`;

  const reviewText = document.getElementById('review-text');
  reviewText.innerHTML = readingTextEl.innerHTML;

  const audioPlayer = document.getElementById('audio-player');
  if (state.audioBlob) {
    audioPlayer.src = URL.createObjectURL(state.audioBlob);
  } else {
    audioPlayer.removeAttribute('src');
  }

  const syncStatus = document.getElementById('sync-status');
  syncStatus.textContent = '';

  mostrarPantalla('screen-results');

  enviarResultados({
    studentName: state.studentName,
    grade: state.grade,
    text: state.text,
    wpm,
    correctWords: correctas,
    totalWords: totalTexto,
    readWords: totalLeidas,
    accuracy: Math.min(precision, 100),
    audioBlob: state.audioBlob,
  });
}

document.getElementById('btn-read-again').addEventListener('click', () => {
  prepararPantallaLectura();
  mostrarPantalla('screen-reading');
});
document.getElementById('btn-finish').addEventListener('click', () => mostrarPantalla('screen-menu'));

/* ---------- envío a Google Apps Script ---------- */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function enviarResultados(data) {
  const syncStatus = document.getElementById('sync-status');

  if (!state.webAppUrl) {
    syncStatus.textContent = 'No hay URL de Apps Script configurada: el resultado quedó solo en esta pantalla.';
    return;
  }

  syncStatus.textContent = 'Guardando en la planilla y subiendo el audio…';

  try {
    const payload = {
      studentName: data.studentName,
      grade: data.grade,
      text: data.text,
      wpm: data.wpm,
      correctWords: data.correctWords,
      totalWords: data.totalWords,
      readWords: data.readWords,
      accuracy: data.accuracy,
      timestamp: new Date().toISOString(),
      audioBase64: data.audioBlob ? await blobToBase64(data.audioBlob) : null,
      audioMimeType: data.audioBlob ? data.audioBlob.type : null,
    };

    const response = await fetch(state.webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS con Apps Script
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({ ok: response.ok }));
    if (result && result.ok) {
      syncStatus.textContent = '✅ Guardado en la planilla y el audio subido a Drive.';
    } else {
      syncStatus.textContent = '⚠️ Se envió, pero hubo un problema al guardar. Revisá el Apps Script.';
    }
  } catch (err) {
    console.error(err);
    syncStatus.textContent = '⚠️ No se pudo conectar con Apps Script. El resultado quedó solo en esta pantalla.';
  }
}

/* inicialización */
cargarLecturasDesdeSheet();
actualizarPreviewPalabras();

