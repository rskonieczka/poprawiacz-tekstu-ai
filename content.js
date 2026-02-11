(function () {
  'use strict';

  const DEFAULT_PROMPT_TEMPLATE =
    'Zredaguj nastepujacy tekst. Ton: {{ton}}. Styl: {{styl}}.{{kontekst}}{{cel}}\n\nTekst do redakcji:\n"""{{tekst}}"""';

  const SPELLCHECK_PROMPT =
    'Popraw WYLACZNIE bledy ortograficzne i gramatyczne w ponizszym tekscie. NIE zmieniaj stylu, tonu, struktury zdan ani doboru slow. Zachowaj oryginalne formatowanie. Zwroc TYLKO poprawiony tekst.\n\nTekst:\n"""{{tekst}}"""';

  const TONE_OPTIONS = [
    'przyjacielski',
    'profesjonalny',
    'formalny',
    'nieformalny',
    'entuzjastyczny',
    'neutralny',
    'perswazyjny',
    'empatyczny'
  ];

  const STYLE_OPTIONS = [
    'informatywny',
    'narracyjny',
    'opisowy',
    'zwiezly',
    'szczegolowy',
    'marketingowy',
    'techniczny',
    'konwersacyjny'
  ];

  let currentSelection = null;
  let modalElement = null;
  let activeAbortController = null;
  let timerInterval = null;
  let originalRangeContent = null;

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        {
          apiKey: '',
          model: 'gpt-4o-mini',
          tempEdit: 0.7,
          tempSpellcheck: 0.2,
          tone: 'przyjacielski',
          lastContext: '',
          lastGoal: '',
          style: 'informatywny',
          promptTemplate: DEFAULT_PROMPT_TEMPLATE
        },
        resolve
      );
    });
  }

  function saveSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(settings, resolve);
    });
  }

  function buildPrompt(template, data) {
    let prompt = template
      .replace('{{ton}}', data.tone)
      .replace('{{styl}}', data.style)
      .replace('{{tekst}}', data.text);

    if (data.context && data.context.trim()) {
      prompt = prompt.replace('{{kontekst}}', ' Wez pod uwage: ' + data.context.trim() + '.');
    } else {
      prompt = prompt.replace('{{kontekst}}', '');
    }

    if (data.goal && data.goal.trim()) {
      prompt = prompt.replace('{{cel}}', ' Moj cel to: ' + data.goal.trim() + '.');
    } else {
      prompt = prompt.replace('{{cel}}', '');
    }

    return prompt;
  }

  async function callOpenAIStream(apiKey, model, prompt, temperature, onToken, signal) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content:
              'Jestes profesjonalnym redaktorem tekstu. Zwracasz TYLKO zredagowany tekst, bez komentarzy, wyjasnie ani dodatkowych oznaczen.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: temperature,
        max_tokens: 4096,
        stream: true
      }),
      signal: signal
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Blad API: ' + response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') break;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onToken(fullText);
          }
        } catch (e) {
          // skip malformed chunks
        }
      }
    }

    return fullText;
  }

  function buildSelectOptions(options, selected) {
    return options
      .map(
        (opt) =>
          '<option value="' + opt + '"' + (opt === selected ? ' selected' : '') + '>' + opt + '</option>'
      )
      .join('');
  }

  let debounceTimer = null;
  function updatePromptPreviewDebounced(modal) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updatePromptPreview(modal), 150);
  }

  function updatePromptPreview(modal) {
    const previewEl = modal.querySelector('#cr-ai-prompt-preview');
    if (!previewEl || previewEl.style.display === 'none') return;

    const template = modal.querySelector('#cr-ai-prompt-tpl').value;
    const tone = modal.querySelector('#cr-ai-tone').value;
    const style = modal.querySelector('#cr-ai-style').value;
    const context = modal.querySelector('#cr-ai-context').value;
    const goal = modal.querySelector('#cr-ai-goal').value;
    const text = modal.querySelector('#cr-ai-source').value;

    const preview = buildPrompt(template, {
      tone: tone,
      style: style,
      context: context,
      goal: goal,
      text: text
    });

    previewEl.textContent = preview;
  }

  function createModal(selectedText) {
    if (modalElement) {
      modalElement.remove();
    }

    const overlay = document.createElement('div');
    overlay.id = 'cr-ai-overlay';

    overlay.innerHTML = `
      <div id="cr-ai-modal">
        <div class="cr-ai-header">
          <h2>Poprawiacz tekstu AI</h2>
          <span class="cr-ai-model-badge" id="cr-ai-model-badge"></span>
          <button class="cr-ai-close-btn" id="cr-ai-close" title="Zamknij">&times;</button>
        </div>

        <div class="cr-ai-body">

          <div class="cr-ai-field">
            <label for="cr-ai-source">Zaznaczony tekst</label>
            <textarea class="cr-ai-source-text" id="cr-ai-source" rows="3">${escapeHtml(selectedText)}</textarea>
          </div>

          <div class="cr-ai-field cr-ai-checkbox-field">
            <label class="cr-ai-checkbox-label">
              <input type="checkbox" id="cr-ai-spellcheck" />
              <span class="cr-ai-checkbox-text">Popraw tylko bledy ortograficzne i gramatyczne</span>
            </label>
          </div>

          <div id="cr-ai-redaction-options">
          <div class="cr-ai-row">
            <div class="cr-ai-field">
              <label for="cr-ai-tone">Ton</label>
              <select id="cr-ai-tone">
                ${buildSelectOptions(TONE_OPTIONS, 'przyjacielski')}
              </select>
            </div>
            <div class="cr-ai-field">
              <label for="cr-ai-style">Styl</label>
              <select id="cr-ai-style">
                ${buildSelectOptions(STYLE_OPTIONS, 'informatywny')}
              </select>
            </div>
          </div>

          <div class="cr-ai-field">
            <label for="cr-ai-context">Kontekst (opcjonalnie)</label>
            <input type="text" id="cr-ai-context" placeholder="np. artykul o zdrowym odzywianiu dla kobiet 30+" />
          </div>

          <div class="cr-ai-field">
            <label for="cr-ai-goal">Cel (opcjonalnie)</label>
            <input type="text" id="cr-ai-goal" placeholder="np. zwiekszenie zaangazowania czytelnikow" />
          </div>

          <div class="cr-ai-field">
            <label>
              Szablon promptu
              <button class="cr-ai-toggle-prompt" id="cr-ai-toggle-prompt">pokaz / edytuj</button>
            </label>
            <textarea id="cr-ai-prompt-tpl" rows="3" style="display:none">${escapeHtml(DEFAULT_PROMPT_TEMPLATE)}</textarea>
            <div id="cr-ai-prompt-preview" class="cr-ai-prompt-preview" style="display:none"></div>
          </div>
          </div>

          <div class="cr-ai-field cr-ai-result-container" id="cr-ai-result-wrap">
            <label for="cr-ai-result">Zredagowany tekst</label>
            <div class="cr-ai-skeleton" id="cr-ai-skeleton">
              <div class="cr-ai-skeleton-line" style="width:95%"></div>
              <div class="cr-ai-skeleton-line" style="width:80%"></div>
              <div class="cr-ai-skeleton-line" style="width:90%"></div>
              <div class="cr-ai-skeleton-line" style="width:60%"></div>
            </div>
            <textarea class="cr-ai-result-text" id="cr-ai-result" rows="4"></textarea>
          </div>

        </div>

        <div id="cr-ai-status-wrap">
          <div class="cr-ai-status" id="cr-ai-status"></div>
        </div>

        <div class="cr-ai-actions">
          <button class="cr-ai-btn cr-ai-btn-secondary" id="cr-ai-cancel">Anuluj</button>
          <button class="cr-ai-btn cr-ai-btn-primary" id="cr-ai-submit">Redaguj</button>
          <button class="cr-ai-btn cr-ai-btn-danger" id="cr-ai-abort" style="display:none">Przerwij</button>
          <button class="cr-ai-btn cr-ai-btn-success" id="cr-ai-replace" style="display:none">Wstaw tekst</button>
          <button class="cr-ai-btn cr-ai-btn-secondary" id="cr-ai-copy" style="display:none">Kopiuj</button>
          <button class="cr-ai-btn cr-ai-btn-warning" id="cr-ai-undo" style="display:none">Cofnij zmiane</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    modalElement = overlay;

    bindModalEvents(overlay);

    loadSettings().then((settings) => {
      const modal = overlay.querySelector('#cr-ai-modal');
      if (!modal) return;
      const badge = modal.querySelector('#cr-ai-model-badge');
      if (badge) badge.textContent = settings.model || 'gpt-4o-mini';
      modal.querySelector('#cr-ai-tone').value = settings.tone;
      modal.querySelector('#cr-ai-style').value = settings.style;
      if (settings.lastContext) modal.querySelector('#cr-ai-context').value = settings.lastContext;
      if (settings.lastGoal) modal.querySelector('#cr-ai-goal').value = settings.lastGoal;
      if (settings.promptTemplate) {
        modal.querySelector('#cr-ai-prompt-tpl').value = settings.promptTemplate;
      }
    });
  }

  function bindModalEvents(overlay) {
    const modal = overlay.querySelector('#cr-ai-modal');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    modal.querySelector('#cr-ai-close').addEventListener('click', closeModal);
    modal.querySelector('#cr-ai-cancel').addEventListener('click', closeModal);

    document.addEventListener('keydown', handleEsc);

    const toggleBtn = modal.querySelector('#cr-ai-toggle-prompt');
    const tplField = modal.querySelector('#cr-ai-prompt-tpl');
    const previewEl = modal.querySelector('#cr-ai-prompt-preview');

    toggleBtn.addEventListener('click', () => {
      const hidden = tplField.style.display === 'none';
      tplField.style.display = hidden ? '' : 'none';
      previewEl.style.display = hidden ? '' : 'none';
      if (hidden) updatePromptPreview(modal);
    });

    ['#cr-ai-tone', '#cr-ai-style', '#cr-ai-context', '#cr-ai-goal', '#cr-ai-source', '#cr-ai-prompt-tpl'].forEach(
      (sel) => {
        modal.querySelector(sel).addEventListener('input', () => updatePromptPreviewDebounced(modal));
      }
    );

    const spellcheckCb = modal.querySelector('#cr-ai-spellcheck');
    const redactionOpts = modal.querySelector('#cr-ai-redaction-options');
    spellcheckCb.addEventListener('change', () => {
      if (spellcheckCb.checked) {
        redactionOpts.classList.add('cr-ai-disabled');
        redactionOpts.querySelectorAll('select, input, textarea, button').forEach(el => el.disabled = true);
      } else {
        redactionOpts.classList.remove('cr-ai-disabled');
        redactionOpts.querySelectorAll('select, input, textarea, button').forEach(el => el.disabled = false);
      }
    });

    modal.querySelector('#cr-ai-submit').addEventListener('click', () => handleSubmit(modal));
    modal.querySelector('#cr-ai-abort').addEventListener('click', () => handleAbort());
    modal.querySelector('#cr-ai-replace').addEventListener('click', () => handleReplace(modal));
    modal.querySelector('#cr-ai-copy').addEventListener('click', () => handleCopy(modal));
    modal.querySelector('#cr-ai-undo').addEventListener('click', () => handleUndo(modal));
  }

  function handleEsc(e) {
    if (e.key === 'Escape') {
      if (activeAbortController) {
        handleAbort();
      } else {
        closeModal();
      }
    }
  }

  function closeModal() {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    clearInterval(timerInterval);
    timerInterval = null;
    if (modalElement) {
      modalElement.remove();
      modalElement = null;
    }
    document.removeEventListener('keydown', handleEsc);
  }

  function setStatus(modal, text, type) {
    const wrap = modal.querySelector('#cr-ai-status-wrap');
    if (!wrap) return;

    if (type === 'error') {
      wrap.innerHTML = `
        <div class="cr-ai-status-banner cr-ai-error-banner">
          <span class="cr-ai-error-icon">!</span>
          <span class="cr-ai-error-text">${escapeHtml(text)}</span>
          <button class="cr-ai-btn-retry" id="cr-ai-retry">Ponow probe</button>
        </div>`;
      const retryBtn = wrap.querySelector('#cr-ai-retry');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          wrap.innerHTML = '<div class="cr-ai-status" id="cr-ai-status"></div>';
          handleSubmit(modal);
        });
      }
    } else {
      const el = wrap.querySelector('.cr-ai-status') || wrap.querySelector('.cr-ai-error-banner');
      if (el && el.classList.contains('cr-ai-status')) {
        el.textContent = text;
      } else {
        wrap.innerHTML = '<div class="cr-ai-status" id="cr-ai-status">' + escapeHtml(text) + '</div>';
      }
    }
  }

  function startTimer(modal) {
    let seconds = 0;
    const statusEl = () => modal.querySelector('#cr-ai-status');
    timerInterval = setInterval(() => {
      seconds++;
      const el = statusEl();
      if (el) {
        el.textContent = 'Redagowanie... (' + seconds + 's)';
      }
    }, 1000);
    return () => {
      clearInterval(timerInterval);
      timerInterval = null;
    };
  }

  async function handleSubmit(modal) {
    const settings = await loadSettings();

    if (!settings.apiKey) {
      setStatus(modal, 'Brak klucza API. Ustaw go w konfiguracji wtyczki (ikona na pasku).', 'error');
      return;
    }

    const sourceText = modal.querySelector('#cr-ai-source').value.trim();
    if (!sourceText) {
      setStatus(modal, 'Brak tekstu do redakcji.', 'error');
      return;
    }

    const estimatedTokens = Math.ceil(sourceText.length / 3);
    if (estimatedTokens > 30000) {
      setStatus(modal, 'Tekst jest zbyt dlugi (~' + estimatedTokens + ' tokenow). Maksimum to ok. 30 000 tokenow.', 'error');
      return;
    }
    if (estimatedTokens > 12000) {
      setStatus(modal, 'Uwaga: dlugi tekst (~' + estimatedTokens + ' tokenow). Przetwarzanie moze potrwac dluzej.', 'info');
    }

    const isSpellcheck = modal.querySelector('#cr-ai-spellcheck').checked;
    const tone = modal.querySelector('#cr-ai-tone').value;
    const style = modal.querySelector('#cr-ai-style').value;
    const context = modal.querySelector('#cr-ai-context').value;
    const goal = modal.querySelector('#cr-ai-goal').value;
    const template = modal.querySelector('#cr-ai-prompt-tpl').value;

    await saveSettings({
      apiKey: settings.apiKey,
      model: settings.model,
      tone: tone,
      style: style,
      lastContext: context,
      lastGoal: goal,
      promptTemplate: template
    });

    let prompt;
    if (isSpellcheck) {
      prompt = SPELLCHECK_PROMPT.replace('{{tekst}}', sourceText);
    } else {
      prompt = buildPrompt(template, {
        tone: tone,
        style: style,
        context: context,
        goal: goal,
        text: sourceText
      });
    }

    const submitBtn = modal.querySelector('#cr-ai-submit');
    const abortBtn = modal.querySelector('#cr-ai-abort');
    const resultWrap = modal.querySelector('#cr-ai-result-wrap');
    const skeleton = modal.querySelector('#cr-ai-skeleton');
    const resultArea = modal.querySelector('#cr-ai-result');

    submitBtn.style.display = 'none';
    abortBtn.style.display = '';
    modal.querySelector('#cr-ai-replace').style.display = 'none';
    modal.querySelector('#cr-ai-copy').style.display = 'none';
    modal.querySelector('#cr-ai-undo').style.display = 'none';

    resultWrap.classList.add('cr-ai-visible');
    skeleton.style.display = '';
    resultArea.style.display = 'none';
    resultArea.value = '';

    setStatus(modal, 'Redagowanie... (0s)', 'info');
    const stopTimer = startTimer(modal);

    activeAbortController = new AbortController();
    const signal = activeAbortController.signal;

    const timeout = setTimeout(() => {
      if (activeAbortController) activeAbortController.abort();
    }, 60000);

    try {
      skeleton.style.display = 'none';
      resultArea.style.display = '';
      resultArea.classList.add('cr-ai-result-appear');

      const temperature = isSpellcheck
        ? (settings.tempSpellcheck ?? 0.2)
        : (settings.tempEdit ?? 0.7);

      const fullText = await callOpenAIStream(
        settings.apiKey,
        settings.model,
        prompt,
        temperature,
        (textSoFar) => {
          resultArea.value = textSoFar;
          resultArea.scrollTop = resultArea.scrollHeight;
        },
        signal
      );

      resultArea.value = fullText;
      modal.querySelector('#cr-ai-replace').style.display = '';
      modal.querySelector('#cr-ai-copy').style.display = '';
      setStatus(modal, 'Gotowe. Mozesz wstawic zredagowany tekst lub skopiowac go.', 'info');
    } catch (err) {
      if (err.name === 'AbortError') {
        setStatus(modal, 'Przerwano redagowanie.', 'info');
      } else {
        setStatus(modal, err.message, 'error');
      }
      skeleton.style.display = 'none';
      resultArea.style.display = '';
    } finally {
      clearTimeout(timeout);
      stopTimer();
      activeAbortController = null;
      submitBtn.style.display = '';
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Redaguj ponownie';
      abortBtn.style.display = 'none';
    }
  }

  function handleAbort() {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
  }

  function handleReplace(modal) {
    const result = modal.querySelector('#cr-ai-result').value;
    if (!result) return;

    if (currentSelection) {
      try {
        const range = currentSelection;
        const fragment = range.cloneContents();
        originalRangeContent = { range: range.cloneRange(), fragment: fragment };

        range.deleteContents();
        range.insertNode(document.createTextNode(result));

        modal.querySelector('#cr-ai-undo').style.display = '';
        setStatus(modal, 'Tekst wstawiony. Mozesz cofnac zmiane.', 'info');
      } catch (e) {
        setStatus(modal, 'Nie udalo sie wstawic tekstu. Skopiuj go recznie.', 'error');
      }
    } else {
      setStatus(modal, 'Brak zaznaczenia. Skopiuj tekst recznie.', 'error');
    }
  }

  function handleUndo(modal) {
    if (!originalRangeContent) return;

    try {
      const range = originalRangeContent.range;
      range.deleteContents();
      range.insertNode(originalRangeContent.fragment.cloneNode(true));

      originalRangeContent = null;
      modal.querySelector('#cr-ai-undo').style.display = 'none';
      setStatus(modal, 'Cofnieto zmiane. Oryginalny tekst przywrocony.', 'info');
    } catch (e) {
      setStatus(modal, 'Nie udalo sie cofnac zmiany.', 'error');
    }
  }

  function handleCopy(modal) {
    const result = modal.querySelector('#cr-ai-result').value;
    if (!result) return;

    const copyBtn = modal.querySelector('#cr-ai-copy');
    const originalText = copyBtn.textContent;
    const originalClass = copyBtn.className;

    navigator.clipboard.writeText(result).then(
      () => {
        copyBtn.textContent = 'Skopiowano!';
        copyBtn.className = 'cr-ai-btn cr-ai-btn-copy-success';
        setTimeout(() => {
          copyBtn.textContent = originalText;
          copyBtn.className = originalClass;
        }, 1500);
      },
      () => setStatus(modal, 'Nie udalo sie skopiowac. Zaznacz tekst recznie.', 'error')
    );
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  function captureSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      currentSelection = sel.getRangeAt(0).cloneRange();
    }
  }

  document.addEventListener('mouseup', (e) => {
    if (modalElement && modalElement.contains(e.target)) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      captureSelection();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'ping') {
      sendResponse({ status: 'ok' });
      return;
    }
    if (msg.action === 'open-modal' && msg.selectedText) {
      captureSelection();
      createModal(msg.selectedText);
    }
  });
})();
