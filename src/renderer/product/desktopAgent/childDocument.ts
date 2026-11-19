/**
 * Windows the app's page opens and draws into (ADR 0058). They start blank, so they take the
 * page's stylesheets and theme, and keep up as the page adds styles (Vite does in development)
 * or changes theme.
 */
export function openChildWindow(name: string): Window | null {
  return window.open('about:blank', name, '');
}

const STYLE_SELECTOR = 'style, link[rel="stylesheet"]';

function copyRootAttributes(target: Document): void {
  const from = document.documentElement;
  const to = target.documentElement;
  for (const { name } of Array.from(to.attributes)) {
    if (!from.hasAttribute(name)) to.removeAttribute(name);
  }
  for (const { name, value } of Array.from(from.attributes)) to.setAttribute(name, value);
}

/** Copy the page's styles and theme into `target`, and follow later changes. Returns a function that stops. */
export function adoptStyles(target: Document): () => void {
  const copies = new Map<Node, Node>();
  const copy = (node: Element): void => {
    if (copies.has(node)) return;
    const clone = target.importNode(node, true);
    copies.set(node, clone);
    target.head.appendChild(clone);
  };
  document.head.querySelectorAll(STYLE_SELECTOR).forEach(copy);
  copyRootAttributes(target);

  const headObserver = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === 1 && (node as Element).matches(STYLE_SELECTOR)) copy(node as Element);
      });
      record.removedNodes.forEach((node) => {
        const clone = copies.get(node);
        if (clone) clone.parentNode?.removeChild(clone);
        copies.delete(node);
      });
      // A dev reload of a stylesheet rewrites a style element's text in place.
      const changed = record.target.nodeType === 1 ? (record.target as Element).closest?.('style') : record.target.parentElement?.closest('style');
      if (changed && copies.has(changed)) {
        (copies.get(changed) as Element).textContent = changed.textContent;
      }
    }
  });
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  const rootObserver = new MutationObserver(() => copyRootAttributes(target));
  rootObserver.observe(document.documentElement, { attributes: true });
  return () => {
    headObserver.disconnect();
    rootObserver.disconnect();
  };
}
