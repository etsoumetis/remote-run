// Webview-side preview renderer. Loaded as a classic script; pdf.js is pulled
// in with a dynamic import() only when a PDF is actually opened, so image and
// video previews never pay for it.
(function () {
  'use strict';

  const vscode  = acquireVsCodeApi();
  const stage   = document.getElementById('stage');
  const toolbar = document.getElementById('toolbar');

  window.addEventListener('message', event => {
    if (event.data && event.data.type === 'init') {
      init(event.data).catch(err => fail(err && err.message ? err.message : String(err)));
    }
  });

  vscode.postMessage({ type: 'ready' });

  function init(cfg) {
    switch (cfg.kind) {
      case 'image': return Promise.resolve(showImage(cfg));
      case 'video': return Promise.resolve(showMedia(cfg, 'video'));
      case 'audio': return Promise.resolve(showMedia(cfg, 'audio'));
      case 'pdf':   return showPdf(cfg);
      default:      return Promise.resolve(fail('Unsupported file type.'));
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  function clearStage() { stage.textContent = ''; }

  function showToolbar(nodes) {
    toolbar.textContent = '';
    nodes.forEach(n => toolbar.appendChild(n));
    toolbar.hidden = false;
    document.body.classList.add('has-toolbar');
  }

  function el(tag, props, text) {
    const node = document.createElement(tag);
    if (props) Object.keys(props).forEach(k => { node[k] = props[k]; });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function label(text) { return el('span', { className: 'label' }, text); }
  function spacer()    { return el('span', { className: 'spacer' }); }

  function button(text, onClick, title) {
    const b = el('button', { title: title || text }, text);
    b.addEventListener('click', onClick);
    return b;
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fail(message, withSave) {
    clearStage();
    toolbar.hidden = true;
    document.body.classList.remove('has-toolbar');
    const box = el('div', { className: 'notice' });
    box.appendChild(el('h3', null, 'Cannot display this file'));
    box.appendChild(el('p', null, message));
    if (withSave) {
      const row = el('div');
      row.appendChild(button('Open with default app', () => vscode.postMessage({ type: 'openExternally' })));
      row.appendChild(button('Save a copy…', () => vscode.postMessage({ type: 'saveCopy' })));
      box.appendChild(row);
    }
    stage.appendChild(box);
  }

  // ── image ──────────────────────────────────────────────────────────────

  function showImage(cfg) {
    clearStage();
    const img = el('img', { className: 'viewer fit', src: cfg.src, alt: cfg.name });
    const dims = label('');

    img.addEventListener('load', () => {
      dims.textContent = img.naturalWidth + ' × ' + img.naturalHeight;
    });
    img.addEventListener('error', () => fail('The image could not be decoded.', true));

    const fitBtn    = button('Fit', () => setMode(true));
    const actualBtn = button('100%', () => setMode(false));

    function setMode(fit) {
      img.classList.toggle('fit', fit);
      img.classList.toggle('actual', !fit);
      fitBtn.disabled = fit;
      actualBtn.disabled = !fit;
    }

    img.addEventListener('click', () => setMode(!img.classList.contains('fit')));
    setMode(true);

    showToolbar([dims, label('·'), label(bytes(cfg.size)), spacer(), fitBtn, actualBtn]);
    stage.appendChild(img);
  }

  // ── video / audio ──────────────────────────────────────────────────────

  const MEDIA_ERRORS = {
    1: 'Playback was aborted.',
    2: 'The connection to the file dropped.',
    3: 'The file is corrupt, or its codec cannot be decoded here.',
    4: 'This format is not supported by the built-in player.',
  };

  function showMedia(cfg, tag) {
    clearStage();
    const media = el(tag, {
      className: 'viewer',
      src: cfg.src,
      controls: true,
      // Only metadata up front: the remote sends nothing more until the user
      // presses play, and seeking pulls just the range that was jumped to.
      preload: 'metadata',
    });

    media.addEventListener('error', () => {
      const err  = media.error || {};
      const code = err.code || 0;

      // A streamed source has more ways to fail than a local one — a blocked
      // origin or a dropped range request looks identical to a bad codec from
      // here. Retry once against a downloaded copy before blaming the format.
      if (cfg.streamed && code !== 4) {
        stage.textContent = '';
        stage.appendChild(el('div', { id: 'spinner' }, 'Streaming failed — downloading instead…'));
        vscode.postMessage({ type: 'retryCached', code: code, detail: err.message || '' });
        return;
      }

      const known = MEDIA_ERRORS[code] || 'The player reported an unknown error.';
      fail(
        known + ' (' + cfg.name.split('.').pop().toUpperCase() +
        (err.message ? ', ' + err.message : '') + ')' +
        ' You can still save a copy and open it in a desktop player.',
        true,
      );
    });

    const mode = cfg.streamed ? 'streaming — only the parts you play are transferred'
                              : 'downloaded to a temporary cache';
    showToolbar([
      label(cfg.name), label('·'), label(bytes(cfg.size)), label('·'), label(mode),
      spacer(),
      button('Open externally', () => vscode.postMessage({ type: 'openExternally' })),
      button('Save a copy…', () => vscode.postMessage({ type: 'saveCopy' })),
    ]);
    stage.appendChild(media);
  }

  // ── pdf ────────────────────────────────────────────────────────────────

  async function showPdf(cfg) {
    const pdfjs = await import(cfg.pdfLib);

    // The worker lives on the extension's resource origin, which a Worker
    // cannot be constructed from cross-origin. Re-hosting it as a blob keeps it
    // off the main thread, which is what stops page rendering from freezing
    // the panel on large documents.
    try {
      const source = await fetch(cfg.pdfWorker).then(r => r.text());
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(blobUrl, { type: 'module' });
    } catch (_) {
      // Fall through: pdf.js renders on the main thread if no worker is set up.
      pdfjs.GlobalWorkerOptions.workerSrc = cfg.pdfWorker;
    }

    const doc = await pdfjs.getDocument({
      url: cfg.src,
      standardFontDataUrl: cfg.pdfFonts,
      // With a streamed source, pull page data on demand instead of eagerly
      // fetching the whole document — this is the difference between opening a
      // 200 MB PDF instantly and waiting out the entire transfer.
      disableAutoFetch: cfg.streamed,
      disableStream: !cfg.streamed,
      disableRange: !cfg.streamed,
      rangeChunkSize: 65536,
    }).promise;

    clearStage();
    stage.classList.add('pdf');

    let scale = 1.25;
    const pages = [];
    const pageInput = el('input', { type: 'number', min: 1, max: doc.numPages, value: 1 });
    const zoomLabel = label('');

    // Page 1's geometry seeds every placeholder. Asking the document for all
    // N page dictionaries up front would mean N round trips to the remote
    // before anything appears; each page corrects its own box when it renders.
    const first = await doc.getPage(1);

    // Only pages near the viewport hold a canvas; the rest keep their box size
    // so the scrollbar stays honest without the memory cost.
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const page = pages[Number(entry.target.dataset.index)];
        if (entry.isIntersecting) { page.released = false; renderPage(page); }
        else releasePage(page);
      });
    }, { root: stage, rootMargin: '200% 0px' });

    for (let i = 1; i <= doc.numPages; i++) {
      const holder = el('div', { className: 'pdf-page' });
      holder.dataset.index = String(i - 1);
      pages.push({
        number: i, holder,
        canvas: null, task: null, proxy: null, viewport: null,
        loading: false, released: false,
      });
      stage.appendChild(holder);
    }

    layout();
    pages.forEach(p => observer.observe(p.holder));

    stage.addEventListener('scroll', () => {
      const top = stage.scrollTop;
      let current = 1;
      for (const page of pages) {
        if (page.holder.offsetTop - 24 <= top) current = page.number; else break;
      }
      if (document.activeElement !== pageInput) pageInput.value = String(current);
    }, { passive: true });

    pageInput.addEventListener('change', () => {
      const n = Math.min(Math.max(parseInt(pageInput.value, 10) || 1, 1), doc.numPages);
      pageInput.value = String(n);
      stage.scrollTo({ top: pages[n - 1].holder.offsetTop - 12 });
    });

    showToolbar([
      button('−', () => zoom(-0.25), 'Zoom out'),
      button('+', () => zoom(0.25), 'Zoom in'),
      zoomLabel,
      spacer(),
      label('Page'), pageInput, label('of ' + doc.numPages),
      spacer(),
      label(bytes(cfg.size)),
      button('Save a copy…', () => vscode.postMessage({ type: 'saveCopy' })),
    ]);

    function zoom(delta) {
      const next = Math.min(Math.max(scale + delta, 0.25), 4);
      if (next === scale) return;
      scale = next;
      layout();
    }

    // Re-sizes placeholders for the current scale and re-renders what is on
    // screen. Pages that have never been rendered keep the estimated box.
    function layout() {
      zoomLabel.textContent = Math.round(scale * 100) + '%';
      const estimate = first.getViewport({ scale });

      for (const page of pages) {
        const box = page.proxy ? page.proxy.getViewport({ scale }) : estimate;
        page.viewport = page.proxy ? box : null;
        page.holder.style.width  = Math.floor(box.width) + 'px';
        page.holder.style.height = Math.floor(box.height) + 'px';
        if (page.canvas) {
          // Still on screen — drop the old-scale canvas and redraw. Clearing
          // `released` matters: releasePage sets it, and renderPage honours it.
          releasePage(page);
          page.released = false;
          renderPage(page);
        }
      }
    }

    // Resolves the page lazily, so a 500-page document costs one round trip at
    // open time instead of 500.
    async function renderPage(page) {
      if (page.canvas || page.loading) return;
      page.loading = true;
      try {
        if (!page.proxy) {
          page.proxy = page.number === 1 ? first : await doc.getPage(page.number);
          // The real page may not match page 1's shape — correct the box now.
          const real = page.proxy.getViewport({ scale });
          page.holder.style.width  = Math.floor(real.width) + 'px';
          page.holder.style.height = Math.floor(real.height) + 'px';
        }
        // A scroll or zoom may have released this page while we were waiting.
        if (!page.holder.isConnected || page.released) return;
        page.viewport = page.proxy.getViewport({ scale });

        const ratio  = window.devicePixelRatio || 1;
        const canvas = el('canvas');
        canvas.width  = Math.floor(page.viewport.width * ratio);
        canvas.height = Math.floor(page.viewport.height * ratio);
        canvas.style.width  = Math.floor(page.viewport.width) + 'px';
        canvas.style.height = Math.floor(page.viewport.height) + 'px';
        page.canvas = canvas;
        page.holder.appendChild(canvas);

        page.task = page.proxy.render({
          canvasContext: canvas.getContext('2d'),
          viewport: page.viewport,
          transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
        });
        await page.task.promise.catch(() => { /* cancelled by a scroll or a zoom */ });
        page.task = null;
      } finally {
        page.loading = false;
      }
    }

    function releasePage(page) {
      page.released = true;
      if (page.task) { page.task.cancel(); page.task = null; }
      if (page.canvas) {
        // Zeroing the backing store is what actually frees the pixels; removing
        // the element alone leaves them allocated until GC gets round to it.
        page.canvas.width = 0;
        page.canvas.height = 0;
        page.canvas.remove();
        page.canvas = null;
      }
    }
  }
})();
