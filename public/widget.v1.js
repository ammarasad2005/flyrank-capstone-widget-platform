/*
 * FlyRank widget bundle — v1 (versioned asset: /public/widget.v1.js)
 *
 * Loaded by a single <script> tag on a site this service does not control:
 *
 *   <script src="http://localhost:3000/public/widget.v1.js?id=demo-contact-widget-a" async></script>
 *
 * The bundle resolves its own origin from the script tag, fetches the public widget
 * configuration, renders a form, and submits to the public endpoint. It is deliberately
 * small, dependency-free ES5, and treats every string from the config or the API as text
 * (never markup). The server remains the authority for validation, spam, tenant ownership
 * and geo enrichment; this file only renders and posts.
 */
(function () {
  'use strict';

  var RESERVED = { website: 1, id: 1, password: 1, action: 1, method: 1, type: 1 };
  var FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

  function resolveScript() {
    var script = document.currentScript;
    if (!script || !script.src) {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (scripts[i].src && scripts[i].src.indexOf('/public/widget.') !== -1) {
          script = scripts[i];
          break;
        }
      }
    }
    return script || null;
  }

  function queryParam(search, key) {
    var pairs = String(search || '').replace(/^\?/, '').split('&');
    for (var i = 0; i < pairs.length; i++) {
      var parts = pairs[i].split('=');
      if (decodeURIComponent(parts[0]) === key) {
        return decodeURIComponent((parts[1] || '').replace(/\+/g, ' '));
      }
    }
    return null;
  }

  function absoluteUrl(url) {
    var anchor = document.createElement('a');
    anchor.href = url;
    return anchor.href;
  }

  function randomKey() {
    var random = '';
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        var buffer = new Uint8Array(16);
        window.crypto.getRandomValues(buffer);
        for (var i = 0; i < buffer.length; i++) random += ('0' + buffer[i].toString(16)).slice(-2);
      }
    } catch (error) {
      random = '';
    }
    return 'wgt-' + (random || String(Date.now()) + '-' + Math.random().toString(16).slice(2));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function theme(container, options) {
    var dark = options.theme === 'dark';
    container.style.border = '1px solid ' + (dark ? '#3b4252' : '#d8dee9');
    container.style.background = dark ? '#1f2430' : '#ffffff';
    container.style.color = dark ? '#eceff4' : '#1b2430';
    container.style.borderRadius = '10px';
    container.style.padding = '16px';
    container.style.maxWidth = '420px';
    container.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    container.style.boxSizing = 'border-box';
    container.style.boxShadow = '0 6px 24px rgba(15, 23, 42, 0.12)';
    container.style.fontSize = '14px';
    container.style.lineHeight = '1.45';
  }

  function decorateInput(input, dark) {
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '8px 10px';
    input.style.marginTop = '4px';
    input.style.borderRadius = '6px';
    input.style.border = '1px solid ' + (dark ? '#4c566a' : '#c2cad6');
    input.style.background = dark ? '#2e3440' : '#fbfcfe';
    input.style.color = dark ? '#eceff4' : '#1b2430';
    input.style.font = 'inherit';
  }

  function renderHoneypot(form) {
    var wrap = el('div');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.position = 'absolute';
    wrap.style.left = '-10000px';
    wrap.style.top = 'auto';
    wrap.style.width = '1px';
    wrap.style.height = '1px';
    wrap.style.overflow = 'hidden';
    var label = el('label', null, 'Website');
    var input = el('input');
    input.type = 'text';
    input.name = 'website';
    input.tabIndex = -1;
    input.autocomplete = 'off';
    label.appendChild(input);
    wrap.appendChild(label);
    form.appendChild(wrap);
    return input;
  }

  function buildForm(container, config, apiOrigin) {
    var dark = config.displayOptions && config.displayOptions.theme === 'dark';
    theme(container, config.displayOptions || {});
    container.setAttribute('data-flyrank-widget', config.publicId);

    if (config.title) {
      var heading = el('h3', 'flyrank-title', config.title);
      heading.style.margin = '0 0 4px';
      heading.style.fontSize = '17px';
      container.appendChild(heading);
    }
    if (config.description) {
      var description = el('p', 'flyrank-description', config.description);
      description.style.margin = '0 0 12px';
      description.style.opacity = '0.8';
      container.appendChild(description);
    }

    var form = el('form', 'flyrank-form');
    form.setAttribute('novalidate', 'novalidate');
    container.appendChild(form);

    var inputs = {};
    for (var i = 0; i < config.fields.length; i++) {
      var definition = config.fields[i];
      if (RESERVED[definition.name]) continue;
      var fieldWrap = el('div', 'flyrank-field');
      fieldWrap.style.marginBottom = '10px';
      var inputId = 'flyrank-' + config.publicId + '-' + definition.name;
      var label = el('label', null, definition.label + (definition.required ? ' *' : ''));
      label.setAttribute('for', inputId);
      label.style.display = 'block';
      label.style.fontWeight = '600';
      label.style.fontSize = '13px';

      var input = el(definition.type === 'textarea' ? 'textarea' : 'input');
      if (definition.type !== 'textarea') {
        input.type = definition.type === 'email' ? 'email' : definition.type === 'tel' ? 'tel' : 'text';
      } else {
        input.rows = 3;
      }
      input.id = inputId;
      input.name = definition.name;
      input.maxLength = definition.maxLength;
      input.required = definition.required;
      input.autocomplete = definition.type === 'email' ? 'email' : definition.type === 'tel' ? 'tel' : 'off';
      decorateInput(input, dark);

      fieldWrap.appendChild(label);
      fieldWrap.appendChild(input);
      form.appendChild(fieldWrap);
      inputs[definition.name] = { input: input, definition: definition };
    }

    var honeypot = renderHoneypot(form);

    var button = el('button', 'flyrank-submit', config.buttonText || 'Submit');
    button.type = 'submit';
    button.style.marginTop = '6px';
    button.style.padding = '9px 16px';
    button.style.border = '0';
    button.style.borderRadius = '6px';
    button.style.cursor = 'pointer';
    button.style.font = 'inherit';
    button.style.fontWeight = '600';
    button.style.background = dark ? '#88c0d0' : '#1d4ed8';
    button.style.color = dark ? '#1b2430' : '#ffffff';
    form.appendChild(button);

    var status = el('p', 'flyrank-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.margin = '10px 0 0';
    status.style.fontSize = '13px';
    status.style.minHeight = '18px';
    container.appendChild(status);

    var idempotencyKey = randomKey();
    var submitting = false;

    function setStatus(message, isError) {
      status.textContent = message;
      status.style.color = isError ? '#b42318' : dark ? '#a3be8c' : '#0f766e';
      if (isError) status.setAttribute('role', 'alert');
      else status.setAttribute('role', 'status');
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (submitting) return;

      var fields = {};
      for (var key in inputs) {
        if (!Object.prototype.hasOwnProperty.call(inputs, key)) continue;
        var entry = inputs[key];
        var value = String(entry.input.value || '').trim();
        if (entry.definition.required && !value) {
          setStatus(entry.definition.label + ' is required.', true);
          entry.input.focus();
          return;
        }
        if (value.length > entry.definition.maxLength) {
          setStatus(entry.definition.label + ' is too long.', true);
          entry.input.focus();
          return;
        }
        if (value) fields[key] = value;
      }

      var payload = { fields: fields };
      if (honeypot.value) payload.website = honeypot.value;

      submitting = true;
      button.disabled = true;
      setStatus('Sending…', false);

      fetch(apiOrigin + '/submissions?widget_id=' + encodeURIComponent(config.publicId), {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(payload)
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            var body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch (error) { body = {}; }
            return { ok: response.ok, status: response.status, body: body, retryAfter: response.headers.get('Retry-After') };
          });
        })
        .then(function (result) {
          submitting = false;
          button.disabled = false;
          if (result.ok) {
            form.style.display = 'none';
            setStatus('Thanks — your message has been received.', false);
            return;
          }
          if (result.status === 429) {
            setStatus('Too many submissions right now. Try again in ' + (result.retryAfter || 'a few') + ' seconds.', true);
            return;
          }
          if (result.status === 422 && result.body && result.body.issues && result.body.issues.length) {
            setStatus(String(result.body.issues[0].message || 'Please check the form.'), true);
            return;
          }
          if (result.status === 403) {
            setStatus('This widget is not allowed on this site.', true);
            return;
          }
          if (result.status === 404) {
            setStatus('This widget is no longer available.', true);
            return;
          }
          setStatus(FALLBACK_MESSAGE, true);
        })
        .catch(function () {
          submitting = false;
          button.disabled = false;
          setStatus('Network error — please try again.', true);
        });
    });

    return form;
  }

  function mount(script) {
    var src = absoluteUrl(script.src);
    var apiOrigin = src.split('/').slice(0, 3).join('/');
    var widgetId = queryParam(script.src.split('?')[1], 'id');
    var target = script.getAttribute('data-target');

    var container = el('div', 'flyrank-widget');
    var host = document.body || document.documentElement;
    if (target) {
      var explicitHost = null;
      try { explicitHost = document.querySelector(target); } catch (error) { explicitHost = null; }
      if (explicitHost) host = explicitHost;
    }
    if (script.parentNode && script.parentNode !== document.head && !target) {
      host = script.parentNode;
    }

    var popover = null;
    var launcher = null;
    if (container && host) {
      host.appendChild(container);
    }

    if (!widgetId) {
      container.textContent = 'Widget misconfigured: missing id parameter.';
      return;
    }

    container.textContent = 'Loading…';

    fetch(apiOrigin + '/widgets/' + encodeURIComponent(widgetId) + '/config', {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers: { Accept: 'application/json' }
    })
      .then(function (response) {
        if (response.status === 404) throw new Error('not_found');
        if (response.status === 410) throw new Error('stale_bundle');
        if (!response.ok) throw new Error('config_failed');
        return response.json();
      })
      .then(function (config) {
        if (!config || !config.fields || !config.fields.length) throw new Error('empty_config');
        container.textContent = '';
        if (config.displayOptions && config.displayOptions.position === 'popover') {
          container.style.display = 'none';
          launcher = el('button', 'flyrank-launcher', config.title || 'Open form');
          launcher.type = 'button';
          launcher.style.position = 'fixed';
          launcher.style.right = '18px';
          launcher.style.bottom = '18px';
          launcher.style.zIndex = '2147483000';
          launcher.style.padding = '10px 16px';
          launcher.style.borderRadius = '999px';
          launcher.style.border = '0';
          launcher.style.cursor = 'pointer';
          launcher.style.font = 'inherit';
          launcher.style.background = '#1d4ed8';
          launcher.style.color = '#fff';
          popover = el('div', 'flyrank-popover');
          popover.style.position = 'fixed';
          popover.style.right = '18px';
          popover.style.bottom = '70px';
          popover.style.zIndex = '2147483001';
          popover.appendChild(container);
          launcher.addEventListener('click', function () {
            container.style.display = container.style.display === 'none' ? 'block' : 'none';
          });
          (document.body || document.documentElement).appendChild(popover);
          (document.body || document.documentElement).appendChild(launcher);
        }
        buildForm(container, config, apiOrigin);
      })
      .catch(function (error) {
        var message = error && error.message === 'stale_bundle'
          ? 'This page uses an outdated widget script. Please reload after the site owner updates the snippet.'
          : 'Widget unavailable right now.';
        container.textContent = message;
        container.style.fontSize = '13px';
        container.style.opacity = '0.85';
      });
  }

  function start() {
    var script = resolveScript();
    if (!script) return;
    mount(script);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
