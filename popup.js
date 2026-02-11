const DEFAULT_PROMPT_TEMPLATE =
  'Zredaguj nastepujacy tekst. Ton: {{ton}}. Styl: {{styl}}.{{kontekst}}{{cel}}\n\nTekst do redakcji:\n"""{{tekst}}"""';

const fields = {
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  tempEdit: document.getElementById('tempEdit'),
  tempSpellcheck: document.getElementById('tempSpellcheck'),
  tone: document.getElementById('tone'),
  style: document.getElementById('style'),
  promptTemplate: document.getElementById('promptTemplate')
};

const tempEditVal = document.getElementById('tempEditVal');
const tempSpellcheckVal = document.getElementById('tempSpellcheckVal');

fields.tempEdit.addEventListener('input', () => {
  tempEditVal.textContent = fields.tempEdit.value;
});
fields.tempSpellcheck.addEventListener('input', () => {
  tempSpellcheckVal.textContent = fields.tempSpellcheck.value;
});

const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

chrome.storage.sync.get(
  {
    apiKey: '',
    model: 'gpt-4o-mini',
    tempEdit: 0.7,
    tempSpellcheck: 0.2,
    tone: 'przyjazny',
    style: 'informacyjny',
    promptTemplate: DEFAULT_PROMPT_TEMPLATE
  },
  (data) => {
    fields.apiKey.value = data.apiKey;
    fields.model.value = data.model;
    fields.tempEdit.value = data.tempEdit;
    tempEditVal.textContent = data.tempEdit;
    fields.tempSpellcheck.value = data.tempSpellcheck;
    tempSpellcheckVal.textContent = data.tempSpellcheck;
    fields.tone.value = data.tone;
    fields.style.value = data.style;
    fields.promptTemplate.value = data.promptTemplate;
  }
);

const toggleVis = document.getElementById('toggleVis');
toggleVis.addEventListener('click', () => {
  const input = fields.apiKey;
  if (input.type === 'password') {
    input.type = 'text';
    toggleVis.title = 'Ukryj klucz';
  } else {
    input.type = 'password';
    toggleVis.title = 'Pokaz klucz';
  }
});

document.getElementById('resetPrompt').addEventListener('click', () => {
  fields.promptTemplate.value = DEFAULT_PROMPT_TEMPLATE;
});

const testBtn = document.getElementById('testBtn');
const testStatus = document.getElementById('testStatus');

testBtn.addEventListener('click', async () => {
  const key = fields.apiKey.value.trim();
  if (!key) {
    testStatus.textContent = 'Wpisz klucz API.';
    testStatus.className = 'test-status test-fail';
    return;
  }
  testStatus.textContent = 'Testowanie...';
  testStatus.className = 'test-status test-loading';
  testBtn.disabled = true;

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer ' + key }
    });
    if (res.ok) {
      testStatus.textContent = 'Klucz API dziala poprawnie.';
      testStatus.className = 'test-status test-ok';
    } else {
      const data = await res.json().catch(() => ({}));
      testStatus.textContent = data.error?.message || 'Blad: ' + res.status;
      testStatus.className = 'test-status test-fail';
    }
  } catch (e) {
    testStatus.textContent = 'Blad polaczenia: ' + e.message;
    testStatus.className = 'test-status test-fail';
  } finally {
    testBtn.disabled = false;
    setTimeout(() => { testStatus.textContent = ''; }, 5000);
  }
});

saveBtn.addEventListener('click', () => {
  const settings = {
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value,
    tempEdit: parseFloat(fields.tempEdit.value),
    tempSpellcheck: parseFloat(fields.tempSpellcheck.value),
    tone: fields.tone.value,
    style: fields.style.value,
    promptTemplate: fields.promptTemplate.value || DEFAULT_PROMPT_TEMPLATE
  };

  chrome.storage.sync.set(settings, () => {
    statusEl.textContent = 'Zapisano!';
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2000);
  });
});
