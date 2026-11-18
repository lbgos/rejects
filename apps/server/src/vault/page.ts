export const SNAPSHOT_SCRIPT = `(() => {
  for (const old of document.querySelectorAll('[data-vault-ref]')) old.removeAttribute('data-vault-ref');
  const out = [];
  let line = '';
  let n = 0;
  const clean = (t) => String(t || '').replace(/\\s+/g, ' ').trim();
  // Nothing is cut here: the vault scrubs typed secrets from the whole text and then limits it.
  const quote = (t) => clean(t).replace(/"/g, "'");
  const flush = () => { const t = clean(line); if (t) out.push(t); line = ''; };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO']);
  const BLOCK = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|NAV|MAIN|ASIDE|FORM|TABLE|UL|OL|DL|DT|DD|BLOCKQUOTE|PRE|FIELDSET|DIALOG)$/;
  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'select', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option']);
  const roleOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      return 'textbox';
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return null;
  };
  const hidden = (el) =>
    typeof el.checkVisibility === 'function' &&
    !el.checkVisibility({ visibilityProperty: true }) &&
    getComputedStyle(el).display !== 'contents';
  const walk = (node) => {
    if (node.nodeType === 3) { line += ' ' + node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName) || hidden(el)) return;
    const role = roleOf(el);
    if (role && INTERACTIVE.has(role) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
      const ref = 'e' + (++n);
      el.setAttribute('data-vault-ref', ref);
      const named = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt');
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
        const name = named || el.getAttribute('placeholder') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('name') || '';
        const value = el.isContentEditable ? el.innerText : el.value;
        // The mark is the page's to remove, so the field's own type counts first.
        const secret = el.type === 'password' || el.hasAttribute('data-vault-secret');
        line += ' [' + ref + ' ' + role + ' "' + quote(name) + '"' + (value && !secret ? ' = "' + quote(value) + '"' : '') + ']';
      } else if (role === 'link') {
        line += ' [' + ref + ' link "' + quote(named || el.innerText) + '" -> ' + String(el.href || '') + ']';
      } else if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        const on = el.checked === true || el.getAttribute('aria-checked') === 'true';
        line += ' [' + ref + ' ' + role + ' "' + quote(named || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.innerText) + '" ' + (on ? 'on' : 'off') + ']';
      } else if (role === 'select') {
        const chosen = el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].innerText : '';
        line += ' [' + ref + ' select "' + quote(named || el.getAttribute('name')) + '" = "' + quote(chosen) + '"]';
      } else {
        line += ' [' + ref + ' ' + role + ' "' + quote(named || el.innerText || el.value) + '"]';
      }
      return;
    }
    const block = BLOCK.test(el.tagName);
    if (block) flush();
    if (/^H[1-6]$/.test(el.tagName)) line += '#'.repeat(Number(el.tagName[1])) + ' ';
    for (const child of el.childNodes) walk(child);
    if (el.shadowRoot) for (const child of el.shadowRoot.childNodes) walk(child);
    if (block) flush();
  };
  if (document.body) walk(document.body);
  flush();
  // Which sign-in step the page shows, so the vault can tell a taken password from a refused one.
  // A code field often has no autocomplete, so its name, id, placeholder or a short numeric input
  // count too. A false match only delays "signed in".
  const visible = (el) => !hidden(el) && el.getClientRects().length > 0;
  const fields = Array.from(document.querySelectorAll('input')).filter(visible);
  const CODE_HINT = /one-time-code|otp|totp|2fa|mfa|passcode|verif|(?:^|[^a-z])code(?:$|[^a-z])/;
  const codeLike = (el) =>
    /^(?:text|tel|number)$/.test(el.type) &&
    (CODE_HINT.test([el.getAttribute('autocomplete'), el.name, el.id, el.getAttribute('placeholder')].join(' ').toLowerCase()) ||
      (el.inputMode === 'numeric' && el.maxLength > 0 && el.maxLength <= 8));
  const form = fields.some((el) => el.type === 'password') ? 'password' : fields.some(codeLike) ? 'code' : null;
  return { url: location.href, title: document.title, text: out.join('\\n'), form };
})()`;

const LABEL = `String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.innerText || (el.type === 'password' ? '' : el.value) || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim()`;

export const targetScript = (ref: string) => `(() => {
  const el = document.querySelector('[data-vault-ref=${JSON.stringify(ref)}]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  // A link that wraps has a box whose centre can fall between its lines; aim at its first line.
  const r = Array.from(el.getClientRects()).find((box) => box.width > 0 && box.height > 0) || el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    label: ${LABEL},
    href: el.tagName === 'A' && el.hasAttribute('href') ? String(el.href) : null,
  };
})()`;

/** In a bot's action the guard holds the submit for the vault to check; otherwise it submits. */
export const CLICK_GUARD_SCRIPT = `(() => {
  if (window.__t3VaultGuard) return;
  window.__t3VaultGuard = true;
  const sameDocument = (url) => url.includes('#') && url.slice(0, url.indexOf('#')) === location.href.split('#')[0];
  const allowed = (url) => /^(?:https?):/i.test(url) || sameDocument(url);
  const navigate = (url, target) => {
    if (!allowed(url)) return;
    if (target && target !== '_self') window.open(url, target);
    else location.assign(url);
  };
  const anchorOf = (event) => {
    const target = event.target;
    const anchor = target instanceof Element ? target.closest('a') : null;
    return anchor && anchor.hasAttribute('href') ? anchor : null;
  };
  // A page handler can stop propagation, so reject a scheme that is already unsafe first.
  window.addEventListener('click', (event) => {
    const anchor = anchorOf(event);
    if (!anchor || allowed(String(anchor.href || ''))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('click', (event) => {
    const anchor = anchorOf(event);
    if (!anchor) return;
    if (event.defaultPrevented) return;
    event.preventDefault();
    queueMicrotask(() => {
      navigate(String(anchor.href || ''), anchor.target || '_self');
    });
  });
  // The page may rewrite a form's action or target in its submit handlers, so read them through the
  // native accessors after the handlers ran; the page cannot shadow these.
  const formAction = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action');
  const formTarget = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'target');
  const nativeSubmit = HTMLFormElement.prototype.submit;
  const submitForm = (form, action, target) => {
    formAction.set.call(form, action);
    formTarget.set.call(form, target);
    nativeSubmit.call(form);
  };
  const ACTIVATES = new Set(['button', 'submit', 'reset', 'image']);
  let hold = false;
  let pending = null;
  const expose = (name, value) => Object.defineProperty(window, name, { value });
  expose('__t3VaultHold', (value) => { hold = value; });
  expose('__t3VaultPending', () => pending && { action: pending.action, target: pending.target });
  expose('__t3VaultDrop', () => { pending = null; });
  expose('__t3VaultSubmit', (action) => {
    const held = pending;
    pending = null;
    if (!held || !held.form.isConnected) return false;
    submitForm(held.form, action, '_self');
    return true;
  });
  // A secret is checked and inserted in this one call, with the page's natives as they were before
  // its scripts ran: the focused field must be an input of the secret's kind (a password only into a
  // password field) and the document must be on the secret's exact host. The value is set natively
  // and announced with an input event, as typing does; the field is then marked so snapshots and
  // screencasts hide it. A focus inside a frame leaves the frame element active, which is no input.
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const typeGetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type').get;
  const styleGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style').get;
  const shadowGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot').get;
  const activeOfDocument = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement').get;
  const activeOfShadow = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'activeElement').get;
  const getAttr = Element.prototype.getAttribute;
  const setAttr = Element.prototype.setAttribute;
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const InputEventClass = InputEvent;
  // Literals, tested through the native test: page scripts cannot swap either.
  const test = RegExp.prototype.test;
  const autocomplete = (el) => String(getAttr.call(el, 'autocomplete') || '').toLowerCase();
  const FIELDS = {
    password: (type, el) =>
      type === 'password' || test.call(/(?:^|\\s)(?:current-password|new-password)(?:\\s|$)/, autocomplete(el)),
    username: (type, el) =>
      test.call(/^(?:text|email|tel)$/, type) || test.call(/(?:^|\\s)(?:username|email|tel)(?:\\s|$)/, autocomplete(el)),
    code: (type, el) =>
      test.call(/^(?:text|tel|number|password)$/, type) || test.call(/(?:^|\\s)one-time-code(?:\\s|$)/, autocomplete(el)),
  };
  expose('__t3VaultSecret', (text, target, kind) => {
    let el = activeOfDocument.call(document);
    for (let inner = el && shadowGetter.call(el); inner; inner = el && shadowGetter.call(el)) {
      const next = activeOfShadow.call(inner);
      if (!next) break;
      el = next;
    }
    if (!el) return 'not-field';
    let type;
    try { type = typeGetter.call(el); } catch { return 'not-field'; }
    if (!(kind === 'password' || kind === 'username' || kind === 'code') || !FIELDS[kind](type, el)) return 'not-field';
    const protocol = location.protocol;
    const onSite = (protocol === 'https:' || (target.http && protocol === 'http:')) &&
      location.port === target.port &&
      (location.hostname === target.host || location.hostname === 'www.' + target.host);
    if (!onSite) return 'off-site';
    valueSetter.call(el, text);
    dispatch.call(el, new InputEventClass('input', { bubbles: true, inputType: 'insertText', data: text }));
    setAttr.call(el, 'data-vault-secret', '');
    setProperty.call(styleGetter.call(el), '-webkit-text-security', 'disc', 'important');
    return 'ok';
  });
  // In the bubble phase, after the page's own key handlers: an Enter it handled stays its own.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || ACTIVATES.has(input.type) || !input.form) return;
    const form = input.form;
    event.preventDefault();
    // The page's submit handlers run here, once. One that cancels the event took the submit itself.
    if (!form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))) return;
    const action = String(formAction.get.call(form) || location.href);
    const target = String(formTarget.get.call(form) || '');
    if (hold) pending = { form, action, target };
    else if (/^(?:https?):/i.test(action)) submitForm(form, action, target);
  });
})()`;

/**
 * For the sheet: whether a text field has focus (null inside a cross-origin frame, which this
 * cannot see) and where the visible text fields are, in viewport pixels. Reads no values.
 */
export const SHEET_FOCUS_SCRIPT = `(() => {
  const NOT_TYPED = /^(button|submit|reset|image|checkbox|radio|file|color|range|hidden|date|datetime-local|month|week|time)$/;
  const typed = (el) => {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return !NOT_TYPED.test((el.getAttribute('type') || 'text').toLowerCase());
    return el.isContentEditable === true;
  };
  const fields = [];
  for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) {
    if (fields.length >= 64) break;
    if (!typed(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) continue;
    fields.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
  }
  let active = document.activeElement;
  for (;;) {
    if (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    else if (active && (active.tagName === 'IFRAME' || active.tagName === 'FRAME')) {
      let inner = null;
      try { inner = active.contentDocument; } catch {}
      if (!inner) return { editing: null, fields };
      active = inner.activeElement;
    } else break;
  }
  return { editing: typed(active), fields };
})()`;

export const focusScript = (ref: string) => `(() => {
  const el = document.querySelector('[data-vault-ref=${JSON.stringify(ref)}]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return document.activeElement === el || el.contains(document.activeElement) ? ${LABEL} : null;
})()`;

/**
 * Makes the page see a plain phone Chrome: `window.chrome` exists, and the device memory is a
 * phone's. The user agent and client hints are set by the emulation, not here.
 */
export const PHONE_BROWSER_SCRIPT = `(() => {
  if (!('chrome' in window)) {
    Object.defineProperty(window, 'chrome', {
      value: { loadTimes() { return {}; }, csi() { return {}; } },
      configurable: true,
      writable: true,
    });
  }
  try {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true });
  } catch {}
})()`;
