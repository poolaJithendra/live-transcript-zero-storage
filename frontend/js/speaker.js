const sessionId = getRequiredQueryParam('session');
const token = getRequiredQueryParam('token');
const viewerToken = getOptionalQueryParam('viewer_token');
const pageBackendBase = getPageBackendBase();

document.getElementById('sessionId').textContent = sessionId;

const statusBadge = document.getElementById('statusBadge');
const transcriptBox = document.getElementById('transcriptBox');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const copyViewerBtn = document.getElementById('copyViewerBtn');
const speakerNotice = document.getElementById('speakerNotice');
const speakerStage = document.querySelector('.speaker-stage');
const livePreviewOverlay = document.getElementById('livePreviewOverlay');
const practiceMainPanel = document.querySelector('.practice-main-panel');
const resumeFileInput = document.getElementById('resumeFileInput');
const uploadResumeBtn = document.getElementById('uploadResumeBtn');
const resumeStatus = document.getElementById('resumeStatus');
const resumeMeta = document.getElementById('resumeMeta');
const aiQuestionInput = document.getElementById('aiQuestionInput');
const useTranscriptBtn = document.getElementById('useTranscriptBtn');
const generateAiBtn = document.getElementById('generateAiBtn');
const sendAiToViewerBtn = document.getElementById('sendAiToViewerBtn');
const interruptAiBtn = document.getElementById('interruptAiBtn');
const interruptToMicBtn = document.getElementById('interruptToMicBtn');
const togglePracticeMicBtn = document.getElementById('togglePracticeMicBtn');
const toggleAutoSendBtn = document.getElementById('toggleAutoSendBtn');
const aiStatusBadge = document.getElementById('aiStatusBadge');
const aiStatusNotice = document.getElementById('aiStatusNotice');
const aiAnswerBox = document.getElementById('aiAnswerBox');
const practiceMicStatus = document.getElementById('practiceMicStatus');
const transcriptPlaceholder = transcriptBox.textContent;
const practiceAnswerPlaceholder = aiAnswerBox.textContent;
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

let socket;
let audioContext;
let mediaStream;
let sourceNode;
let processorNode;
let uploadedResumeMeta = null;
let practiceMicRequested = false;
let practiceRecognition = null;
let autoSendToViewer = false;
let lastGeneratedAnswer = '';
let livePreviewPaused = false;
let latestLivePreviewText = transcriptPlaceholder;
let practiceGenerationController = null;
let practiceGenerating = false;
let pendingPracticeMicStart = false;
let activePracticeStreamId = null;

function setSpeakerStatus(text, state = 'neutral', noticeText = text) {
  setStatefulText(statusBadge, text, state);
  setStatefulText(speakerNotice, noticeText, state);
}

function setPracticeStatus(text, state = 'idle', noticeText = text) {
  setStatefulText(aiStatusBadge, text, state);
  setStatefulText(aiStatusNotice, noticeText, state);
}

function setResumeStatus(text, state = 'neutral') {
  setStatefulText(resumeStatus, text, state);
}

function setPracticeMicStatus(text, state = 'idle') {
  setStatefulText(practiceMicStatus, text, state);
}

function setAutoSendToViewer(enabled) {
  autoSendToViewer = enabled;
  toggleAutoSendBtn.setAttribute('aria-pressed', String(enabled));
  toggleAutoSendBtn.textContent = enabled ? 'Auto-send to viewer: On' : 'Auto-send to viewer: Off';
}

function isAbortError(error) {
  return Boolean(error && typeof error === 'object' && error.name === 'AbortError');
}

function syncPracticeMicButtonLabel() {
  if (practiceMicRequested) {
    togglePracticeMicBtn.textContent = 'Stop practice mic';
    return;
  }

  togglePracticeMicBtn.textContent = practiceGenerating ? 'Interrupt + start mic' : 'Start practice mic';
}

function setPracticeGeneratingState(isGenerating) {
  practiceGenerating = isGenerating;
  practiceMainPanel.classList.toggle('is-generating', isGenerating);
  generateAiBtn.disabled = isGenerating;
  interruptAiBtn.disabled = !isGenerating;
  interruptToMicBtn.disabled = !isGenerating || !SpeechRecognitionCtor;
  sendAiToViewerBtn.disabled = isGenerating || !lastGeneratedAnswer;
  useTranscriptBtn.disabled = isGenerating || livePreviewPaused;
  syncPracticeMicButtonLabel();
}

function updateTranscriptPreview(text) {
  latestLivePreviewText = text || transcriptPlaceholder;
  if (livePreviewPaused) {
    return;
  }

  transcriptBox.textContent = latestLivePreviewText;
}

function setLivePreviewPaused(paused) {
  livePreviewPaused = paused;
  speakerStage.classList.toggle('is-paused', paused);
  livePreviewOverlay.hidden = !paused;
  useTranscriptBtn.disabled = paused || practiceGenerating;

  if (paused) {
    transcriptBox.textContent = 'Live preview paused while Practice Mic is active.';
    return;
  }

  transcriptBox.textContent = latestLivePreviewText || transcriptPlaceholder;
}

function getPracticeApiUrl(path) {
  return `${toHttpBase(pageBackendBase)}${path}`;
}

function getPracticeHeaders(withJson = false) {
  const headers = {
    'X-Session-Token': token,
  };

  if (withJson) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

function updateResumeMeta(meta) {
  if (!meta) {
    resumeMeta.textContent = 'Upload a resume to ground practice answers and reduce hallucinations.';
    return;
  }

  resumeMeta.textContent = `${meta.file_name} loaded in memory. ${meta.word_count} words across ${meta.chunk_count} retrieval chunks. Summary: ${meta.summary}`;
}

function getViewerLink() {
  if (!viewerToken) {
    return null;
  }

  return buildPageUrl('viewer.html', {
    session: sessionId,
    token: viewerToken,
    backend: pageBackendBase,
  });
}

function startPracticeMicCapture() {
  const recognition = getPracticeRecognition();
  if (!recognition) {
    togglePracticeMicBtn.disabled = true;
    setPracticeMicStatus('Practice mic unsupported', 'warning');
    return;
  }

  if (practiceMicRequested) {
    return;
  }

  practiceMicRequested = true;
  setPracticeMicStatus('Starting practice mic...', 'loading');
  syncPracticeMicButtonLabel();

  try {
    recognition.start();
  } catch {
    setPracticeMicStatus('Practice mic already active', 'success');
  }
}

async function cancelPracticeViewerStream(streamId, message) {
  if (!streamId) {
    return;
  }

  try {
    await fetch(getPracticeApiUrl(`/practice/${sessionId}/cancel-stream`), {
      method: 'POST',
      headers: getPracticeHeaders(true),
      body: JSON.stringify({
        stream_id: streamId,
        message,
      }),
    });
  } catch {
    // Best-effort cleanup for any viewer-side streamed entry.
  }
}

function interruptPracticeAnswer({ startMicAfter = false } = {}) {
  if (!practiceGenerationController) {
    if (startMicAfter) {
      startPracticeMicCapture();
    }
    return;
  }

  pendingPracticeMicStart = startMicAfter;
  setPracticeStatus(
    startMicAfter ? 'Interrupting for next question' : 'Interrupting',
    'loading',
    startMicAfter
      ? 'Stopping the current answer and preparing the practice mic for the next question.'
      : 'Stopping the current answer stream.'
  );
  practiceGenerationController.abort();
}

function stopPracticeMic() {
  if (!practiceRecognition) {
    practiceMicRequested = false;
    setPracticeMicStatus('Practice mic off', 'idle');
    syncPracticeMicButtonLabel();
    setLivePreviewPaused(false);
    return;
  }

  practiceMicRequested = false;

  try {
    practiceRecognition.stop();
  } catch {
    setPracticeMicStatus('Practice mic off', 'idle');
    syncPracticeMicButtonLabel();
  }

  setLivePreviewPaused(false);
}

function getPracticeRecognition() {
  if (!SpeechRecognitionCtor) {
    return null;
  }

  if (practiceRecognition) {
    return practiceRecognition;
  }

  practiceRecognition = new SpeechRecognitionCtor();
  practiceRecognition.continuous = true;
  practiceRecognition.interimResults = true;
  practiceRecognition.lang = 'en-US';
  practiceRecognition.maxAlternatives = 1;

  practiceRecognition.onstart = () => {
    setPracticeMicStatus('Practice mic live', 'success');
    syncPracticeMicButtonLabel();
    setLivePreviewPaused(true);
    setPracticeStatus(
      'Practice mic active',
      'success',
      'The practice mic is capturing the question locally in this console only. It does not enter the normal viewer transcript stream.'
    );
  };

  practiceRecognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || '')
      .join(' ')
      .trim();

    if (!transcript) {
      return;
    }

    aiQuestionInput.value = transcript;
    setPracticeMicStatus('Listening locally', 'success');
  };

  practiceRecognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      practiceMicRequested = false;
      setPracticeMicStatus('Practice mic blocked', 'error');
      syncPracticeMicButtonLabel();
      setLivePreviewPaused(false);
      return;
    }

    if (event.error === 'no-speech') {
      setPracticeMicStatus('Listening...', 'loading');
      return;
    }

    setPracticeMicStatus('Practice mic error', 'error');
  };

  practiceRecognition.onend = () => {
    if (practiceMicRequested) {
      try {
        practiceRecognition.start();
        return;
      } catch {
        setPracticeMicStatus('Restarting practice mic...', 'loading');
      }
    }

    setPracticeMicStatus('Practice mic off', 'idle');
    syncPracticeMicButtonLabel();
    setLivePreviewPaused(false);
  };

  return practiceRecognition;
}

async function cleanupAudio() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

function float32ToInt16(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i += 1) {
    let sample = Math.max(-1, Math.min(1, float32Array[i]));
    sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return buffer;
}

async function startStreaming() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const backendBase = toWebSocketBase(pageBackendBase);
  socket = new WebSocket(`${backendBase}/ws/speak/${sessionId}?token=${encodeURIComponent(token)}`);
  socket.binaryType = 'arraybuffer';
  startBtn.disabled = true;
  setSpeakerStatus('Connecting', 'loading', 'Opening the secure speaker channel...');

  socket.onopen = async () => {
    try {
      setSpeakerStatus('Preparing mic', 'loading', 'Connected to the backend. Waiting for microphone access...');
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new AudioContext({ sampleRate: 16000 });
      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      processorNode = audioContext.createScriptProcessor(4096, 1, 1);

      processorNode.onaudioprocess = (event) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        socket.send(float32ToInt16(input));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
      setSpeakerStatus('Mic live', 'success', 'Audio is streaming to the backend and the transcript preview is active.');
      updateTranscriptPreview('Listening for speech...');
      stopBtn.disabled = false;
    } catch (error) {
      await cleanupAudio();
      setSpeakerStatus('Mic blocked', 'error', 'Microphone access failed. Allow mic access and try again.');
      updateTranscriptPreview(error instanceof Error ? error.message : 'Unable to start microphone capture.');
      stopBtn.disabled = true;
      startBtn.disabled = false;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send('STOP');
      }
      if (socket) {
        socket.close();
      }
    }
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'status') {
        setSpeakerStatus('Session update', 'neutral', payload.text);
      } else if (payload.type === 'error') {
        setSpeakerStatus('Attention needed', 'error', payload.text);
      } else if (payload.type === 'partial' || payload.type === 'final') {
        updateTranscriptPreview(payload.text || 'Listening for speech...');
      }
    } catch {
      updateTranscriptPreview(event.data);
    }
  };

  socket.onclose = async (event) => {
    await cleanupAudio();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    socket = null;

    if (event.code === 1008) {
      setSpeakerStatus('Access denied', 'error', 'This speaker link is missing a valid session token.');
      return;
    }

    setSpeakerStatus('Disconnected', 'warning', 'The speaker channel closed. Start the stream again to reconnect.');
  };

  socket.onerror = () => {
    setSpeakerStatus('Connection error', 'error', 'The speaker console could not reach the backend.');
  };
}

async function stopStreaming() {
  await cleanupAudio();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send('STOP');
  }
  if (socket) {
    socket.close();
  }
}

async function uploadResume() {
  const selectedFile = resumeFileInput.files?.[0];
  if (!selectedFile) {
    setResumeStatus('Choose a PDF or .docx resume first.', 'warning');
    return;
  }

  const formData = new FormData();
  formData.append('resume_file', selectedFile);

  uploadResumeBtn.disabled = true;
  setResumeStatus('Uploading resume to session memory...', 'loading');

  try {
    const response = await fetch(getPracticeApiUrl(`/practice/${sessionId}/resume`), {
      method: 'POST',
      headers: getPracticeHeaders(),
      body: formData,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || 'Resume upload failed.');
    }

    uploadedResumeMeta = payload;
    updateResumeMeta(payload);
    setResumeStatus('Resume uploaded and grounded in memory.', 'success');
    setPracticeStatus('Resume ready', 'success', 'Resume grounding is available for practice answers.');
  } catch (error) {
    uploadedResumeMeta = null;
    updateResumeMeta(null);
    setResumeStatus(error instanceof Error ? error.message : 'Resume upload failed.', 'error');
  } finally {
    uploadResumeBtn.disabled = false;
  }
}

async function sendPracticeAnswerToViewer(answerText = lastGeneratedAnswer, silentStatus = false) {
  const answer = (answerText || '').trim();
  if (!answer) {
    if (!silentStatus) {
      setPracticeStatus('Answer needed', 'warning', 'Generate a practice answer before sending anything to the viewer feed.');
    }
    return null;
  }

  sendAiToViewerBtn.disabled = true;

  if (!silentStatus) {
    setPracticeStatus('Sharing', 'loading', 'Streaming the current practice answer to the separate viewer feed...');
  }

  try {
    const response = await fetch(getPracticeApiUrl(`/practice/${sessionId}/broadcast-answer`), {
      method: 'POST',
      headers: getPracticeHeaders(true),
      body: JSON.stringify({ answer }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || 'Streaming the practice answer to the viewer feed failed.');
    }

    if (!silentStatus) {
      const sharedNote = payload.viewer_count > 0
        ? `Streamed the answer to ${payload.viewer_count} viewer${payload.viewer_count === 1 ? '' : 's'} in the separate practice feed.`
        : 'No viewer is connected right now, so the answer stayed local to this console.';
      setPracticeStatus('Viewer feed updated', 'success', sharedNote);
    }

    return payload;
  } catch (error) {
    if (!silentStatus) {
      setPracticeStatus(
        'Viewer send failed',
        'error',
        error instanceof Error ? error.message : 'Streaming the practice answer to the viewer feed failed.'
      );
    }
    throw error;
  } finally {
    sendAiToViewerBtn.disabled = !lastGeneratedAnswer;
  }
}

async function streamPracticeAnswerResponse(question, signal) {
  const response = await fetch(getPracticeApiUrl(`/practice/${sessionId}/answer-stream`), {
    method: 'POST',
    headers: getPracticeHeaders(true),
    body: JSON.stringify({
      question,
      share_to_viewer: autoSendToViewer,
    }),
    signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || 'Practice answer generation failed.');
  }

  if (!response.body) {
    throw new Error('Practice answer streaming is unavailable in this browser.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedAnswer = '';
  const metadata = {
    grounded: false,
    chunkCount: 0,
    resumeFileName: null,
    viewerCount: 0,
  };

  renderAnswerContent(aiAnswerBox, '', {
    placeholder: 'Streaming practice answer... generated code will format when ready.',
  });

  const handleLine = (line) => {
    const payload = JSON.parse(line);

    if (payload.type === 'start') {
      activePracticeStreamId = payload.stream_id || null;
      metadata.grounded = Boolean(payload.grounded);
      metadata.chunkCount = payload.chunk_count || 0;
      metadata.resumeFileName = payload.resume_file_name || null;
      metadata.viewerCount = payload.viewer_count || 0;
      return;
    }

    if (payload.type === 'delta') {
      streamedAnswer += payload.text || '';
      renderAnswerContent(aiAnswerBox, streamedAnswer, {
        streaming: true,
        placeholder: 'Streaming practice answer... generated code will format when ready.',
      });
      return;
    }

    if (payload.type === 'done') {
      activePracticeStreamId = null;
      streamedAnswer = payload.answer || streamedAnswer;
      metadata.grounded = Boolean(payload.grounded);
      metadata.chunkCount = payload.chunk_count || metadata.chunkCount;
      metadata.resumeFileName = payload.resume_file_name || metadata.resumeFileName;
      metadata.viewerCount = payload.viewer_count || metadata.viewerCount;
      renderAnswerContent(aiAnswerBox, streamedAnswer, {
        placeholder: practiceAnswerPlaceholder,
      });
      return;
    }

    if (payload.type === 'error') {
      throw new Error(payload.detail || 'Practice answer generation failed.');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        handleLine(line);
      }
      newlineIndex = buffer.indexOf('\n');
    }

    if (done) {
      break;
    }
  }

  const trailingLine = buffer.trim();
  if (trailingLine) {
    handleLine(trailingLine);
  }

  if (!streamedAnswer.trim()) {
    throw new Error('The practice model returned an empty response.');
  }

  return {
    answer: streamedAnswer,
    grounded: metadata.grounded,
    chunk_count: metadata.chunkCount,
    resume_file_name: metadata.resumeFileName,
    viewer_count: metadata.viewerCount,
  };
}

async function generatePracticeAnswer() {
  const question = aiQuestionInput.value.trim();
  if (!question) {
    setPracticeStatus('Question needed', 'warning', 'Add a practice question or reuse the live transcript first.');
    return;
  }

  const submittedQuestion = question;
  if (practiceMicRequested) {
    stopPracticeMic();
  }

  pendingPracticeMicStart = false;
  activePracticeStreamId = null;
  aiQuestionInput.value = '';
  lastGeneratedAnswer = '';
  practiceGenerationController = new AbortController();
  setPracticeGeneratingState(true);
  setPracticeStatus('Generating', 'loading', 'Streaming a grounded practice answer. You can interrupt at any time or jump back to the practice mic.');

  try {
    const payload = await streamPracticeAnswerResponse(submittedQuestion, practiceGenerationController.signal);
    lastGeneratedAnswer = payload.answer;
    const groundingNote = payload.grounded && uploadedResumeMeta
      ? `Grounded with ${payload.resume_file_name} using ${payload.chunk_count} resume chunks.`
      : 'No resume grounding was used for this answer, so keep it as conceptual practice only.';
    const viewerNote = autoSendToViewer
      ? payload.viewer_count > 0
        ? ` Streamed to ${payload.viewer_count} viewer${payload.viewer_count === 1 ? '' : 's'} in the separate practice feed.`
        : ' No viewer is connected right now, so the answer stayed local.'
      : '';
    setPracticeStatus('Answer ready', 'success', `${groundingNote}${viewerNote}`);
  } catch (error) {
    if (isAbortError(error)) {
      const interruptedStreamId = activePracticeStreamId;
      activePracticeStreamId = null;
      lastGeneratedAnswer = '';

      renderAnswerContent(aiAnswerBox, '', {
        placeholder: pendingPracticeMicStart
          ? 'Generation interrupted. Practice mic is ready for the next question.'
          : 'Generation interrupted. Start the next question whenever you are ready.',
      });

      if (interruptedStreamId && autoSendToViewer) {
        await cancelPracticeViewerStream(
          interruptedStreamId,
          pendingPracticeMicStart
            ? 'Practice answer interrupted so the speaker could capture a new question.'
            : 'Practice answer interrupted by the speaker.'
        );
      }

      setPracticeStatus(
        pendingPracticeMicStart ? 'Interrupted for next question' : 'Generation interrupted',
        'warning',
        pendingPracticeMicStart
          ? 'Stopped the current answer and switched back to practice mic capture.'
          : 'Stopped the current answer. You can type or capture the next question now.'
      );
    } else {
      aiQuestionInput.value = submittedQuestion;
      lastGeneratedAnswer = '';
      renderAnswerContent(aiAnswerBox, '', {
        placeholder: 'Practice answer generation failed.',
      });
      setPracticeStatus(error instanceof Error ? error.message : 'Practice answer generation failed.', 'error');
    }
  } finally {
    const shouldStartMic = pendingPracticeMicStart;
    pendingPracticeMicStart = false;
    practiceGenerationController = null;
    activePracticeStreamId = null;
    setPracticeGeneratingState(false);

    if (shouldStartMic) {
      startPracticeMicCapture();
    }
  }
}

startBtn.addEventListener('click', startStreaming);
stopBtn.addEventListener('click', stopStreaming);
copyViewerBtn.addEventListener('click', async () => {
  const viewerLink = getViewerLink();
  if (!viewerLink) {
    setSpeakerStatus('Viewer link unavailable', 'warning', 'Open this page from the control room to get the secure viewer link.');
    return;
  }

  await copyText(viewerLink);
  setSpeakerStatus('Viewer link copied', 'success', 'Secure viewer link copied to the clipboard.');
});
uploadResumeBtn.addEventListener('click', uploadResume);
useTranscriptBtn.addEventListener('click', () => {
  const transcriptText = transcriptBox.textContent.trim();
  if (!transcriptText || transcriptText === transcriptPlaceholder || transcriptText === 'Listening for speech...') {
    setPracticeStatus('Transcript unavailable', 'warning', 'Start the mic or paste a question before reusing transcript text.');
    return;
  }

  aiQuestionInput.value = transcriptText;
  setPracticeStatus('Transcript copied', 'success', 'Live transcript preview copied into the practice question box.');
});
generateAiBtn.addEventListener('click', generatePracticeAnswer);
sendAiToViewerBtn.addEventListener('click', () => {
  sendPracticeAnswerToViewer().catch(() => {});
});
interruptAiBtn.addEventListener('click', () => {
  interruptPracticeAnswer();
});
interruptToMicBtn.addEventListener('click', () => {
  interruptPracticeAnswer({ startMicAfter: true });
});
toggleAutoSendBtn.addEventListener('click', () => {
  setAutoSendToViewer(!autoSendToViewer);
  setPracticeStatus(
    autoSendToViewer ? 'Auto-send enabled' : 'Auto-send disabled',
    'neutral',
    autoSendToViewer
      ? 'New practice answers will be pushed into the separate viewer practice feed automatically.'
      : 'Practice answers will stay local until you send them to the viewer feed manually.'
  );
});
togglePracticeMicBtn.addEventListener('click', () => {
  if (practiceGenerating) {
    interruptPracticeAnswer({ startMicAfter: true });
    return;
  }

  if (practiceMicRequested) {
    stopPracticeMic();
    return;
  }

  startPracticeMicCapture();
});

if (!viewerToken) {
  copyViewerBtn.disabled = true;
  setSpeakerStatus('Idle', 'idle', 'Viewer copy is disabled because this page was not opened from the control room.');
} else {
  setSpeakerStatus('Idle', 'idle', 'Ready when you are. Start the mic to begin streaming.');
}

setPracticeStatus('Practice AI idle', 'idle', 'Upload a resume for stronger grounding, then generate a practice answer here.');
setPracticeMicStatus(SpeechRecognitionCtor ? 'Practice mic off' : 'Practice mic unsupported', SpeechRecognitionCtor ? 'idle' : 'warning');
setAutoSendToViewer(false);
if (!SpeechRecognitionCtor) {
  togglePracticeMicBtn.disabled = true;
}
setPracticeGeneratingState(false);
renderAnswerContent(aiAnswerBox, '', {
  placeholder: practiceAnswerPlaceholder,
});
updateResumeMeta(null);
