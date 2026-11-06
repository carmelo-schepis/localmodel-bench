/* Compare charts: pure maths and SVG string builders.
   Plain data in, markup out. No DOM reads and no access to app state.
   Loaded before app.js; esc() comes from app.js and is only called while a builder runs. */

const CHART_CHAR_WIDTH = 7.2; // px per character for 12px monospace labels (approximate)

function chartFamily(model) {
  return String(model).split('/').pop().split(':')[0].toLowerCase();
}

function chartTrim(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

function chartSeconds(value) {
  const total = Number(value) || 0;
  if (total < 59.95) return `${total.toFixed(1)}s`;
  const whole = Math.round(total);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

function chartNiceCeil(value) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / power) * power;
}

function chartMedian(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/* Minimise x (time or cost), maximise y (score or index). Ties at one x keep the higher y. */
function chartParetoFrontier(points) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || b.y - a.y);
  const frontier = [];
  let best = -Infinity;
  for (const point of sorted) {
    if (point.y > best) {
      frontier.push(point);
      best = point.y;
    }
  }
  return frontier;
}

function chartLogTicks(min, max) {
  const ticks = [];
  for (let decade = Math.floor(Math.log10(min)); decade <= Math.ceil(Math.log10(max)); decade += 1) {
    for (const multiple of [1, 2, 5]) {
      const value = multiple * 10 ** decade;
      if (value >= min && value <= max) ticks.push(value);
    }
  }
  return ticks;
}

/* Log domain padded by about 15% each side, or by a factor of 1.5 when every value is equal. */
function chartLogDomain(values) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (low === high) return [low / 1.5, high * 1.5];
  return [low / 1.15, high * 1.15];
}

function chartHatchId(fillVar) {
  return `chart-hatch-${fillVar.replace(/[^a-z0-9]/gi, '')}`;
}

function chartHatchPattern(fillVar) {
  return `<pattern id="${chartHatchId(fillVar)}" width="8" height="8" patternUnits="userSpaceOnUse">
    <rect width="8" height="8" style="fill:var(${fillVar})"/>
    <rect width="4" height="4" style="fill:#000;fill-opacity:.45"/>
    <rect x="4" y="4" width="4" height="4" style="fill:#000;fill-opacity:.45"/>
  </pattern>`;
}

function chartDiamond(cx, cy, r) {
  const d = r + 1;
  return `M${cx} ${cy - d} L${cx + d} ${cy} L${cx} ${cy + d} L${cx - d} ${cy} Z`;
}

/* Label placement: try eight positions around a mark, take the first that is inside the plot and
   clashes with nothing; otherwise take the position with the least overlap. A label is always drawn. */
function chartCandidates(x, y, r, w, h) {
  const g = r + 4;
  const d = g * 0.7;
  return [
    { anchor: 'start', left: x + g, top: y - h / 2 },
    { anchor: 'end', left: x - g - w, top: y - h / 2 },
    { anchor: 'middle', left: x - w / 2, top: y - g - h },
    { anchor: 'middle', left: x - w / 2, top: y + g },
    { anchor: 'start', left: x + d, top: y - d - h },
    { anchor: 'end', left: x - d - w, top: y - d - h },
    { anchor: 'start', left: x + d, top: y + d },
    { anchor: 'end', left: x - d - w, top: y + d },
  ].map(candidate => ({ ...candidate, right: candidate.left + w, bottom: candidate.top + h }));
}

function chartOverlap(a, b) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function chartPlaceLabels(marks, box) {
  const obstacles = marks.map(mark => ({ left: mark.x - mark.r, right: mark.x + mark.r, top: mark.y - mark.r, bottom: mark.y + mark.r }));
  const placed = [];
  return marks.map(mark => {
    const w = mark.w;
    const h = mark.h;
    const candidates = chartCandidates(mark.x, mark.y, mark.r, w, h);
    let chosen = null;
    let fallback = null;
    for (const candidate of candidates) {
      const inside = candidate.left >= box.left && candidate.right <= box.right && candidate.top >= box.top && candidate.bottom <= box.bottom;
      if (!inside) continue;
      const clash = [...obstacles, ...placed].reduce((sum, other) => sum + chartOverlap(candidate, other), 0);
      if (clash === 0) { chosen = candidate; break; }
      if (!fallback || clash < fallback.clash) fallback = { candidate, clash };
    }
    chosen = chosen || fallback?.candidate || candidates[0];
    const left = Math.min(Math.max(chosen.left, box.left), box.right - w);
    const top = Math.min(Math.max(chosen.top, box.top), box.bottom - h);
    const rect = { left, top, right: left + w, bottom: top + h };
    placed.push(rect);
    const textX = chosen.anchor === 'start' ? left : chosen.anchor === 'end' ? left + w : left + w / 2;
    return { x: textX, y: top + h / 2, anchor: chosen.anchor };
  });
}

function chartLegendHTML(items) {
  const marks = {
    swatch: item => `<i class="chart-key" style="background:var(${item.fillVar})"></i>`,
    dot: item => `<i class="chart-key is-dot" style="background:var(${item.fillVar})"></i>`,
    diamond: item => `<i class="chart-key is-diamond" style="background:var(${item.fillVar})"></i>`,
    hatch: () => '<i class="chart-key is-hatch"></i>',
    ring: () => '<i class="chart-key is-dot is-ring"></i>',
    best: () => '<i class="chart-key is-best"></i>',
    dotted: () => '<i class="chart-key is-dotted"></i>',
  };
  return items.map(item => `<span>${marks[item.kind](item)}${esc(item.text)}</span>`).join('');
}

/* Bars. items: {label, value, valueText, fillVar, partial, title}. Sorting is done by the caller. */
function chartBarsSVG({ items, width, max, signalBelow = null, footer = [], labelMax = 24, ariaLabel, plotHeight = 300 }) {
  const W = Math.max(280, Math.round(width));
  const padL = 8;
  const padR = 8;
  const padT = 34;
  const plotW = W - padL - padR;
  const plotBottom = padT + plotHeight;
  const labels = items.map(item => chartTrim(item.label, labelMax));
  const band = plotW / items.length;
  const widest = Math.max(...labels.map(label => label.length * CHART_CHAR_WIDTH));
  const rotated = band < widest + 6;
  const longest = Math.max(...labels.map(label => label.length));
  const labelArea = rotated ? Math.ceil(longest * CHART_CHAR_WIDTH * 0.72) + 30 : 44;
  const foot = footer.length ? footer.length * 20 + 14 : 0;
  const H = plotBottom + labelArea + foot;

  const grid = [0.25, 0.5, 0.75, 1].map(fraction => {
    const y = plotBottom - fraction * plotHeight;
    return `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="chart-grid"/>`;
  }).join('');

  const hatchFills = [...new Set(items.filter(item => item.partial).map(item => item.fillVar))];
  const patterns = hatchFills.map(chartHatchPattern).join('');

  const bars = items.map((item, index) => {
    const cx = padL + band * (index + 0.5);
    const barW = Math.min(band * 0.75, 96);
    const h = Math.max(2, Math.min(plotHeight, (item.value / max) * plotHeight));
    const y = plotBottom - h;
    const fill = item.partial ? `url(#${chartHatchId(item.fillVar)})` : `var(${item.fillVar})`;
    const signal = signalBelow !== null && item.value < signalBelow;
    const fitsInside = !signal && h >= 26 && item.valueText.length * 7.5 + 8 <= barW;
    const valueY = fitsInside ? y + h / 2 : y - 8;
    const valueClass = `chart-value${fitsInside ? ' is-inside' : ''}${signal ? ' is-signal' : ''}`;
    const label = labels[index];
    const labelMarkup = rotated
      ? `<text transform="translate(${cx + 4} ${plotBottom + 26}) rotate(-45)" text-anchor="end" class="chart-label">${esc(label)}</text>`
      : `<text x="${cx}" y="${plotBottom + 36}" text-anchor="middle" class="chart-label">${esc(label)}</text>`;
    return `<g class="chart-bar" data-value="${item.value}" data-label="${esc(item.label)}">
      <title>${esc(item.title)}</title>
      <rect x="${cx - barW / 2}" y="${y}" width="${barW}" height="${h}" rx="3" style="fill:${fill}"/>
      <text x="${cx}" y="${valueY}" text-anchor="middle" dominant-baseline="middle" class="${valueClass}">${esc(item.valueText)}</text>
      <circle cx="${cx}" cy="${plotBottom + 14}" r="4" style="fill:var(${item.fillVar})"/>
      ${labelMarkup}
    </g>`;
  }).join('');

  const footers = footer.map((line, index) => {
    const y = H - foot + 20 + index * 20;
    const text = `<text x="${padL}" y="${y}" class="chart-foot">${esc(line.text)}</text>`;
    return line.href ? `<a href="${esc(line.href)}" target="_blank" rel="noopener">${text}</a>` : text;
  }).join('');

  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(ariaLabel)}" focusable="false">
    <defs>${patterns}</defs>${grid}
    <line x1="${padL}" x2="${W - padR}" y1="${plotBottom}" y2="${plotBottom}" class="chart-axis"/>
    ${bars}${footers}
  </svg>`;
}

/* Scatter. points: {x, y, fillVar, shape: 'circle'|'diamond', partial, muted, opacity, label, title}.
   lines: [{fillVar, points: [{x, y}]}] sorted by x. Both axes use x in log scale. */
function chartScatterSVG({ points, lines = [], width, height, xTitle, yTitle, yMax = 100, yTicks, xFormat, bestSide = 'left', pareto = false, footer = [], labelMax = 24, ariaLabel }) {
  const W = Math.max(280, Math.round(width));
  const H = Math.max(260, Math.round(height));
  const foot = footer.length ? footer.length * 20 + 14 : 0;
  const left = 58;
  const right = W - 22;
  const top = 22;
  const bottom = H - 52 - foot;
  const [xMin, xMax] = chartLogDomain(points.map(point => point.x));
  const scaleX = value => left + ((Math.log10(value) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * (right - left);
  const scaleY = value => bottom - (value / yMax) * (bottom - top);

  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const spread = Math.max(...xs) > Math.min(...xs) && Math.max(...ys) > Math.min(...ys);
  let quadrants = '';
  if (points.length >= 2 && spread) {
    const midX = scaleX(chartMedian(xs));
    const midY = scaleY(chartMedian(ys));
    quadrants = bestSide === 'left'
      ? `<rect x="${left}" y="${top}" width="${midX - left}" height="${midY - top}" class="chart-best"/>
         <rect x="${midX}" y="${midY}" width="${right - midX}" height="${bottom - midY}" class="chart-wash"/>`
      : `<rect x="${midX}" y="${top}" width="${right - midX}" height="${midY - top}" class="chart-best"/>
         <rect x="${left}" y="${midY}" width="${midX - left}" height="${bottom - midY}" class="chart-wash"/>`;
  }

  const grid = (yTicks || []).map(tick => {
    const y = scaleY(tick);
    return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" class="chart-grid"/>
      <text x="${left - 10}" y="${y}" text-anchor="end" dominant-baseline="middle" class="chart-tick">${tick}</text>`;
  }).join('');

  const xTicks = [];
  for (const tick of chartLogTicks(xMin, xMax)) {
    const x = scaleX(tick);
    if (!xTicks.length || x - xTicks[xTicks.length - 1].x >= 44) xTicks.push({ x, text: xFormat(tick) });
  }
  const xAxis = xTicks.map(tick => `<text x="${tick.x}" y="${bottom + 18}" text-anchor="middle" class="chart-tick">${esc(tick.text)}</text>`).join('');

  const frontier = pareto ? chartParetoFrontier(points.map(point => ({ x: point.x, y: point.y }))) : [];
  const paretoLine = frontier.length >= 2
    ? `<polyline points="${frontier.map(point => `${scaleX(point.x)},${scaleY(point.y)}`).join(' ')}" class="chart-pareto"/>`
    : '';

  const lineMarkup = lines.map(line => `<polyline points="${line.points.map(point => `${scaleX(point.x)},${scaleY(point.y)}`).join(' ')}" class="chart-family-line" style="stroke:var(${line.fillVar})"/>`).join('');

  const marks = points.map(point => ({ x: scaleX(point.x), y: scaleY(point.y), r: 6, text: chartTrim(point.label, labelMax) }));
  marks.forEach(mark => { mark.w = mark.text.length * CHART_CHAR_WIDTH; mark.h = 14; });
  const placed = chartPlaceLabels(marks, { left, right, top, bottom });

  const dots = points.map((point, index) => {
    const mark = marks[index];
    const shape = point.shape === 'diamond'
      ? `<path d="${chartDiamond(mark.x, mark.y, mark.r)}" ${point.partial ? 'class="chart-hollow"' : ''} style="${point.partial ? `stroke:var(${point.fillVar})` : `fill:var(${point.fillVar})`}"/>`
      : `<circle cx="${mark.x}" cy="${mark.y}" r="${mark.r}" ${point.partial ? 'class="chart-hollow"' : ''} style="${point.partial ? `stroke:var(${point.fillVar})` : `fill:var(${point.fillVar})`}"/>`;
    const at = placed[index];
    const opacity = point.opacity ?? 1;
    return `<g class="chart-point" data-x="${point.x}" data-y="${point.y}" data-label="${esc(point.label)}" opacity="${opacity}">
      <title>${esc(point.title)}</title>${shape}
      <text x="${at.x}" y="${at.y}" text-anchor="${at.anchor}" dominant-baseline="middle" class="chart-label${point.muted ? ' is-muted' : ''}">${esc(mark.text)}</text>
    </g>`;
  }).join('');

  const footers = footer.map((line, index) => {
    const y = H - foot + 20 + index * 20;
    const text = `<text x="${left}" y="${y}" class="chart-foot">${esc(line.text)}</text>`;
    return line.href ? `<a href="${esc(line.href)}" target="_blank" rel="noopener">${text}</a>` : text;
  }).join('');

  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(ariaLabel)}" focusable="false">
    ${quadrants}${grid}
    <line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" class="chart-axis"/>
    <line x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" class="chart-axis"/>
    ${xAxis}
    <text x="${(left + right) / 2}" y="${bottom + 40}" text-anchor="middle" class="chart-axis-title">${esc(xTitle)}</text>
    <text transform="translate(16 ${(top + bottom) / 2}) rotate(-90)" text-anchor="middle" class="chart-axis-title">${esc(yTitle)}</text>
    ${paretoLine}${lineMarkup}${dots}${footers}
  </svg>`;
}
