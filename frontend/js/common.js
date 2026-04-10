const FALLBACK_BACKEND_BASE = 'ws://localhost:8000';

function getDefaultBackendBase() {
  const configuredBase = typeof window !== 'undefined'
    ? window.__LIVE_TRANSCRIPT_CONFIG__?.backendBase
    : null;

  if (typeof configuredBase === 'string' && configuredBase.trim()) {
    return configuredBase.trim();
  }

  return FALLBACK_BACKEND_BASE;
}

function normalizeBackendBase(value) {
  const trimmedValue = (value || getDefaultBackendBase()).trim().replace(/\/+$/, '');
  if (!trimmedValue) {
    return getDefaultBackendBase();
  }

  if (!/^(ws|wss|http|https):\/\//i.test(trimmedValue)) {
    return `ws://${trimmedValue}`;
  }

  return trimmedValue;
}

function getStoredBackendBase() {
  try {
    return normalizeBackendBase(window.localStorage.getItem('backendBase') || getDefaultBackendBase());
  } catch {
    return normalizeBackendBase(getDefaultBackendBase());
  }
}

function setStoredBackendBase(value) {
  const normalized = normalizeBackendBase(value);
  try {
    window.localStorage.setItem('backendBase', normalized);
  } catch {
    // Ignore storage failures and keep using the normalized value for this page load.
  }
  return normalized;
}

function toHttpBase(value) {
  return normalizeBackendBase(value)
    .replace(/^ws:\/\//i, 'http://')
    .replace(/^wss:\/\//i, 'https://');
}

function toWebSocketBase(value) {
  return normalizeBackendBase(value)
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
}

function getRequiredQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(name);
  if (!value) {
    throw new Error(`Missing ${name} query parameter`);
  }
  return value;
}

function getOptionalQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function getPageBackendBase() {
  const backendFromQuery = getOptionalQueryParam('backend');
  if (backendFromQuery) {
    return setStoredBackendBase(backendFromQuery);
  }

  return getStoredBackendBase();
}

function buildPageUrl(pageName, params = {}) {
  const url = new URL(pageName, window.location.href);
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function setStatefulText(element, text, state) {
  if (!element) {
    return;
  }

  element.textContent = text;
  if (state) {
    element.dataset.state = state;
  }
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

async function fetchBackendHealth(backendBase) {
  const response = await fetch(`${toHttpBase(backendBase)}/health`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Backend health check failed with ${response.status}.`);
  }

  const payload = await response.json().catch(() => ({}));
  if (payload?.status !== 'ok') {
    throw new Error('Backend health check returned an unexpected response.');
  }

  return payload;
}

function appendTokenizedAnswerContent(target, text, collectWordEntry, highlightContainer) {
  const parts = text.split(/(\s+)/);

  parts.forEach((part) => {
    if (!part) {
      return;
    }

    if (/^\s+$/.test(part)) {
      target.appendChild(document.createTextNode(part));
      return;
    }

    const span = document.createElement('span');
    span.className = 'transcript-word answer-word';
    span.textContent = part;
    target.appendChild(span);
    collectWordEntry(part, span, highlightContainer);
  });
}

function appendAnswerTextBlock(fragment, text, options = {}) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  trimmed.split(/\n{2,}/).forEach((paragraph) => {
    const paragraphEl = document.createElement('p');
    paragraphEl.className = 'answer-paragraph';
    const content = paragraph.trim();

    if (options.collectWordEntry) {
      appendTokenizedAnswerContent(
        paragraphEl,
        content,
        options.collectWordEntry,
        options.highlightContainer || paragraphEl
      );
    } else {
      paragraphEl.textContent = content;
    }

    fragment.appendChild(paragraphEl);
  });
}

function appendAnswerCodeBlock(fragment, rawCode, languageLabel, options = {}) {
  const shell = document.createElement('div');
  shell.className = 'answer-code-shell';

  if (languageLabel) {
    const label = document.createElement('div');
    label.className = 'answer-code-label';
    label.textContent = languageLabel;
    shell.appendChild(label);
  }

  const pre = document.createElement('pre');
  pre.className = 'answer-code-block';

  const code = document.createElement('code');
  const content = rawCode.replace(/^\n+|\n+$/g, '');

  if (options.collectWordEntry) {
    appendTokenizedAnswerContent(
      code,
      content,
      options.collectWordEntry,
      options.highlightContainer || shell
    );
  } else {
    code.textContent = content;
  }

  pre.appendChild(code);
  shell.appendChild(pre);
  fragment.appendChild(shell);
}

function renderAnswerContent(element, text, options = {}) {
  if (!element) {
    return;
  }

  const placeholder = options.placeholder || '';
  const streaming = Boolean(options.streaming);
  element.innerHTML = '';
  element.classList.toggle('is-placeholder', !text);
  element.classList.toggle('is-streaming', streaming);

  if (!text) {
    element.textContent = placeholder;
    return;
  }

  if (streaming) {
    const pre = document.createElement('pre');
    pre.className = 'answer-stream-text';
    pre.textContent = text;
    element.appendChild(pre);
    return;
  }

  const fragment = document.createDocumentFragment();
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match = fencePattern.exec(text);

  while (match) {
    appendAnswerTextBlock(fragment, text.slice(lastIndex, match.index), options);
    appendAnswerCodeBlock(fragment, match[2], match[1].trim(), options);
    lastIndex = fencePattern.lastIndex;
    match = fencePattern.exec(text);
  }

  appendAnswerTextBlock(fragment, text.slice(lastIndex), options);

  if (!fragment.childNodes.length) {
    element.textContent = text;
    return;
  }

  element.appendChild(fragment);
}
