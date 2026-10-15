// Stacked daily bar chart (contained vs handed off) drawn as SVG, with a hover tooltip.

import { esc } from './ui.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

function niceMax(v) {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// path for a bar with rounded top corners only
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function dailyChart(container, rows) {
  if (!rows.length) {
    container.innerHTML = '<p class="muted">No chats with an employer message in this range.</p>';
    return;
  }
  const W = Math.max(container.clientWidth || 640, 320);
  const H = 220;
  const m = { top: 10, right: 8, bottom: 26, left: 34 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(...rows.map((r) => r.total)));
  const band = iw / rows.length;
  const bw = Math.max(3, Math.min(36, band * 0.62));
  const y = (v) => m.top + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(rows.length / Math.max(1, Math.floor(iw / 56)));

  let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Engaged chats per day, contained and handed off">`;
  ticks.forEach((t) => {
    svg += `<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}" stroke="var(${t === 0 ? '--axis' : '--grid'})" stroke-width="1"/>`;
    svg += `<text x="${m.left - 6}" y="${y(t) + 4}" text-anchor="end" class="num">${Math.round(t)}</text>`;
  });
  rows.forEach((r, i) => {
    const x = m.left + i * band + (band - bw) / 2;
    const yC = y(r.contained);
    const hC = m.top + ih - yC;
    const yH = y(r.total);
    const hH = yC - yH;
    const gap = r.contained && r.handedOff ? 2 : 0;
    if (r.contained) {
      svg += r.handedOff
        ? `<rect x="${x}" y="${yC}" width="${bw}" height="${hC}" fill="var(--series-1)"/>`
        : `<path d="${topRounded(x, yC, bw, hC, 4)}" fill="var(--series-1)"/>`;
    }
    if (r.handedOff) svg += `<path d="${topRounded(x, yH, bw, Math.max(1, hH - gap), 4)}" fill="var(--series-2)"/>`;
    // hit target: the whole column
    svg += `<rect class="hit" data-i="${i}" x="${m.left + i * band}" y="${m.top}" width="${band}" height="${ih}" fill="transparent"/>`;
    if (i % labelEvery === 0) svg += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${dayLabel(r.date)}</text>`;
  });
  svg += '</svg>';

  container.innerHTML = `
    <div class="legend"><span><i style="background:var(--series-1)"></i>Contained by the bot</span><span><i style="background:var(--series-2)"></i>Handed off to support</span></div>
    <div class="chart-wrap">${svg}<div class="tooltip hidden"></div></div>`;
  const wrap = container.querySelector('.chart-wrap');
  const tip = container.querySelector('.tooltip');
  wrap.querySelectorAll('.hit').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const r = rows[Number(el.dataset.i)];
      tip.innerHTML = `<b>${esc(dayLabel(r.date))}</b>${r.total} engaged chats<br>${r.contained} contained · ${r.handedOff} handed off (${Math.round((100 * r.handedOff) / r.total)}%)`;
      tip.classList.remove('hidden');
      const bx = Number(el.getAttribute('x')) + Number(el.getAttribute('width')) / 2;
      const left = Math.min(Math.max(bx - tip.offsetWidth / 2, 0), W - tip.offsetWidth);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, y(r.total) - tip.offsetHeight - 8)}px`;
      el.setAttribute('fill', 'rgba(127,127,127,0.08)');
    });
    el.addEventListener('mouseleave', () => {
      tip.classList.add('hidden');
      el.setAttribute('fill', 'transparent');
    });
  });
}
