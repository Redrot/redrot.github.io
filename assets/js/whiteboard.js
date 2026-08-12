/*
 * Whiteboard / chalkboard doodling.
 *
 * Switch it on with the pen button in the bottom-left corner, then drag on
 * empty space and the page draws back: a dry-erase marker in light mode, chalk
 * in dark mode. The eraser button in the bottom-right, or Escape, wipes the
 * board; Escape on a clean board switches drawing off again.
 *
 * Deliberate constraints:
 *  - Off until asked for. Drawing on any stray drag meant a visitor who missed
 *    while selecting text left a mark on the page, so it is opt-in per visit.
 *  - Mouse only. On touch screens a drag is a scroll, so the whole feature
 *    stays switched off there rather than fighting the user for the gesture.
 *  - Strokes only START on empty layout space. Pressing on a paragraph still
 *    selects text, and links, buttons and the navbar behave normally. Once a
 *    stroke has started it can run anywhere, like marking up a real board.
 *  - The canvas never intercepts clicks (pointer-events: none); pointer events
 *    are read from the document instead.
 *  - Strokes are kept as coordinates rather than baked pixels, so they can be
 *    re-rendered when the window resizes or the theme changes -- switch to dark
 *    mode and your marker drawing becomes the same drawing in chalk.
 *  - Nothing is persisted. Reloading or navigating gives a clean board.
 */
(function () {
  'use strict';

  // A drag is a scroll on touch devices, and there is no hover to hint that
  // drawing is possible, so only run where there's a real pointer.
  if (!window.PointerEvent || !window.matchMedia ||
      !window.matchMedia('(pointer: fine)').matches) {
    return;
  }

  var MARKER = {
    width: 4.5,
    color: 'rgba(38, 50, 66, 0.88)'   // dry-erase ink, slightly translucent
  };
  var CHALK = {
    width: 5.5,
    color: 'rgba(238, 240, 235, 0.30)', // soft body of the stroke
    grain: 'rgba(250, 250, 245, '       // grain dots, alpha appended per dot
  };

  // Never start a stroke from inside these -- they have their own behaviour.
  var INTERACTIVE = 'a, button, input, textarea, select, label, summary, nav,' +
                    ' table, pre, code, img, iframe, svg, .theme-toggle,' +
                    ' .avatar-container, .post-preview';
  // Only these count as "empty space" to start a drag from. Text-bearing
  // elements (p, h1, li, span...) are absent on purpose, so dragging across
  // prose still selects it.
  var CONTAINERS = {
    HTML: true, BODY: true, DIV: true, MAIN: true,
    SECTION: true, HEADER: true, FOOTER: true, ARTICLE: true
  };

  // Drawing is off until the visitor asks for it with the corner button, so a
  // stray drag while reading never leaves a mark. The choice is kept in
  // sessionStorage: it follows you between pages during a visit, but a later
  // visit starts quiet again rather than silently still being armed.
  var ARMED_KEY = 'whiteboard-armed';

  var canvas = null;
  var ctx = null;
  var clearButton = null;
  var toggleButton = null;
  var armed = false;
  var strokes = [];
  var active = null;
  var ratio = 1;
  // Where the canvas's own top-left sits in document coordinates.
  var originX = 0;
  var originY = 0;

  function theme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') {
      return attr;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /* --- Canvas sizing ------------------------------------------------- */

  function resize() {
    if (!canvas) {
      return;
    }

    // Collapse the canvas before measuring anything. It is absolutely
    // positioned, so this reflows nothing else, but it keeps the previous size
    // out of both readings below -- otherwise the page can only ever grow.
    canvas.style.width = '0px';
    canvas.style.height = '0px';

    // The canvas is positioned against <body>, whose box does not necessarily
    // start at the top of the document: the header's top margin collapses
    // through body and pushes it down (117px on these pages). Measuring the
    // real origin, rather than assuming zero, is what keeps strokes under the
    // cursor instead of that far below it.
    var box = canvas.getBoundingClientRect();
    originX = box.left + (window.pageXOffset || 0);
    originY = box.top + (window.pageYOffset || 0);

    var documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.body.offsetHeight,
      originY + window.innerHeight
    );

    // clientWidth excludes the scrollbar, so the canvas can't cause a
    // horizontal one of its own.
    var width = document.documentElement.clientWidth;
    var height = Math.max(0, documentHeight - originY);

    ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    // Resizing the backing store resets the context, so re-apply the scale.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  }

  /* --- Drawing -------------------------------------------------------- */

  // Deterministic value noise. Using Math.random here would make the chalk
  // grain reshuffle itself on every resize and theme switch; keying it to the
  // coordinates means a redraw reproduces the same speckle.
  function noise(x, y, i) {
    var n = Math.sin(x * 12.9898 + y * 78.233 + i * 37.719) * 43758.5453;
    return n - Math.floor(n);
  }

  function drawMarkerSegment(from, to) {
    ctx.strokeStyle = MARKER.color;
    ctx.lineWidth = MARKER.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  function drawChalkSegment(from, to) {
    ctx.strokeStyle = CHALK.color;
    ctx.lineWidth = CHALK.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Scatter dust along the segment, thinner towards the edges, which is what
    // makes it read as chalk rather than a soft pen.
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var length = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.max(1, Math.ceil(length));
    var spread = CHALK.width * 0.9;

    for (var i = 0; i < steps; i++) {
      var t = i / steps;
      var x = from.x + dx * t;
      var y = from.y + dy * t;
      for (var k = 0; k < 2; k++) {
        var a = noise(x, y, i + k * 7);
        var b = noise(y, x, i + k * 13);
        var offsetX = (a - 0.5) * spread * 2;
        var offsetY = (b - 0.5) * spread * 2;
        ctx.fillStyle = CHALK.grain + (0.05 + a * 0.16).toFixed(3) + ')';
        ctx.fillRect(x + offsetX, y + offsetY, 1.1, 1.1);
      }
    }
  }

  function drawSegment(from, to) {
    if (theme() === 'dark') {
      drawChalkSegment(from, to);
    } else {
      drawMarkerSegment(from, to);
    }
  }

  function redraw() {
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var s = 0; s < strokes.length; s++) {
      var points = strokes[s];
      for (var p = 1; p < points.length; p++) {
        drawSegment(points[p - 1], points[p]);
      }
    }
  }

  /* --- Board plumbing -------------------------------------------------- */

  function storedArmed() {
    try {
      return window.sessionStorage.getItem(ARMED_KEY) === 'on';
    } catch (error) {
      return false;
    }
  }

  function setArmed(value) {
    armed = !!value;
    try {
      window.sessionStorage.setItem(ARMED_KEY, armed ? 'on' : 'off');
    } catch (error) {
      // Private browsing: the setting just won't outlive this page.
    }
    if (toggleButton) {
      toggleButton.setAttribute('aria-pressed', armed ? 'true' : 'false');
      toggleButton.title = armed ? 'Drawing on — drag to draw' : 'Draw on the page';
    }
    // Drives the crosshair cursor, so it's obvious the mode is live.
    document.body.classList.toggle('board-armed', armed);
    if (!armed) {
      active = null;
    }
  }

  function build() {
    canvas = document.createElement('canvas');
    canvas.className = 'board-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');

    toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'board-toggle';
    toggleButton.setAttribute('aria-label', 'Draw on the page');
    toggleButton.setAttribute('aria-pressed', 'false');
    // Two drawing implements, one per theme: a chisel-tip marker for the
    // whiteboard, a stick of chalk for the chalkboard. Which one shows is
    // decided in CSS (see --bj-icon-marker / --bj-icon-chalk in dark-mode.css)
    // rather than here, so it follows the theme without any extra JavaScript.
    toggleButton.innerHTML =
      '<svg class="board-icon board-icon-marker" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<g transform="rotate(-45 12 12)" fill="currentColor">' +
          '<rect x="9" y="2.5" width="6" height="11.5" rx="1.4"/>' +
          '<rect x="8.4" y="14.4" width="7.2" height="1.9" rx="0.5"/>' +
          '<path d="M9.3 17.1h5.4l-1.5 4.2a0.6 0.6 0 0 1-0.56 0.4h-1.28a0.6 0.6 0 0 1-0.56-0.4z"/>' +
        '</g>' +
      '</svg>' +
      '<svg class="board-icon board-icon-chalk" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<g transform="rotate(-45 12 12)" fill="currentColor">' +
          '<rect x="9.2" y="3.2" width="5.6" height="14" rx="1.1"/>' +
          '<path d="M9.2 17.2h5.6v2.1c0 0.5-0.35 0.85-0.8 0.85h-4c-0.45 0-0.8-0.35-0.8-0.85z" ' +
            'opacity="0.55"/>' +
          '<circle cx="10.1" cy="21.2" r="0.62" opacity="0.5"/>' +
          '<circle cx="13.4" cy="21.9" r="0.45" opacity="0.35"/>' +
        '</g>' +
      '</svg>';
    toggleButton.addEventListener('click', function () {
      setArmed(!armed);
    });
    document.body.appendChild(toggleButton);

    clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'board-clear';
    clearButton.setAttribute('aria-label', 'Clear the drawing');
    clearButton.title = 'Clear the drawing (Esc)';
    clearButton.innerHTML = '<i class="fas fa-eraser" aria-hidden="true"></i>';
    clearButton.addEventListener('click', clearBoard);
    document.body.appendChild(clearButton);

    resize();
  }

  function showClearButton(visible) {
    if (clearButton) {
      clearButton.classList.toggle('is-visible', visible);
    }
  }

  function clearBoard() {
    strokes = [];
    active = null;
    redraw();
    showClearButton(false);
  }

  // Is there an actual glyph under the pointer?
  //
  // Checking event.target isn't enough. Pages written as plain HTML (the
  // landing page, for one) put their text straight inside a <div> with no <p>
  // around it, so pressing on that text reports the container as the target and
  // a naive check would start drawing instead of letting the text be selected.
  // This asks the document what character sits at the point, then confirms the
  // pointer is really inside that character's box -- caret lookups otherwise
  // snap to the nearest text however far away it is.
  function isOverText(clientX, clientY) {
    var range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(clientX, clientY);
    } else if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(clientX, clientY);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
      }
    }
    if (!range || !range.startContainer || range.startContainer.nodeType !== 3) {
      return false;
    }

    var node = range.startContainer;
    var text = node.textContent;
    if (!text || !text.trim()) {
      return false;
    }

    var index = Math.max(0, Math.min(range.startOffset, text.length - 1));
    var character = document.createRange();
    character.setStart(node, index);
    character.setEnd(node, index + 1);

    var rects = character.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i];
      if (clientX >= rect.left - 2 && clientX <= rect.right + 2 &&
          clientY >= rect.top - 2 && clientY <= rect.bottom + 2) {
        return true;
      }
    }
    return false;
  }

  function canStartAt(event) {
    if (!armed) {
      return false;
    }
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) {
      return false;
    }
    var target = event.target;
    if (!target || target.nodeType !== 1) {
      return false;
    }
    if (target.closest && target.closest(INTERACTIVE)) {
      return false;
    }
    if (CONTAINERS[target.tagName] !== true) {
      return false;
    }
    return !isOverText(event.clientX, event.clientY);
  }

  function pointFrom(event) {
    // Document coordinates, shifted into the canvas's own space. Storing them
    // relative to the page (rather than the viewport) is what keeps drawings
    // anchored to the content when it scrolls.
    return { x: event.pageX - originX, y: event.pageY - originY };
  }

  function onPointerDown(event) {
    if (!canStartAt(event)) {
      return;
    }
    active = [pointFrom(event)];
    strokes.push(active);
    showClearButton(true);
    // Stops the press turning into a text selection or an image drag.
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!active) {
      return;
    }
    var point = pointFrom(event);
    var previous = active[active.length - 1];
    // Ignore sub-pixel jitter; it just multiplies work for no visible gain.
    if (Math.abs(point.x - previous.x) < 1 && Math.abs(point.y - previous.y) < 1) {
      return;
    }
    active.push(point);
    drawSegment(previous, point);
  }

  function onPointerUp() {
    if (!active) {
      return;
    }
    // A click that never moved leaves a single point and no visible ink.
    if (active.length < 2) {
      strokes.pop();
      showClearButton(strokes.length > 0);
    }
    active = null;
  }

  function start() {
    build();
    setArmed(storedArmed());

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);

    // Escape wipes the board; pressing it again on a clean board switches
    // drawing back off, so there's always a way out from the keyboard.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') {
        return;
      }
      if (strokes.length) {
        clearBoard();
      } else if (armed) {
        setArmed(false);
      }
    });

    var pending = false;
    window.addEventListener('resize', function () {
      if (pending) {
        return;
      }
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        resize();
      });
    });

    // Late-loading images and fonts change the page height.
    window.addEventListener('load', resize);

    // Re-render in the other medium when the theme is switched.
    if (window.MutationObserver) {
      new MutationObserver(redraw).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
