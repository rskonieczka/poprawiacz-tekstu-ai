chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'redaguj-ai',
    title: 'Redaguj zaznaczony tekst (AI)',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'otworz-redaktor',
    title: 'Otworz Poprawiacz tekstu AI',
    contexts: ['page', 'editable']
  });
});

const CONTENT_SCRIPT_VERSION = '1.0.1';

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (!response || response.version !== CONTENT_SCRIPT_VERSION) {
      throw new Error('Outdated content script');
    }
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ['modal.css']
    });
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-redaktor') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    try {
      await ensureContentScript(tab.id);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() || ''
      });
      const selectedText = result?.result || '';
      await chrome.tabs.sendMessage(tab.id, {
        action: 'open-modal',
        selectedText: selectedText
      });
    } catch (err) {
      console.error('Poprawiacz tekstu AI (shortcut):', err);
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'redaguj-ai' || info.menuItemId === 'otworz-redaktor') {
    try {
      await ensureContentScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, {
        action: 'open-modal',
        selectedText: info.selectionText || ''
      });
    } catch (err) {
      console.error('Poprawiacz tekstu AI:', err);
    }
  }
});
