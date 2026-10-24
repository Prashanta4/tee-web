// ===========================
// Global Variables
// ===========================
let selectedFile = null;
let isProcessing = false;
let progressInterval = null;
let lastResult = null; // { data, mode } used by the report download

// ===========================
// Configuration
// ===========================
const BASE_URL = "https://prasanta4-tea-disease-classification-model.hf.space";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const TIMEOUT_PREDICT_MS = 30000;
const TIMEOUT_EXPLAIN_MS = 180000;

const XAI_INFO = {
    gradcam: {
        title: 'Grad-CAM',
        text: 'Warm regions show where the model looked most when choosing this class.'
    },
    shap: {
        title: 'SHAP',
        text: 'Highlights the pixels that contributed most to the predicted class.'
    },
    lime: {
        title: 'LIME',
        text: 'Highlights the leaf segments that most influenced the prediction.'
    }
};

// ===========================
// DOM Elements
// ===========================
const imageInput = document.getElementById('imageInput');
const uploadArea = document.getElementById('uploadArea');
const chooseFileBtn = document.getElementById('chooseFileBtn');
const preview = document.getElementById('preview');
const result = document.getElementById('result');
const error = document.getElementById('error');
const errorMessage = document.getElementById('errorMessage');
const predictBtn = document.getElementById('predictBtn');
const xaiBtn = document.getElementById('xaiBtn');

const statusIndicator = document.getElementById('statusIndicator');
const statusText = statusIndicator.querySelector('.status-text');
const loadingProgress = document.getElementById('loadingProgress');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');
const progressHint = document.getElementById('progressHint');

// ===========================
// Initialization
// ===========================
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    checkBackendStatus();
    setInterval(checkBackendStatus, 10000); // poll every 10 seconds
});

function initializeEventListeners() {
    imageInput.addEventListener('change', handleFileSelect);
    chooseFileBtn.addEventListener('click', e => {
        e.stopPropagation(); // avoid double-opening via the upload area click
        imageInput.click();
    });

    predictBtn.addEventListener('click', () => predictImage('predict'));
    xaiBtn.addEventListener('click', () => predictImage('explain'));

    uploadArea.addEventListener('click', () => imageInput.click());
    uploadArea.addEventListener('dragover', e => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', e => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', handleDrop);

    // Stop the browser from opening dropped files outside the drop zone
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => e.preventDefault());
}

// ===========================
// Backend Status Check
// ===========================
async function checkBackendStatus() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${BASE_URL}/health`, { signal: controller.signal });
        updateStatusUI(response.ok);
    } catch (err) {
        updateStatusUI(false);
    } finally {
        clearTimeout(timeoutId);
    }
}

function updateStatusUI(isOnline) {
    statusIndicator.className = `d-flex align-items-center ${isOnline ? 'status-online' : 'status-offline'}`;
    statusText.textContent = isOnline ? 'System Online' : 'System Offline';
}

// ===========================
// File Handling
// ===========================
function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) validateAndProcessFile(file);
    e.target.value = ''; // allow re-selecting the same file
}

function handleDrop(e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) validateAndProcessFile(files[0]);
}

function validateAndProcessFile(file) {
    hideError();

    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/gif'];
    if (!allowed.includes(file.type)) {
        return showError('Invalid file type. Please upload a JPG, PNG, or GIF image.');
    }
    if (file.size > MAX_FILE_SIZE) {
        return showError('File must be under 10MB.');
    }

    selectedFile = file;
    hideResult();
    displayImagePreview(file);
    enableButtons();
}

function displayImagePreview(file) {
    const reader = new FileReader();
    reader.onload = e => {
        preview.innerHTML = `
            <div class="preview-container">
                <img src="${e.target.result}" class="img-fluid rounded" alt="Preview">
                <div class="image-overlay" id="removeImageBtn" title="Remove image">
                    <i class="fas fa-times"></i>
                </div>
            </div>
            <div class="mt-3">
                <h6 class="text-center mb-1">
                    <i class="fas fa-file-image me-2"></i>${escapeHtml(file.name)}
                </h6>
                <p class="text-center text-muted small mb-0">
                    Size: ${formatFileSize(file.size)} | Type: ${escapeHtml(file.type)}
                </p>
            </div>
        `;
        preview.classList.add('show');
        document.getElementById('removeImageBtn').addEventListener('click', removeImage);
        uploadArea.style.display = 'none';
    };
    reader.readAsDataURL(file);
}

function removeImage() {
    if (isProcessing) return; // don't discard the image mid-analysis
    selectedFile = null;
    lastResult = null;
    preview.innerHTML = '';
    preview.classList.remove('show');
    uploadArea.style.display = 'block';
    disableButtons();
    hideResult();
    hideError();
    stopProgress();
}

function resetAnalysis() {
    removeImage();
    uploadArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ===========================
// UI State Management
// ===========================
function enableButtons() {
    [predictBtn, xaiBtn].forEach(btn => { btn.disabled = false; });
}

function disableButtons() {
    [predictBtn, xaiBtn].forEach(btn => { btn.disabled = true; });
}

// ===========================
// Prediction / XAI Handling
// ===========================
async function predictImage(mode) {
    if (!selectedFile || isProcessing) return;

    hideError();
    hideResult();
    isProcessing = true;
    disableButtons();
    startProgressSimulation(mode);

    const controller = new AbortController();
    const timeoutId = setTimeout(
        () => controller.abort(),
        mode === 'explain' ? TIMEOUT_EXPLAIN_MS : TIMEOUT_PREDICT_MS
    );

    try {
        const endpoint = mode === 'explain' ? `${BASE_URL}/explain` : `${BASE_URL}/predict`;
        const formData = new FormData();
        formData.append('file', selectedFile);

        const response = await fetch(endpoint, {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });

        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
                const body = await response.json();
                if (body && body.detail) detail = `${detail}: ${body.detail}`;
            } catch (_) { /* ignore non-JSON error bodies */ }
            throw new Error(detail);
        }

        const data = await response.json();
        if (!data || typeof data.predicted_class !== 'string' || typeof data.confidence_score !== 'number') {
            throw new Error('Invalid response from server.');
        }

        finishProgress();
        // Short delay so the bar visibly reaches 100% before results appear
        setTimeout(() => displayResults(data, mode), 500);

    } catch (err) {
        console.error(err);
        stopProgress();
        if (err.name === 'AbortError') {
            showError('Request timed out. The server may be waking up, please try again.');
        } else if (err instanceof TypeError) {
            showError('Network error. Please check your connection and try again.');
        } else {
            showError(`Failed to analyze. ${err.message}`);
        }
    } finally {
        clearTimeout(timeoutId);
        isProcessing = false;
        if (selectedFile) enableButtons();
    }
}

// ===========================
// Progress Bar Logic
// ===========================
function startProgressSimulation(mode) {
    loadingProgress.classList.remove('d-none');
    progressBar.classList.add('progress-bar-animated');
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    progressText.textContent = mode === 'explain' ? 'Generating Explanations...' : 'Analyzing Leaf...';
    progressHint.textContent = mode === 'explain'
        ? 'This might take up to 40 seconds for XAI analysis...'
        : 'This usually takes just a few seconds...';
    progressHint.classList.remove('d-none');

    // Ease-out curve: fast at first, then slows toward 92% until the real response arrives
    const tau = mode === 'explain' ? 15000 : 1000; // ms
    const start = performance.now();

    clearInterval(progressInterval);
    progressInterval = setInterval(() => {
        const t = performance.now() - start;
        const progress = 92 * (1 - Math.exp(-t / tau));
        progressBar.style.width = `${progress}%`;
        progressPercent.textContent = `${Math.round(progress)}%`;
    }, 100);
}

function finishProgress() {
    clearInterval(progressInterval);
    progressBar.style.width = '100%';
    progressPercent.textContent = '100%';
    progressBar.classList.remove('progress-bar-animated');
    setTimeout(stopProgress, 1000);
}

function stopProgress() {
    clearInterval(progressInterval);
    loadingProgress.classList.add('d-none');
    progressBar.style.width = '0%';
    progressBar.classList.add('progress-bar-animated');
}

// ===========================
// Display Results
// ===========================
function displayResults(data, mode) {
    lastResult = { data, mode };

    const confidence = Math.round(data.confidence_score * 100);
    const confidenceColor = confidence >= 80 ? 'success' : confidence >= 60 ? 'warning' : 'danger';
    const isHealthy = data.predicted_class.toLowerCase().includes('healthy');
    const badgeClass = isHealthy ? 'bg-success' : 'bg-danger';

    let xaiHTML = '';
    if (mode === 'explain' && data.xai) {
        const methods = Object.keys(XAI_INFO);
        const cards = methods
            .filter(m => data.xai[m])
            .map(m => `
                <div class="col-md-4 mb-3">
                    <div class="xai-card">
                        <div class="xai-card-title">${XAI_INFO[m].title}</div>
                        <div class="p-2">
                            <img src="data:image/png;base64,${data.xai[m]}"
                                 class="img-fluid rounded"
                                 alt="${XAI_INFO[m].title} visualization">
                        </div>
                        <p class="xai-card-text">${XAI_INFO[m].text}</p>
                    </div>
                </div>
            `).join('');

        const errors = methods
            .filter(m => data.xai[`${m}_error`])
            .map(m => `
                <div class="alert alert-warning py-2 small mb-2">
                    <i class="fas fa-exclamation-circle me-2"></i>
                    ${XAI_INFO[m].title} unavailable: ${escapeHtml(String(data.xai[`${m}_error`]))}
                </div>
            `).join('');

        xaiHTML = `
            <div class="text-center mt-4">
                <h5><i class="fas fa-eye me-2"></i>Explainability Maps</h5>
                <div class="row justify-content-center mt-3">${cards}</div>
                ${errors}
            </div>
        `;
    }

    result.innerHTML = `
        <div class="result-card">
            <div class="result-header">
                <i class="fas fa-chart-line"></i>
                <h4 class="mb-0">${mode === 'explain' ? 'XAI Analysis Results' : 'AI Analysis Results'}</h4>
            </div>

            ${data.filename ? `
            <div class="result-item">
                <span class="result-label"><i class="fas fa-file me-2"></i>Filename:</span>
                <span class="result-value">${escapeHtml(data.filename)}</span>
            </div>` : ''}

            <div class="result-item">
                <span class="result-label"><i class="fas fa-diagnosis me-2"></i>Predicted Class:</span>
                <span class="result-value">
                    <span class="badge ${badgeClass} fs-6">${escapeHtml(data.predicted_class)}</span>
                </span>
            </div>

            <div class="result-item">
                <span class="result-label"><i class="fas fa-percentage me-2"></i>Confidence:</span>
                <div class="text-end">
                    <span class="result-value text-${confidenceColor}">${confidence}%</span>
                    <div class="confidence-bar">
                        <div class="confidence-fill" id="confidenceFill" style="width: 0%"></div>
                    </div>
                </div>
            </div>

            ${xaiHTML}

            <div class="mt-4 p-3 bg-light rounded">
                <div class="d-flex align-items-center mb-2">
                    <i class="fas fa-info-circle text-info me-2"></i>
                    <strong>Important Note</strong>
                </div>
                <p class="mb-0 small text-muted">
                    This AI analysis is for educational and research purposes only.
                    Please consult a qualified agricultural expert for proper diagnosis and treatment.
                </p>
            </div>

            <div class="text-center mt-4 d-flex justify-content-center gap-2 flex-wrap">
                <button class="btn btn-outline-success" id="downloadBtn">
                    <i class="fas fa-download me-2"></i>Download Report
                </button>
                <button class="btn btn-outline-secondary" id="resetBtn">
                    <i class="fas fa-redo me-2"></i>New Analysis
                </button>
            </div>
        </div>
    `;

    document.getElementById('downloadBtn').addEventListener('click', downloadReport);
    document.getElementById('resetBtn').addEventListener('click', resetAnalysis);

    result.style.display = 'block';

    // Animate the confidence bar
    requestAnimationFrame(() => {
        setTimeout(() => {
            const fill = document.getElementById('confidenceFill');
            if (fill) fill.style.width = `${confidence}%`;
        }, 100);
    });

    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ===========================
// Report Download
// ===========================
function downloadReport() {
    if (!lastResult) {
        showError('No results available to download.');
        return;
    }

    try {
        const { data, mode } = lastResult;
        const confidence = Math.round(data.confidence_score * 100);
        const timestamp = new Date().toLocaleString();
        const xaiUsed = mode === 'explain'
            ? Object.keys(XAI_INFO).filter(m => data.xai && data.xai[m]).map(m => XAI_INFO[m].title).join(', ') || 'None available'
            : 'Not requested';

        const report = [
            'TEA LEAF DISEASE ANALYSIS REPORT',
            '================================',
            '',
            `Generated: ${timestamp}`,
            '',
            'ANALYSIS RESULTS',
            '================',
            `Filename: ${data.filename || (selectedFile ? selectedFile.name : 'N/A')}`,
            `Predicted Class: ${data.predicted_class}`,
            `Confidence Score: ${confidence}%`,
            `Explainability Methods: ${xaiUsed}`,
            '',
            'IMPORTANT DISCLAIMER',
            '====================',
            'This AI analysis is for educational and research purposes only.',
            'The results should NOT be used as the sole basis for treatment decisions.',
            'Please consult a qualified agricultural expert for proper evaluation.'
        ].join('\n');

        const blob = new Blob([report], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `tea-disease-analysis-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Download error:', err);
        showError('Failed to generate report. Please try again.');
    }
}

// ===========================
// Helpers
// ===========================
function showError(msg) {
    errorMessage.textContent = msg;
    error.classList.remove('d-none');
}

function hideError() {
    error.classList.add('d-none');
    errorMessage.textContent = '';
}

function hideResult() {
    result.style.display = 'none';
    result.innerHTML = '';
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
