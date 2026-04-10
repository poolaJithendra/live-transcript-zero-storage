const backendInput = document.getElementById('backendUrl');
const saveBackendBtn = document.getElementById('saveBackendBtn');
const createSessionBtn = document.getElementById('createSessionBtn');
const sessionOutput = document.getElementById('sessionOutput');
const homeNotice = document.getElementById('homeNotice');
const backendSummary = document.getElementById('backendSummary');

function setBackendSummary(text, state = 'neutral') {
  setStatefulText(backendSummary, text, state);
}

function setHomeNotice(text, state = 'neutral') {
  setStatefulText(homeNotice, text, state);
}

function getBackendFailureHint() {
  if (window.location.protocol === 'file:') {
    return 'Open the frontend from a local HTTP server (for example 127.0.0.1:5500), not file://.';
  }

  return 'Check that the backend URL is correct and ALLOWED_ORIGIN permits this frontend origin.';
}

function resetSessionOutput(message) {
  sessionOutput.classList.add('empty-state');
  sessionOutput.textContent = message;
}

function renderSessionLinks(payload, backendBase) {
  const normalizedBackend = normalizeBackendBase(backendBase);
  const speakerLink = buildPageUrl('speaker.html', {
    session: payload.session_id,
    token: payload.speaker_token,
    viewer_token: payload.viewer_token,
    backend: normalizedBackend,
  });
  const viewerLink = buildPageUrl('viewer.html', {
    session: payload.session_id,
    token: payload.viewer_token,
    backend: normalizedBackend,
  });

  sessionOutput.classList.remove('empty-state');
  sessionOutput.innerHTML = `
    <div class="panel-heading">
      <div>
        <p class="section-kicker">Session ready</p>
        <h2>${payload.session_id}</h2>
      </div>
      <span class="status-chip" data-state="success">Expires in ${payload.expires_in_minutes} minutes</span>
    </div>
    <div class="session-links">
      <article class="link-card">
        <p class="section-kicker">Host link</p>
        <h3>Speaker console</h3>
        <p>Use this private link to own the microphone feed for the session.</p>
        <span class="link-field">${speakerLink}</span>
        <div class="link-actions">
          <a class="button button-primary" href="${speakerLink}" target="_blank" rel="noreferrer">Open speaker</a>
          <button id="copySpeakerLinkBtn" class="button button-secondary" type="button">Copy link</button>
        </div>
      </article>
      <article class="link-card">
        <p class="section-kicker">Audience link</p>
        <h3>Viewer console</h3>
        <p>Share this secured viewer link with moderators, monitors, or the audience.</p>
        <span class="link-field">${viewerLink}</span>
        <div class="link-actions">
          <a class="button button-primary" href="${viewerLink}" target="_blank" rel="noreferrer">Open viewer</a>
          <button id="copyViewerLinkBtn" class="button button-secondary" type="button">Copy link</button>
        </div>
      </article>
    </div>
  `;

  document.getElementById('copySpeakerLinkBtn').addEventListener('click', async () => {
    await copyText(speakerLink);
    setHomeNotice('Speaker link copied to clipboard.', 'success');
  });

  document.getElementById('copyViewerLinkBtn').addEventListener('click', async () => {
    await copyText(viewerLink);
    setHomeNotice('Viewer link copied to clipboard.', 'success');
  });
}

async function validateBackend(base, { updateNotice = true } = {}) {
  const normalized = setStoredBackendBase(base);
  backendInput.value = normalized;
  saveBackendBtn.disabled = true;
  createSessionBtn.disabled = true;
  setBackendSummary('Checking backend...', 'loading');

  if (updateNotice) {
    setHomeNotice('Checking backend availability...', 'loading');
  }

  try {
    await fetchBackendHealth(normalized);
    setBackendSummary(`Backend ready: ${normalized}`, 'success');
    createSessionBtn.disabled = false;

    if (updateNotice) {
      setHomeNotice('Backend is reachable. You can create a secure session now.', 'success');
    }

    return normalized;
  } catch (error) {
    setBackendSummary('Backend unreachable', 'error');
    resetSessionOutput('Backend check failed. Confirm backend is running and CORS allows this frontend origin.');

    if (updateNotice) {
      const detail = error instanceof Error ? error.message : 'Unable to reach the backend.';
      setHomeNotice(`${detail} ${getBackendFailureHint()}`, 'error');
    }

    return null;
  } finally {
    saveBackendBtn.disabled = false;
  }
}

async function createSession() {
  const backendBase = await validateBackend(backendInput.value);
  if (!backendBase) {
    return;
  }

  createSessionBtn.disabled = true;
  setHomeNotice('Creating a secure session...', 'loading');

  try {
    const response = await fetch(`${toHttpBase(backendBase)}/sessions`, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`);
    }

    const payload = await response.json();
    renderSessionLinks(payload, backendBase);
    setHomeNotice('Secure session created. Speaker and viewer links are ready.', 'success');
  } catch (error) {
    resetSessionOutput('Session creation failed. Confirm the backend is running and the API is reachable.');
    setHomeNotice(error instanceof Error ? error.message : 'Unable to create a session.', 'error');
  } finally {
    createSessionBtn.disabled = false;
  }
}

backendInput.value = getStoredBackendBase();
setBackendSummary('Waiting for backend', 'neutral');
resetSessionOutput('Fresh speaker and viewer links will appear here after the backend responds.');

saveBackendBtn.addEventListener('click', async () => {
  await validateBackend(backendInput.value);
});

createSessionBtn.addEventListener('click', createSession);
void validateBackend(backendInput.value, { updateNotice: false });
