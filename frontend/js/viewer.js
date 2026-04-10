const sessionId = getRequiredQueryParam('session');
const token = getRequiredQueryParam('token');
const pageBackendBase = getPageBackendBase();

document.getElementById('sessionId').textContent = sessionId;

const statusBadge = document.getElementById('statusBadge');
const viewerNotice = document.getElementById('viewerNotice');
const finalTextEl = document.getElementById('finalText');
const partialTextEl = document.getElementById('partialText');
const practiceFeedEl = document.getElementById('practiceFeed');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleAutoScrollBtn = document.getElementById('toggleAutoScrollBtn');
const togglePracticeFeedSizeBtn = document.getElementById('togglePracticeFeedSizeBtn');
const micStatusEl = document.getElementById('micStatus');
const finalPlaceholder = finalTextEl.textContent;
const practiceFeedPlaceholder = practiceFeedEl.textContent;
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

const finalSegments = [];
const practiceFeedEntries = [];
const practiceStreamEntries = new Map();

let pingIntervalId;
let finalTokenEntries = [];
let practiceTokenEntries = [];
let activeHighlightContainer = null;
let activeHighlightRange = null;
let lastRecognitionText = '';
let finalLastMatchedEndIndex = -1;
let practiceLastMatchedEndIndex = -1;
let autoScrollEnabled = true;
let micRequested = false;
let recognition = null;
let practiceAnswerCount = 0;
let practiceFeedExpanded = false;

function setViewerStatus(text, state = 'neutral', noticeText = text) {
  setStatefulText(statusBadge, text, state);
  setStatefulText(viewerNotice, noticeText, state);
}

function setMicStatus(text, state = 'idle') {
  setStatefulText(micStatusEl, text, state);
}

function setAutoScroll(enabled) {
  autoScrollEnabled = enabled;
  toggleAutoScrollBtn.setAttribute('aria-pressed', String(enabled));
  toggleAutoScrollBtn.textContent = enabled ? 'Auto-scroll: On' : 'Auto-scroll: Off';
}

function setPracticeFeedExpanded(expanded) {
  practiceFeedExpanded = expanded;
  document.body.classList.toggle('practice-feed-maximized', expanded);
  togglePracticeFeedSizeBtn.setAttribute('aria-pressed', String(expanded));
  togglePracticeFeedSizeBtn.textContent = expanded ? 'Minimize' : 'Maximize';

  if (expanded) {
    scrollPracticeFeed();
  }

  if (lastRecognitionText) {
    updateReadAlongHighlight(lastRecognitionText);
  }
}

function normalizeWord(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, '');
}

function splitWords(text) {
  return text
    .split(/\s+/)
    .map((raw) => ({ raw, normalized: normalizeWord(raw) }))
    .filter((entry) => entry.normalized);
}

function clearHighlight() {
  finalTokenEntries.forEach((entry) => {
    entry.span.classList.remove('is-highlighted');
  });

  practiceTokenEntries.forEach((entry) => {
    entry.span.classList.remove('is-highlighted');
  });

  if (activeHighlightContainer) {
    activeHighlightContainer.classList.remove('is-active');
    activeHighlightContainer = null;
  }

  activeHighlightRange = null;
}

function resetReadAlong() {
  lastRecognitionText = '';
  finalLastMatchedEndIndex = -1;
  practiceLastMatchedEndIndex = -1;
  clearHighlight();
}

function scrollTranscript(targetSpan) {
  if (!autoScrollEnabled) {
    return;
  }

  window.requestAnimationFrame(() => {
    if (targetSpan) {
      targetSpan.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      return;
    }

    finalTextEl.scrollTo({ top: finalTextEl.scrollHeight, behavior: 'smooth' });
  });
}

function scrollPracticeFeed(targetSpan) {
  if (!autoScrollEnabled) {
    return;
  }

  window.requestAnimationFrame(() => {
    if (targetSpan) {
      targetSpan.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      return;
    }

    practiceFeedEl.scrollTo({ top: practiceFeedEl.scrollHeight, behavior: 'smooth' });
  });
}

function getTokenEntries(target) {
  return target === 'practice' ? practiceTokenEntries : finalTokenEntries;
}

function getLastMatchedEndIndex(target) {
  return target === 'practice' ? practiceLastMatchedEndIndex : finalLastMatchedEndIndex;
}

function setLastMatchedEndIndex(target, value) {
  if (target === 'practice') {
    practiceLastMatchedEndIndex = value;
    return;
  }

  finalLastMatchedEndIndex = value;
}

function applyHighlightRange(target, range) {
  clearHighlight();
  if (!range) {
    return;
  }

  const entries = getTokenEntries(target).slice(range.start, range.end + 1);
  if (!entries.length) {
    return;
  }

  entries.forEach((entry) => {
    entry.span.classList.add('is-highlighted');
  });

  activeHighlightContainer = entries[0].line;
  if (activeHighlightContainer) {
    activeHighlightContainer.classList.add('is-active');
  }

  activeHighlightRange = { target, ...range };

  if (target === 'practice') {
    scrollPracticeFeed(entries[0].span);
    return;
  }

  scrollTranscript(entries[0].span);
}

function findSequenceStart(sequence, tokenEntries, startIndex = 0) {
  if (!sequence.length || sequence.length > tokenEntries.length) {
    return -1;
  }

  const maxStart = tokenEntries.length - sequence.length;
  for (let index = startIndex; index <= maxStart; index += 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokenEntries[index + offset].normalized !== sequence[offset]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return index;
    }
  }

  return -1;
}

function updateReadAlongHighlight(recognitionText) {
  lastRecognitionText = recognitionText;

  if (!finalTokenEntries.length && !practiceTokenEntries.length) {
    return;
  }

  const recognizedWords = splitWords(recognitionText).map((entry) => entry.normalized);
  if (!recognizedWords.length) {
    clearHighlight();
    return;
  }

  const maxLength = Math.min(recognizedWords.length, 6);
  const preferredTargets = practiceFeedExpanded ? ['practice', 'final'] : ['final', 'practice'];
  const targets = [activeHighlightRange?.target, ...preferredTargets]
    .filter(Boolean)
    .filter((target, index, values) => values.indexOf(target) === index);

  for (let length = maxLength; length >= 1; length -= 1) {
    const sequence = recognizedWords.slice(-length);

    for (const target of targets) {
      const tokenEntries = getTokenEntries(target);
      if (!tokenEntries.length) {
        continue;
      }

      const preferredStart = Math.max(0, getLastMatchedEndIndex(target) - 8);
      const primaryMatch = findSequenceStart(sequence, tokenEntries, preferredStart);
      const fallbackMatch = primaryMatch === -1 ? findSequenceStart(sequence, tokenEntries, 0) : primaryMatch;

      if (fallbackMatch !== -1) {
        const range = { start: fallbackMatch, end: fallbackMatch + length - 1 };
        setLastMatchedEndIndex(target, range.end);
        applyHighlightRange(target, range);
        return;
      }
    }
  }
}

function renderFinalTranscript() {
  finalTextEl.textContent = '';
  finalTokenEntries = [];

  if (!finalSegments.length) {
    finalTextEl.textContent = finalPlaceholder;
    if (activeHighlightRange?.target === 'final') {
      activeHighlightRange = null;
    }
    return;
  }

  const fragment = document.createDocumentFragment();

  finalSegments.forEach((segmentText) => {
    const lineEl = document.createElement('p');
    lineEl.className = 'transcript-line';

    splitWords(segmentText).forEach((entry, wordIndex, words) => {
      const span = document.createElement('span');
      span.className = 'transcript-word';
      span.textContent = entry.raw;
      lineEl.appendChild(span);

      finalTokenEntries.push({
        normalized: entry.normalized,
        span,
        line: lineEl,
      });

      if (wordIndex < words.length - 1) {
        lineEl.appendChild(document.createTextNode(' '));
      }
    });

    fragment.appendChild(lineEl);
  });

  finalTextEl.appendChild(fragment);

  if (lastRecognitionText) {
    updateReadAlongHighlight(lastRecognitionText);
  } else {
    scrollTranscript();
  }
}

function ensurePracticeFeedActive() {
  if (!practiceFeedEntries.length) {
    practiceFeedEl.textContent = '';
  }
}

function rebuildPracticeTokenEntries() {
  practiceTokenEntries = practiceFeedEntries.flatMap((entry) => entry.tokenEntries || []);
}

function createPracticeFeedEntry(streamId, placeholderText = 'Shared practice answer is streaming... generated code will format when ready.') {
  let entry = practiceStreamEntries.get(streamId);
  if (entry) {
    return entry;
  }

  ensurePracticeFeedActive();
  practiceAnswerCount += 1;

  const entryEl = document.createElement('article');
  entryEl.className = 'transcript-line practice-feed-entry is-streaming';

  const labelEl = document.createElement('div');
  labelEl.className = 'practice-feed-label';
  labelEl.textContent = `Shared answer ${practiceAnswerCount}`;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'practice-feed-body';
  renderAnswerContent(bodyEl, '', { placeholder: placeholderText });

  entryEl.append(labelEl, bodyEl);
  practiceFeedEl.appendChild(entryEl);

  entry = {
    streamId,
    text: '',
    entryEl,
    bodyEl,
    tokenEntries: [],
  };

  practiceFeedEntries.push(entry);
  practiceStreamEntries.set(streamId, entry);
  scrollPracticeFeed();
  return entry;
}

function updatePracticeFeedEntry(streamId, chunkText) {
  const entry = createPracticeFeedEntry(streamId);
  entry.text += chunkText || '';
  renderAnswerContent(entry.bodyEl, entry.text, {
    streaming: true,
    placeholder: 'Shared practice answer is streaming... generated code will format when ready.',
  });
  scrollPracticeFeed();
}

function finalizePracticeFeedEntry(streamId, finalText) {
  const entry = createPracticeFeedEntry(streamId);
  entry.text = finalText || entry.text;
  entry.entryEl.classList.remove('is-streaming');
  entry.tokenEntries = [];
  renderAnswerContent(entry.bodyEl, entry.text, {
    placeholder: 'Shared practice answer will appear here.',
    collectWordEntry: (rawWord, span, highlightContainer) => {
      const normalized = normalizeWord(rawWord);
      if (!normalized) {
        return;
      }

      entry.tokenEntries.push({
        normalized,
        span,
        line: highlightContainer,
      });
    },
    highlightContainer: entry.entryEl,
  });
  rebuildPracticeTokenEntries();
  practiceStreamEntries.delete(streamId);

  if (lastRecognitionText) {
    updateReadAlongHighlight(lastRecognitionText);
  }

  scrollPracticeFeed();
}

function failPracticeFeedEntry(streamId, message) {
  const entry = createPracticeFeedEntry(streamId, message || 'Shared practice answer failed.');
  entry.entryEl.classList.remove('is-streaming');
  entry.entryEl.classList.add('is-error');
  entry.tokenEntries = [];
  renderAnswerContent(entry.bodyEl, '', {
    placeholder: message || 'Shared practice answer failed.',
  });
  rebuildPracticeTokenEntries();
  practiceStreamEntries.delete(streamId);
  scrollPracticeFeed();
}

function getRecognition() {
  if (!SpeechRecognitionCtor) {
    return null;
  }

  if (recognition) {
    return recognition;
  }

  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    setMicStatus('Mic live', 'success');
    toggleMicBtn.textContent = 'Stop mic follow';
  };

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || '')
      .join(' ')
      .trim();

    if (transcript) {
      setMicStatus('Following speaker', 'success');
      updateReadAlongHighlight(transcript);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      micRequested = false;
      setMicStatus('Mic blocked', 'error');
      toggleMicBtn.textContent = 'Enable mic follow';
      resetReadAlong();
      return;
    }

    if (event.error === 'no-speech') {
      setMicStatus('Listening...', 'loading');
      return;
    }

    setMicStatus('Mic error', 'error');
  };

  recognition.onend = () => {
    if (micRequested) {
      try {
        recognition.start();
        return;
      } catch {
        setMicStatus('Restarting mic...', 'loading');
      }
    }

    setMicStatus('Mic off', 'idle');
    toggleMicBtn.textContent = 'Enable mic follow';
  };

  return recognition;
}

const socket = new WebSocket(
  `${toWebSocketBase(pageBackendBase)}/ws/view/${sessionId}?token=${encodeURIComponent(token)}`
);

socket.onopen = () => {
  setViewerStatus('Connected', 'success', 'Viewer connected. Waiting for live transcript updates.');
  pingIntervalId = window.setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send('ping');
    }
  }, 15000);
};

socket.onmessage = (event) => {
  const payload = JSON.parse(event.data);
  if (payload.type === 'partial') {
    partialTextEl.textContent = payload.text;
  } else if (payload.type === 'final') {
    finalSegments.push(payload.text);
    renderFinalTranscript();
    partialTextEl.textContent = 'Waiting for the next live phrase...';
  } else if (payload.type === 'practice_answer_start') {
    createPracticeFeedEntry(payload.stream_id);
  } else if (payload.type === 'practice_answer_delta') {
    updatePracticeFeedEntry(payload.stream_id, payload.text);
  } else if (payload.type === 'practice_answer_done') {
    finalizePracticeFeedEntry(payload.stream_id, payload.text);
  } else if (payload.type === 'practice_answer_error') {
    failPracticeFeedEntry(payload.stream_id, payload.text);
  } else if (payload.type === 'practice_answer') {
    const legacyStreamId = payload.stream_id || `practice-${Date.now()}-${practiceAnswerCount + 1}`;
    finalizePracticeFeedEntry(legacyStreamId, payload.text);
  } else if (payload.type === 'status') {
    setViewerStatus('Live status', 'neutral', payload.text);
  } else if (payload.type === 'error') {
    setViewerStatus('Attention needed', 'error', payload.text);
  }
};

socket.onclose = (event) => {
  if (pingIntervalId) {
    window.clearInterval(pingIntervalId);
  }

  if (event.code === 1008) {
    setViewerStatus('Access denied', 'error', 'This viewer link is missing a valid session token.');
    return;
  }

  setViewerStatus('Disconnected', 'warning', 'The viewer connection closed. Refresh after the speaker reconnects.');
};

socket.onerror = () => {
  setViewerStatus('Connection error', 'error', 'The viewer could not reach the backend.');
};

toggleMicBtn.addEventListener('click', () => {
  const activeRecognition = getRecognition();
  if (!activeRecognition) {
    toggleMicBtn.disabled = true;
    setMicStatus('Mic unsupported', 'warning');
    return;
  }

  if (micRequested) {
    micRequested = false;
    activeRecognition.stop();
    resetReadAlong();
    return;
  }

  micRequested = true;
  setMicStatus('Starting mic...', 'loading');
  toggleMicBtn.textContent = 'Stop mic follow';

  try {
    activeRecognition.start();
  } catch {
    setMicStatus('Mic already active', 'success');
  }
});

toggleAutoScrollBtn.addEventListener('click', () => {
  setAutoScroll(!autoScrollEnabled);

  if (!autoScrollEnabled) {
    return;
  }

  scrollPracticeFeed();

  if (activeHighlightRange) {
    const entries = getTokenEntries(activeHighlightRange.target);
    const targetSpan = entries[activeHighlightRange.start]?.span;

    if (activeHighlightRange.target === 'practice') {
      scrollPracticeFeed(targetSpan);
      return;
    }

    scrollTranscript(targetSpan);
    return;
  }

  scrollTranscript();
});

togglePracticeFeedSizeBtn.addEventListener('click', () => {
  setPracticeFeedExpanded(!practiceFeedExpanded);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && practiceFeedExpanded) {
    setPracticeFeedExpanded(false);
  }
});

if (!SpeechRecognitionCtor) {
  toggleMicBtn.disabled = true;
  setMicStatus('Mic unsupported', 'warning');
}

setAutoScroll(true);
setPracticeFeedExpanded(false);
practiceFeedEl.textContent = practiceFeedPlaceholder;
