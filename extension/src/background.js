import { grab } from './grab.js';

const MENUS = [
  { id: 'page', title: 'Clip page to Sink', contexts: ['page'] },
  { id: 'selection', title: 'Add selection to Sink note', contexts: ['selection'] },
  { id: 'link', title: 'Add link to this page to Sink note', contexts: ['page'] },
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.removeAll(() => MENUS.forEach((m) => chrome.contextMenus.create(m)));
});

// The menu and the shortcut grant activeTab, so the page can be read here; the panel picks the job up from session
// storage, as it may only now be opening.
async function send(kind, tab) {
  const page = await grab(tab.id);
  await chrome.storage.session.set({ job: page ? { kind, ...page, at: Date.now() } : { kind: 'unreadable', at: Date.now() } });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  // open() has to happen in the click itself, before anything is awaited.
  chrome.sidePanel.open({ tabId: tab.id });
  send(info.menuItemId, tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'clip-page' || !tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id });
  send('page', tab);
});
