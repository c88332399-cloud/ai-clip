const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const h = m ? m[1] : 'FFFFFF'; return '&H00' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2); };
const ts = t => { t = Math.max(0, t); const h = t / 3600 | 0, m = t % 3600 / 60 | 0, s = t % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };
const clean = t => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ');

// Группы субтитров из слов (или из сегментов, если слов нет), время относительно начала клипа.
export function groups(tr, start, end, maxChars) {
  const ws = (tr.words || []).filter(w => w.end > start && w.start < end && w.word);
  const G = [];
  if (ws.length) {
    let g = null;
    for (const w of ws) {
      const o = { w: clean(w.word), s: Math.max(0, w.start - start), e: Math.min(end - start, w.end - start) };
      if (!g || g.len + o.w.length > maxChars || o.s - g.words[g.words.length - 1].e > 0.8 || o.e - g.start > 3.4) { g = { start: o.s, words: [], len: 0 }; G.push(g); }
      g.words.push(o); g.len += o.w.length + 1; g.end = o.e;
    }
  } else for (const s of tr.segments) if (s.end > start && s.start < end) G.push({ start: Math.max(0, s.start - start), end: Math.min(end - start, s.end - start), words: null, text: clean(s.text) });
  return G;
}
export const groupText = g => g.text ?? g.words.map(w => w.w).join(' ');

export function buildAss(G, { W, H, s }) {
  const size = Math.round(H * ({ S: .032, M: .042, L: .056 }[s.size] || .042) * (W > H ? 1.15 : 1));
  const align = { bottom: 2, center: 5, top: 8 }[s.pos] || 2, mv = Math.round(H * (s.pos === 'bottom' ? .09 : .08)), mx = Math.round(W * .06);
  const hl = s.highlight && s.anim !== 'word';
  const prim = hl ? '&H0078D920' : hex(s.color), sec = hex(s.color);
  const font = String(s.font || 'Arial').replace(/[^\w ]/g, '') || 'Arial';
  const out = [`[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n`,
    `[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding`,
    `Style: Default,${font},${size},${prim},${sec},&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${s.outline ? Math.max(2, Math.round(size / 14)) : 0},0,${align},${mx},${mx},${mv},1\n`,
    `[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`];
  const ev = (a, b, t) => out.push(`Dialogue: 0,${ts(a)},${ts(b)},Default,,0,0,0,,${t}`);
  for (const g of G) {
    const pre = s.anim === 'pop' ? '{\\fscx82\\fscy82\\t(0,140,\\fscx100\\fscy100)}' : s.anim === 'fade' ? '{\\fad(150,100)}' : '';
    if (!g.words) { ev(g.start, g.end, pre + g.text); continue; }
    if (s.anim === 'word') { g.words.forEach((w, i) => ev(w.s, i + 1 < g.words.length ? g.words[i + 1].s : g.end, g.words.slice(0, i + 1).map(x => x.w).join(' '))); continue; }
    if (hl) ev(g.start, g.end, pre + g.words.map((w, i) => `{\\kf${Math.max(1, Math.round(((g.words[i + 1]?.s ?? g.end) - w.s) * 100))}}${w.w}`).join(' '));
    else ev(g.start, g.end, pre + groupText(g));
  }
  return out.join('\n') + '\n';
}
