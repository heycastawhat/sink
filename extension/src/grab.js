// Runs in the page (chrome.scripting): what's there as you see it, after logins and scripts. Must stay self-contained.
export function grabPage() {
  const sel = getSelection();
  let selection = '';
  if (sel && !sel.isCollapsed) {
    const box = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) box.append(sel.getRangeAt(i).cloneContents());
    selection = box.innerHTML;
  }
  return { url: location.href, title: document.title, selection, html: document.documentElement.outerHTML };
}

/** The page in a tab, or null when the extension may not read it (chrome:// pages, the Web Store, no permission). */
export async function grab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: grabPage });
    return res?.result ?? null;
  } catch {
    return null;
  }
}
