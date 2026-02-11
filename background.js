chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'redaguj-ai',
    title: 'Redaguj zaznaczony tekst (AI)',
    contexts: ['selection']
  });
});

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
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
      if (selectedText.trim()) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'open-modal',
          selectedText: selectedText
        });
      }
    } catch (err) {
      console.error('Poprawiacz tekstu AI (shortcut):', err);
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'redaguj-ai' && info.selectionText) {
    try {
      await ensureContentScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, {
        action: 'open-modal',
        selectedText: info.selectionText
      });
    } catch (err) {
      console.error('Poprawiacz tekstu AI:', err);
    }
  }
});
