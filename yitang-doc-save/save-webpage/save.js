const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/** 项目根（含 save.js、browser-data）。可通过环境变量在其他工作目录下调用脚本。 */
const SAVE_ROOT = process.env.YITANG_SAVE_ROOT
  ? path.resolve(process.env.YITANG_SAVE_ROOT)
  : __dirname;

const TARGET_URL = process.argv[2];
const OUTPUT_NAME_ARG = process.argv[3];
const FROM_TITLE_SENTINEL = '__FROM_TITLE__';

if (!TARGET_URL) {
  console.error('用法: node save.js <URL> <输出目录名|' + FROM_TITLE_SENTINEL + '>');
  console.error('  输出目录名须与用户确认，勿使用 URL 中的 id。');
  console.error('  若用户同意以页面标题作为文件夹名，传入 ' + FROM_TITLE_SENTINEL + '（加载后自动用标题生成目录名）。');
  console.error('  可选环境变量 YITANG_SAVE_ROOT=本目录绝对路径（在任意 cwd 下运行脚本时使用）。');
  process.exit(1);
}
if (!OUTPUT_NAME_ARG) {
  console.error('错误: 缺少输出目录名。请与用户确认后传入第 3 个参数，勿留空。');
  process.exit(1);
}

const SIGNAL_FILE = path.join(SAVE_ROOT, 'GO');
const USER_DATA_DIR = path.join(SAVE_ROOT, 'browser-data');

/** 块内容去标签，用于匹配「一堂活动信息」等标题 */
function stripBlockText(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u200b/g, '')
    .replace(/&#8203;/g, '')
    .trim();
}

/** 是否视为「一堂活动信息」版块起始块（避免正文偶然提及误截断） */
function matchesYitangActivityHeader(b) {
  const t = stripBlockText(b.content);
  if (!t.includes('一堂活动信息')) return false;
  const pos = t.indexOf('一堂活动信息');
  if (pos > 40) return false;
  if (b.type === 'heading') return true;
  if (t.length <= 120) return true;
  return false;
}

/** 丢弃从「一堂活动信息」标题起的文末区块 */
function sliceBeforeYitangActivitySection(blocks) {
  if (!blocks || !blocks.length) return blocks;
  const idx = blocks.findIndex(matchesYitangActivityHeader);
  if (idx === -1) return blocks;
  return blocks.slice(0, idx);
}

function collectImageUrlsFromBlocks(blocks) {
  const set = new Set();
  for (const block of blocks) {
    if (block.imgSrc && !block.imgSrc.startsWith('data:')) set.add(block.imgSrc);
    if (block.type === 'images' && block.content) {
      const srcMatches = block.content.match(/src="([^"]+)"/g);
      if (srcMatches) {
        srcMatches.forEach(m => {
          const url = m.replace('src="', '').replace('"', '');
          if (!url.startsWith('data:')) set.add(url);
        });
      }
    }
    if (block.type === 'table' && block.content) {
      const srcMatches = block.content.match(/src="([^"]+)"/g);
      if (srcMatches) {
        srcMatches.forEach(m => {
          const url = m.replace('src="', '').replace('"', '');
          if (!url.startsWith('data:')) set.add(url);
        });
      }
    }
  }
  return [...set];
}

function sanitizeForDir(name) {
  if (!name || typeof name !== 'string') return '';
  const s = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return s.substring(0, 120) || '';
}

async function getDocumentTitle(page) {
  const raw = await page.evaluate(() => {
    const t = (document.title && document.title.trim()) || '';
    const og = document.querySelector('meta[property="og:title"]');
    const ogT = og && (og.getAttribute('content') || '').trim();
    return { title: t, og: ogT };
  });
  let cand = (raw.og || raw.title || '').trim();
  cand = cand
    .replace(/\s*[-|·｜]\s*一堂创业课\s*$/i, '')
    .replace(/\s*[-|·｜]\s*一堂\s*$/i, '')
    .trim();
  return cand;
}

async function waitForSignalFile() {
  console.log('等待信号文件...');
  while (!fs.existsSync(SIGNAL_FILE)) await new Promise(r => setTimeout(r, 1000));
  fs.unlinkSync(SIGNAL_FILE);
  console.log('收到信号，开始！\n');
}

function extractBlockContent() {
  const container = document.querySelector('.virtual-list > div');
  if (!container) return [];

  function getRenderedStyles(el) {
    const cs = getComputedStyle(el);
    const styles = [];

    const color = cs.color;
    if (color && color !== 'rgb(51, 51, 51)' && color !== 'rgb(0, 0, 0)' && color !== 'rgba(0, 0, 0, 0)') {
      styles.push(`color: ${color}`);
    }

    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)') {
      styles.push(`background-color: ${bg}`);
    }

    const fw = cs.fontWeight;
    if (fw !== '400' && fw !== 'normal') {
      styles.push(`font-weight: ${fw}`);
    }

    const fs = parseInt(cs.fontSize);
    if (fs && fs !== 16 && fs !== 15) {
      styles.push(`font-size: ${fs}px`);
    }

    const td = cs.textDecorationLine || cs.textDecoration;
    if (td && td !== 'none') {
      styles.push(`text-decoration: ${td}`);
    }

    return styles.length ? styles.join('; ') : '';
  }

  /** 块级元素的排版样式（居中/右对齐等多来自 div/p；span 上不写 text-align） */
  function getBlockTypographyStyles(el) {
    const cs = getComputedStyle(el);
    const styles = [];

    const ta = cs.textAlign;
    if (ta && ta !== 'start' && ta !== 'left') {
      styles.push(`text-align: ${ta}`);
    }

    const va = cs.verticalAlign;
    if ((va === 'top' || va === 'baseline') && (el.closest && (el.closest('td') || el.closest('th')))) {
      styles.push(`vertical-align: ${va}`);
    }

    const fw = cs.fontWeight;
    if (fw !== '400' && fw !== 'normal') {
      styles.push(`font-weight: ${fw}`);
    }

    const fs = parseInt(cs.fontSize, 10);
    if (fs && fs !== 16 && fs !== 15) {
      styles.push(`font-size: ${fs}px`);
    }

    const color = cs.color;
    if (color && color !== 'rgb(51, 51, 51)' && color !== 'rgb(0, 0, 0)' && color !== 'rgba(0, 0, 0, 0)') {
      styles.push(`color: ${color}`);
    }

    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)') {
      styles.push(`background-color: ${bg}`);
    }

    return styles.length ? styles.join('; ') : '';
  }

  function mergeSpanAndBlockTypography(el) {
    const a = getRenderedStyles(el);
    const b = getBlockTypographyStyles(el);
    if (a && b) return `${a}; ${b}`;
    return a || b;
  }

  function getCellComputedStyles(el) {
    const cs = getComputedStyle(el);
    const styles = [];

    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)') {
      styles.push(`background-color: ${bg}`);
    }

    const color = cs.color;
    if (color && color !== 'rgb(51, 51, 51)' && color !== 'rgb(0, 0, 0)' && color !== 'rgba(0, 0, 0, 0)') {
      styles.push(`color: ${color}`);
    }

    const fw = cs.fontWeight;
    if (fw !== '400' && fw !== 'normal') {
      styles.push(`font-weight: ${fw}`);
    }

    const fs = parseInt(cs.fontSize);
    if (fs && fs !== 16 && fs !== 15) {
      styles.push(`font-size: ${fs}px`);
    }

    const ta = cs.textAlign;
    if (ta && ta !== 'start' && ta !== 'left') {
      styles.push(`text-align: ${ta}`);
    }

    const va = cs.verticalAlign;
    if (va && va !== 'middle' && va !== 'baseline') {
      styles.push(`vertical-align: ${va}`);
    }

    const ws = cs.whiteSpace;
    if (ws && ws !== 'normal') {
      styles.push(`white-space: ${ws}`);
    }

    const defBorder = '1px solid rgb(221, 221, 221)';
    const bt = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
    const br = `${cs.borderRightWidth} ${cs.borderRightStyle} ${cs.borderRightColor}`;
    const bb = `${cs.borderBottomWidth} ${cs.borderBottomStyle} ${cs.borderBottomColor}`;
    const bl = `${cs.borderLeftWidth} ${cs.borderLeftStyle} ${cs.borderLeftColor}`;

    if (bt === br && bt === bb && bt === bl) {
      if (bt !== defBorder && !bt.startsWith('0px')) {
        styles.push(`border: ${bt}`);
      }
    } else {
      if (!bt.startsWith('0px') && bt !== defBorder) styles.push(`border-top: ${bt}`);
      if (!br.startsWith('0px') && br !== defBorder) styles.push(`border-right: ${br}`);
      if (!bb.startsWith('0px') && bb !== defBorder) styles.push(`border-bottom: ${bb}`);
      if (!bl.startsWith('0px') && bl !== defBorder) styles.push(`border-left: ${bl}`);
    }

    const pad = cs.padding;
    if (pad && pad !== '0px' && pad !== '8px 12px') {
      styles.push(`padding: ${pad}`);
    }

    return styles.length ? styles.join('; ') : '';
  }

  function processTable(tableEl) {
    function buildTableHTML(el) {
      if (el.nodeType === 3) return el.textContent;
      if (el.nodeType !== 1) return '';

      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'template'].includes(tag)) return '';

      if (tag === 'table') {
        let childrenHTML = '';
        for (const child of el.childNodes) {
          childrenHTML += buildTableHTML(child);
        }
        return `<table style="width: 100%; border-collapse: collapse;">${childrenHTML}</table>`;
      }

      if (['thead', 'tbody', 'tfoot', 'tr'].includes(tag)) {
        let childrenHTML = '';
        for (const child of el.childNodes) {
          childrenHTML += buildTableHTML(child);
        }
        return `<${tag}>${childrenHTML}</${tag}>`;
      }

      if (tag === 'th' || tag === 'td') {
        const colspan = el.getAttribute('colspan');
        const rowspan = el.getAttribute('rowspan');
        let attrs = '';
        if (colspan) attrs += ` colspan="${colspan}"`;
        if (rowspan) attrs += ` rowspan="${rowspan}"`;

        const cellStyle = getCellComputedStyles(el);
        if (cellStyle) attrs += ` style="${cellStyle}"`;

        let childrenHTML = '';
        const wrappers = el.querySelectorAll('.render-unit-wrapper');

        /** 同一单元格内相同 src 的图片往往来自嵌套块重复采集，仅保留首次 */
        function dedupeImgTagsBySrc(html) {
          if (!html) return html;
          const seen = new Set();
          return html.replace(/<img\b[^>]*>/gi, (tag) => {
            const m = tag.match(/\ssrc="([^"]+)"/i);
            if (!m) return tag;
            const src = m[1];
            if (seen.has(src)) return '';
            seen.add(src);
            return tag;
          });
        }

        if (wrappers.length > 0) {
          const blocks = [];
          wrappers.forEach(w => {
            w.querySelectorAll('.block').forEach(b => blocks.push(b));
          });

          /** 避免嵌套 .block 重复输出：父级 cleanHTML 已含子块内容则跳过后续子块下标 */
          const skipBlock = new Set();
          function markSkipNested(i) {
            const root = blocks[i];
            for (let j = 0; j < blocks.length; j++) {
              if (j === i || skipBlock.has(j)) continue;
              if (root.contains(blocks[j])) skipBlock.add(j);
            }
          }

          /** 源码 docx 列表块通常已自带 Word 式序号或项目符号，勿再包裹 ol/ul/li（会与浏览器列表符号重复）。
           * 去掉：(1) 仅序号 + <br> + 正文 的假换行；(2) 相邻 div/p 分段中首段仅为序号时的多余换行（含外层单 div 包裹）。 */
          function mergeTdNativeListMarkers(html, kind /* 'ordered' | 'unordered' */) {
            function stripPlain(s) {
              return (s || '')
                .replace(/<[^>]+>/g, '')
                .replace(/[\u200b\u00a0\u3000\u200c\u200d]/g, '')
                .replace(/\s+/g, '')
                .trim();
            }

            function isMarkerPlain(plainCompact) {
              if (kind === 'ordered') {
                return /^[（(]?\d{1,4}[)）.．、]?$/.test(plainCompact);
              }
              return plainCompact.length === 1 && /^[•●·‧▪\-\*\u2022]$/.test(plainCompact);
            }

            function mergeLeadingBrSplits(s) {
              let h = s.trim();
              for (let guard = 0; guard < 12; guard++) {
                const m = /^([\s\S]*?)<br\s*\/?(?:\s*)>([\s\S]+)$/i.exec(h);
                if (!m) break;
                const head = m[1];
                const tail = m[2].trim();
                if (!tail) break;
                if (!isMarkerPlain(stripPlain(head))) break;
                h = `${head.trim()} ${tail}`;
              }
              return h;
            }

            /** 仅以「开头的」两个 sibling 分段为对象；首段去掉标签后为短序号，避免误伤正文对照表 */
            function mergeSiblingBlockPairAtStart(h) {
              const maxMarkerShell = 120;
              let s = h.trim();

              function tryOnce(t) {
                let m =
                  /^(\s*)<div(\s[^>]*)>([\s\S]*?)<\/div>\s*<div(\s[^>]*)>([\s\S]*?)<\/div>([\s\S]*)$/i.exec(
                    t
                  );
                if (
                  m &&
                  m[3].trim().length <= maxMarkerShell &&
                  isMarkerPlain(stripPlain(m[3]))
                ) {
                  return `${m[1]}<div${m[2]}>${m[3].trim()} ${m[5].trim()}</div>${m[6] || ''}`;
                }
                m =
                  /^(\s*)<div(\s[^>]*)>([\s\S]*?)<\/div>\s*<p(\s[^>]*)>([\s\S]*?)<\/p>([\s\S]*)$/i.exec(
                    t
                  );
                if (
                  m &&
                  m[3].trim().length <= maxMarkerShell &&
                  isMarkerPlain(stripPlain(m[3]))
                ) {
                  return `${m[1]}<div${m[2]}>${m[3].trim()} ${m[5].trim()}</div>${m[6] || ''}`;
                }
                m =
                  /^(\s*)<p(\s[^>]*)>([\s\S]*?)<\/p>\s*<div(\s[^>]*)>([\s\S]*?)<\/div>([\s\S]*)$/i.exec(
                    t
                  );
                if (
                  m &&
                  m[3].trim().length <= maxMarkerShell &&
                  isMarkerPlain(stripPlain(m[3]))
                ) {
                  return `${m[1]}<p${m[2]}>${m[3].trim()} ${m[5].trim()}</p>${m[6] || ''}`;
                }
                m =
                  /^(\s*)<p(\s[^>]*)>([\s\S]*?)<\/p>\s*<p(\s[^>]*)>([\s\S]*?)<\/p>([\s\S]*)$/i.exec(
                    t
                  );
                if (
                  m &&
                  m[3].trim().length <= maxMarkerShell &&
                  isMarkerPlain(stripPlain(m[3]))
                ) {
                  return `${m[1]}<p${m[2]}>${m[3].trim()} ${m[5].trim()}</p>${m[6] || ''}`;
                }
                return t;
              }

              for (let round = 0; round < 10; round++) {
                const next = tryOnce(s);
                if (next === s) break;
                s = next;
              }
              return s;
            }

            /** 若整段 html 仅为一个 div 外壳，返回其 innerHTML，否则 null（避免误把外壳当列表首块） */
            function peelOuterDivOnce(html) {
              const h = (html || '').trim();
              const mOpen = h.match(/^<div([^>]*)>/i);
              if (!mOpen) return null;
              const openLen = mOpen[0].length;
              let depth = 1;
              let i = openLen;
              while (i < h.length && depth > 0) {
                const sub = h.slice(i);
                const m = sub.match(/<\/?div\b[^>]*>/i);
                if (!m) return null;
                const tag = m[0];
                const at = m.index;
                const closeAbs = i + at;
                if (/^<\/div/i.test(tag)) {
                  depth--;
                  if (depth === 0) {
                    const inner = h.slice(openLen, closeAbs);
                    const rest = h.slice(closeAbs + tag.length).trim();
                    if (rest) return null;
                    return { attrs: mOpen[1] || '', inner: inner.trim() };
                  }
                } else {
                  depth++;
                }
                i = closeAbs + tag.length;
              }
              return null;
            }

            /** 自内向外：先剥壳递归，再在「无整段外壳」的片段上合并 sibling pair */
            function stripOuterDivAndMerge(s) {
              const peeled = peelOuterDivOnce(s);
              if (!peeled) return mergeSiblingBlockPairAtStart(s);
              const innerDone = stripOuterDivAndMerge(peeled.inner);
              return `<div${peeled.attrs}>${innerDone}</div>`;
            }

            let out = mergeLeadingBrSplits(html || '');
            out = stripOuterDivAndMerge(out);
            out = mergeLeadingBrSplits(out);
            return out;
          }

          /** 同一单元格内待输出的图片序列；与源站「一行多图」一致 */
          const imgAccum = [];
          /** 处于横向 docx-grid 内时，单张图也包进 yitang-td-img-row，避免与 column 组合时断行 */
          let gridHorizontalActive = false;

          function flushImgAccum() {
            if (imgAccum.length === 0) return;
            if (childrenHTML) childrenHTML += '<br>';
            const useRow = imgAccum.length >= 2 || (imgAccum.length >= 1 && gridHorizontalActive);
            if (useRow) {
              childrenHTML += '<span class="yitang-td-img-row">' + imgAccum.join('') + '</span>';
            } else {
              childrenHTML += imgAccum.join('');
            }
            imgAccum.length = 0;
            gridHorizontalActive = false;
          }

          function gridBlockIsHorizontal(el) {
            if (el.querySelector('.grid-horizontal')) return true;
            const g = el.querySelector('[class*="grid"]');
            if (g && (g.className.includes('horizontal') || g.className.includes('row'))) return true;
            try {
              const cs = getComputedStyle(el);
              if (cs.display === 'flex' && (cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse')) return true;
            } catch (e) {}
            return false;
          }

          for (let i = 0; i < blocks.length; i++) {
            if (skipBlock.has(i)) continue;
            const block = blocks[i];
            const cls = block.className || '';

            if (cls.includes('docx-ordered-block')) {
              gridHorizontalActive = false;
              flushImgAccum();
              const inner = mergeTdNativeListMarkers(cleanHTML(block), 'ordered');
              if (inner.trim()) {
                if (childrenHTML) childrenHTML += '<br>';
                childrenHTML += inner;
              }
              markSkipNested(i);
            } else if (cls.includes('docx-bulleted-block') || cls.includes('docx-unordered-block')) {
              gridHorizontalActive = false;
              flushImgAccum();
              const inner = mergeTdNativeListMarkers(cleanHTML(block), 'unordered');
              if (inner.trim()) {
                if (childrenHTML) childrenHTML += '<br>';
                childrenHTML += inner;
              }
              markSkipNested(i);
            } else if (cls.includes('docx-grid-block')) {
              flushImgAccum();
              gridHorizontalActive = gridBlockIsHorizontal(block);
            } else if (cls.includes('docx-grid_column-block')) {
              // 占位结构，不 flush 图片以便横栅格内多图连续收集
            } else if (cls.includes('docx-image-block')) {
              const img = block.querySelector('img');
              if (img) imgAccum.push(cleanHTML(img));
              markSkipNested(i);
            } else {
              gridHorizontalActive = false;
              flushImgAccum();
              const html = cleanHTML(block);
              if (html.trim()) {
                if (childrenHTML) childrenHTML += '<br>';
                childrenHTML += html;
              }
              markSkipNested(i);
            }
          }

          flushImgAccum();
        } else {
          for (const child of el.childNodes) {
            childrenHTML += cleanHTML(child);
          }
        }

        return `<${tag}${attrs}>${dedupeImgTagsBySrc(childrenHTML)}</${tag}>`;
      }

      if (tag === 'colgroup') {
        let childrenHTML = '';
        for (const child of el.childNodes) {
          childrenHTML += buildTableHTML(child);
        }
        return `<colgroup>${childrenHTML}</colgroup>`;
      }

      if (tag === 'col') {
        let attrs = '';
        const span = el.getAttribute('span');
        const width = el.getAttribute('width');
        const styleAttr = el.getAttribute('style');
        if (span) attrs += ` span="${span}"`;
        if (width) attrs += ` width="${width}"`;

        const computedPieces = [];
        try {
          const cs = getComputedStyle(el);
          const w = cs.width;
          if (w && w !== 'auto' && w !== '0px') computedPieces.push(`width: ${w}`);
          const minW = cs.minWidth;
          if (minW && minW !== 'auto' && minW !== '0px') computedPieces.push(`min-width: ${minW}`);
          const maxW = cs.maxWidth;
          if (maxW && maxW !== 'none' && maxW !== 'auto' && maxW !== '0px') {
            computedPieces.push(`max-width: ${maxW}`);
          }
        } catch (e) {}

        const styleParts = [];
        if (styleAttr) styleParts.push(styleAttr.replace(/;\s*$/, '').trim());
        if (computedPieces.length) styleParts.push(computedPieces.join('; '));
        const merged = styleParts.filter(Boolean).join('; ');
        if (merged) attrs += ` style="${merged}"`;

        return `<col${attrs}>`;
      }

      if (tag === 'caption') {
        let childrenHTML = '';
        for (const child of el.childNodes) {
          childrenHTML += cleanHTML(child);
        }
        return `<caption>${childrenHTML}</caption>`;
      }

      let childrenHTML = '';
      for (const child of el.childNodes) {
        childrenHTML += buildTableHTML(child);
      }
      return childrenHTML;
    }

    /** 部分课件右侧「幽灵列」裁剪（仅限 clone）。
     * 按「表格网格」识别列：有 colspan/rowspan 时用 DOM 子格下标当列会错位，导致幽灵列删不掉。
     * 自右向左若某网格列上出现的所有单元格均语义空，则整列视为幽灵列；再删格或减小 colspan。 */
    function trimTrailingGhostColumns(table) {
      if (!table || table.tagName.toLowerCase() !== 'table') return;
      const rows = Array.from(table.rows);
      if (!rows.length) return;

      function cellSemanticEmpty(c) {
        const raw = (c.innerText != null ? c.innerText : c.textContent) || '';
        const t = raw
          .replace(/[\u200b-\u200d\u2060-\u2064\u2066-\u2069\ufeff\u00ad\u034f]/g, '')
          .replace(/[\s\u00a0\u3000]+/g, '')
          .trim();
        if (t) return false;

        const imgs = c.querySelectorAll('img');
        for (const im of imgs) {
          let w = im.naturalWidth || 0;
          let h = im.naturalHeight || 0;
          if ((!w || !h) && (im.width || im.height)) {
            w = Number(im.width) || w;
            h = Number(im.height) || h;
          }
          if (!w) w = parseInt(im.getAttribute('width') || '0', 10) || 0;
          if (!h) h = parseInt(im.getAttribute('height') || '0', 10) || 0;
          if ((!w || !h) && im.getAttribute('src')) continue;
          if (!im.getAttribute('src')) return false;
          if (w > 24 || h > 24) return false;
        }

        const svgs = c.querySelectorAll('svg');
        for (let si = 0; si < svgs.length; si++) {
          const box = svgs[si].getBoundingClientRect();
          if (box.width > 36 || box.height > 36) return false;
        }

        if (c.querySelector('iframe,canvas,video,embed,picture')) return false;
        return true;
      }

      function buildTableGrid() {
        const grid = [];
        const cellMeta = new WeakMap();
        for (let r = 0; r < rows.length; r++) {
          if (!grid[r]) grid[r] = [];
          let c = 0;
          const row = rows[r];
          for (let i = 0; i < row.cells.length; i++) {
            const cell = row.cells[i];
            const rs = cell.rowSpan || 1;
            const cs = cell.colSpan || 1;
            while (grid[r][c]) c++;
            if (!cellMeta.has(cell)) {
              cellMeta.set(cell, { startCol: c, startRow: r, colSpan: cs, rowSpan: rs });
            }
            for (let dr = 0; dr < rs; dr++) {
              for (let dc = 0; dc < cs; dc++) {
                const rr = r + dr;
                if (!grid[rr]) grid[rr] = [];
                grid[rr][c + dc] = cell;
              }
            }
            c += cs;
          }
        }
        let colCount = 0;
        for (let r = 0; r < grid.length; r++) {
          if (!grid[r]) continue;
          for (let cc = 0; cc < grid[r].length; cc++) {
            if (grid[r][cc]) colCount = Math.max(colCount, cc + 1);
          }
        }
        return { grid, colCount, cellMeta };
      }

      const { grid, colCount, cellMeta } = buildTableGrid();
      if (colCount < 1) return;

      let trim = 0;
      for (let col = colCount - 1; col >= 0; col--) {
        const seen = new Set();
        for (let r = 0; r < rows.length; r++) {
          if (grid[r] && grid[r][col]) seen.add(grid[r][col]);
        }
        if (seen.size === 0) break;
        let allEmpty = true;
        for (const cell of seen) {
          if (!cellSemanticEmpty(cell)) {
            allEmpty = false;
            break;
          }
        }
        if (allEmpty) trim++;
        else break;
      }

      const newColCount = colCount - trim;
      if (trim === 0 || newColCount < 1) return;

      const toRemove = [];
      const toUpdate = [];
      const seenCell = new Set();
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        for (let i = 0; i < row.cells.length; i++) {
          const cell = row.cells[i];
          if (seenCell.has(cell)) continue;
          seenCell.add(cell);
          const meta = cellMeta.get(cell);
          if (!meta) continue;
          const cs = cell.colSpan || 1;
          const { startCol } = meta;
          const endCol = startCol + cs - 1;
          if (startCol >= newColCount) {
            toRemove.push(cell);
          } else if (endCol >= newColCount) {
            const newCs = newColCount - startCol;
            if (newCs < 1) toRemove.push(cell);
            else toUpdate.push({ cell, newCs });
          }
        }
      }

      for (const cell of toRemove) cell.remove();
      for (const { cell, newCs } of toUpdate) {
        if (!cell.parentNode) continue;
        if (newCs === 1) cell.removeAttribute('colspan');
        else cell.setAttribute('colspan', String(newCs));
      }
    }

    const clone = tableEl.cloneNode(true);
    trimTrailingGhostColumns(clone);
    return buildTableHTML(clone);
  }

  function cleanHTML(el) {
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1) return '';

    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'svg', 'button', 'input'].includes(tag)) return '';

    if (tag === 'img') {
      const src = el.getAttribute('src') || '';
      if (!src) return '';
      return `<img class="yitang-doc-img" src="${src}" alt="" loading="lazy" style="max-width:100%;height:auto;display:inline-block;vertical-align:top;box-sizing:border-box;">`;
    }

    let childrenHTML = '';
    for (const child of el.childNodes) {
      childrenHTML += cleanHTML(child);
    }

    if (tag === 'br') return '<br>';

    if (/^h[1-6]$/.test(tag)) {
      const style = mergeSpanAndBlockTypography(el);
      const inCell = !!(el.closest && (el.closest('td') || el.closest('th')));
      if (inCell) {
        if (style) return `<div style="${style}">${childrenHTML}</div>`;
        return childrenHTML;
      }
      if (style) return `<${tag} style="${style}">${childrenHTML}</${tag}>`;
      return `<${tag}>${childrenHTML}</${tag}>`;
    }

    if (tag === 'p' || tag === 'div') {
      const style = mergeSpanAndBlockTypography(el);
      const inCell = !!(el.closest && (el.closest('td') || el.closest('th')));
      if (inCell) {
        if (style) return `<div style="${style}">${childrenHTML}</div>`;
        return childrenHTML;
      }
      if (style) return `<${tag} style="${style}">${childrenHTML}</${tag}>`;
      return childrenHTML;
    }

    if (tag === 'span') {
      const style = getRenderedStyles(el);
      if (style) return `<span style="${style}">${childrenHTML}</span>`;
      return childrenHTML;
    }

    if (['strong', 'b'].includes(tag)) return `<strong>${childrenHTML}</strong>`;
    if (['em', 'i'].includes(tag)) return `<em>${childrenHTML}</em>`;
    if (tag === 'u') return `<u>${childrenHTML}</u>`;
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      return `<a href="${href}" target="_blank">${childrenHTML}</a>`;
    }

    if (tag === 'ul') return `<ul>${childrenHTML}</ul>`;
    if (tag === 'ol') return `<ol>${childrenHTML}</ol>`;
    if (tag === 'li') {
      const style = mergeSpanAndBlockTypography(el);
      if (style) return `<li style="${style}">${childrenHTML}</li>`;
      return `<li>${childrenHTML}</li>`;
    }

    return childrenHTML;
  }

  const items = container.querySelectorAll('div[role="listitem"]');
  const results = [];

  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom < -200 || rect.top > window.innerHeight + 200) continue;
    if (rect.height < 2) continue;

    const classMatch = item.className.match(/item-([A-Za-z0-9]+)/g);
    const itemId = classMatch ? classMatch.find(c => c.length > 10) || classMatch[0] : null;
    if (!itemId) continue;

    const block = item.querySelector('.block') || item;
    const blockClass = block.className || '';

    let type = 'text';
    let content = '';
    let imgSrc = '';
    let level = 0;

    if (blockClass.includes('image-block') || blockClass.includes('img-block')) {
      const allImgs = item.querySelectorAll('img[src]');
      if (allImgs.length > 1) {
        type = 'images';
        const srcs = [];
        allImgs.forEach(img => { if (img.src) srcs.push(img.src); });
        content = srcs.map(s => `<img src="${s}" alt="" loading="lazy" style="display: inline-block; vertical-align: top; margin: 4px; max-width: ${Math.floor(90 / srcs.length)}%;">`).join('');
      } else {
        type = 'image';
        const img = allImgs[0];
        if (img) imgSrc = img.src;
      }
    } else if (blockClass.includes('code-block') || blockClass.includes('codeblock')) {
      type = 'code';
      const codeEl = item.querySelector('code, pre, .code-content');
      content = codeEl ? codeEl.textContent : item.textContent;
    } else if (blockClass.includes('callout') || blockClass.includes('quote') || blockClass.includes('blockquote')) {
      type = 'quote';
      const aceLines = item.querySelectorAll('.ace-line');
      if (aceLines.length > 0) {
        content = Array.from(aceLines).map(l => cleanHTML(l)).join('<br>');
      } else {
        content = cleanHTML(item);
      }
    } else if (blockClass.includes('table') || item.querySelector('table')) {
      type = 'table';
      const table = item.querySelector('table');
      if (table) {
        content = processTable(table);
      }
    } else {
      // Text / heading / list
      const aceLines = item.querySelectorAll('.ace-line');
      if (aceLines.length > 0) {
        content = Array.from(aceLines).map(l => cleanHTML(l)).join('<br>');
      } else {
        content = cleanHTML(item);
      }

      // Detect heading
      const headingMatch = blockClass.match(/heading(\d)/i);
      if (headingMatch) {
        type = 'heading';
        level = parseInt(headingMatch[1]) || 1;
      } else {
        const firstSpan = item.querySelector('span[style*="font-size"]');
        if (firstSpan) {
          const fontSize = parseInt(getComputedStyle(firstSpan).fontSize);
          if (fontSize >= 28) { type = 'heading'; level = 1; }
          else if (fontSize >= 24) { type = 'heading'; level = 2; }
          else if (fontSize >= 20) { type = 'heading'; level = 3; }
        }
        const boldEl = item.querySelector('[style*="font-weight: 700"], [style*="font-weight:700"], b, strong');
        const plainText = item.textContent?.trim() || '';
        if (boldEl && plainText.length < 50 && !plainText.includes('\n') && plainText.length > 0) {
          const fontSize = parseInt(getComputedStyle(boldEl).fontSize);
          if (fontSize >= 20 && type !== 'heading') { type = 'heading'; level = 3; }
        }
      }

      // Detect ordered vs unordered list
      if (blockClass.includes('list') || blockClass.includes('bullet') || blockClass.includes('ordered')) {
        if (blockClass.includes('ordered') || blockClass.includes('number')) {
          type = 'ol';
        } else {
          type = 'ul';
        }
        // Try to get the list number from the rendered content
        const numEl = item.querySelector('.list-block-number, .ordered-list-number, [class*="number"]');
        if (numEl) {
          type = 'ol';
        }
      }

      // Check for inline images in text blocks
      const inlineImgs = item.querySelectorAll('img[src]');
      if (inlineImgs.length > 1 && !content.replace(/<[^>]+>/g, '').trim()) {
        type = 'images';
        const srcs = [];
        inlineImgs.forEach(img => { if (img.src) srcs.push(img.src); });
        content = srcs.map(s => `<img src="${s}" alt="" loading="lazy" style="display: inline-block; vertical-align: top; margin: 4px; max-width: ${Math.floor(90 / srcs.length)}%;">`).join('');
      } else if (inlineImgs.length === 1 && !content.replace(/<[^>]+>/g, '').trim()) {
        type = 'image';
        imgSrc = inlineImgs[0].src;
      }
    }

    if (type === 'images') { /* multi-image, content already set */ }
    else if (type !== 'image' && !content.replace(/<[^>]+>/g, '').trim()) continue;
    else if (type === 'image' && !imgSrc) continue;

    // Capture container visual styles
    let containerStyle = '';
    const blockEl = item.querySelector('.block') || item;
    const contentWrap = blockEl.querySelector('[class*="content"]') || blockEl;
    const bcs = getComputedStyle(contentWrap);
    const cStyles = [];

    const cbg = bcs.backgroundColor;
    if (cbg && cbg !== 'rgba(0, 0, 0, 0)' && cbg !== 'transparent' && cbg !== 'rgb(255, 255, 255)') {
      cStyles.push(`background-color: ${cbg}`);
    }
    const cborder = bcs.border;
    const cbl = bcs.borderLeft;
    if (cbl && !cbl.includes('0px') && cbl !== 'none') {
      cStyles.push(`border-left: ${cbl}`);
    }
    const cbr = bcs.borderRadius;
    if (cbr && cbr !== '0px') {
      cStyles.push(`border-radius: ${cbr}`);
    }
    const cbs = bcs.boxShadow;
    if (cbs && cbs !== 'none') {
      cStyles.push(`box-shadow: ${cbs}`);
    }
    const cpad = bcs.padding;
    if (cpad && cpad !== '0px') {
      cStyles.push(`padding: ${cpad}`);
    }
    const cta = bcs.textAlign;
    if (cta && cta !== 'start' && cta !== 'left') {
      cStyles.push(`text-align: ${cta}`);
    }

    if (cStyles.length) containerStyle = cStyles.join('; ');

    results.push({ itemId, type, content, imgSrc, level, containerStyle });
  }

  return results;
}

async function scrollAndExtract(page) {
  const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const stepSize = Math.floor(viewportHeight * 0.5);

  console.log(`  页面总高度: ${totalHeight}px, 步长: ${stepSize}px`);

  const allBlocks = new Map();
  let step = 0;

  for (let scrollY = 0; scrollY < totalHeight; scrollY += stepSize) {
    await page.evaluate(y => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(350);

    const blocks = await page.evaluate(extractBlockContent);

    let cutAt = blocks.length;
    for (let i = 0; i < blocks.length; i++) {
      if (matchesYitangActivityHeader(blocks[i])) {
        cutAt = i;
        break;
      }
    }

    for (let i = 0; i < cutAt; i++) {
      const block = blocks[i];
      if (!allBlocks.has(block.itemId)) allBlocks.set(block.itemId, block);
    }

    if (cutAt < blocks.length) {
      const pct = Math.min(100, Math.round((scrollY / totalHeight) * 100));
      console.log(`  ℹ 检测到文末「一堂活动信息」起始块，停止继续向下滚动（约 ${pct}%）`);
      break;
    }

    step++;
    if (step % 15 === 0) {
      console.log(`  进度: ${Math.min(100, Math.round(scrollY / totalHeight * 100))}% (${allBlocks.size} 块)`);
    }
  }

  let blockArray = [...allBlocks.values()];
  const nBeforeTrim = blockArray.length;
  blockArray = sliceBeforeYitangActivitySection(blockArray);
  if (blockArray.length < nBeforeTrim) {
    console.log(`  ℹ 已忽略文末「一堂活动信息」起 ${nBeforeTrim - blockArray.length} 个内容块`);
  }

  const imageUrls = collectImageUrlsFromBlocks(blockArray);
  console.log(`  ✓ 采集完成: ${blockArray.length} 个内容块, ${imageUrls.length} 张图片`);
  return { blocks: blockArray, imageUrls };
}

async function downloadImages(page, imageUrls, imgDir) {
  console.log(`  下载 ${imageUrls.length} 张图片...`);
  const imgMap = {};
  let success = 0, fail = 0;

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const ext = (url.match(/\.(jpg|jpeg|png|gif|webp|svg)/i) || [, 'png'])[1];
    const filename = `img_${String(i).padStart(3, '0')}.${ext}`;
    const destPath = path.join(imgDir, filename);

    try {
      const base64 = await page.evaluate(async (imgUrl) => {
        const resp = await fetch(imgUrl);
        const blob = await resp.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, url);

      const matches = base64.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        fs.writeFileSync(destPath, Buffer.from(matches[2], 'base64'));
        imgMap[url] = `images/${filename}`;
        success++;
      }
    } catch (e) { fail++; }

    if ((i + 1) % 30 === 0) console.log(`    ${i + 1}/${imageUrls.length}`);
  }

  console.log(`  ✓ 图片: ${success} 成功, ${fail} 失败`);
  return imgMap;
}

function buildCleanHTML(blocks, imgMap, docTitle) {
  const lines = [];

  function replaceImgUrls(html) {
    let result = html;
    for (const [url, localPath] of Object.entries(imgMap)) {
      result = result.split(url).join(localPath);
    }
    return result;
  }

  for (const block of blocks) {
    const content = replaceImgUrls(block.content);
    const cs = block.containerStyle;
    const wrapOpen = cs ? `<div style="${cs}">` : '';
    const wrapClose = cs ? '</div>' : '';

    let inner = '';
    switch (block.type) {
      case 'heading': {
        const tag = `h${Math.min(6, Math.max(1, block.level || 2))}`;
        inner = `<${tag}>${content}</${tag}>`;
        break;
      }
      case 'image': {
        const src = imgMap[block.imgSrc] || block.imgSrc;
        inner = `<figure><img src="${escapeAttr(src)}" alt="" loading="lazy"></figure>`;
        break;
      }
      case 'images': {
        inner = `<figure>${content}</figure>`;
        break;
      }
      case 'code':
        inner = `<pre><code>${escapeHtml(block.content)}</code></pre>`;
        break;
      case 'quote':
        inner = `<blockquote>${content}</blockquote>`;
        break;
      case 'table':
        inner = content;
        break;
      case 'ol':
        inner = `<ol><li>${content}</li></ol>`;
        break;
      case 'ul':
        inner = `<ul><li>${content}</li></ul>`;
        break;
      default:
        inner = `<p>${content}</p>`;
        break;
    }

    lines.push(cs ? `${wrapOpen}${inner}${wrapClose}` : inner);
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(docTitle || '页面内容保存')}</title>
  <style>
    body {
      max-width: 800px; margin: 40px auto; padding: 0 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 16px; line-height: 1.8; color: #333; background: #fff;
    }
    h1 { font-size: 28px; margin: 2em 0 0.5em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
    h2 { font-size: 22px; margin: 1.8em 0 0.5em; }
    h3 { font-size: 19px; margin: 1.5em 0 0.5em; }
    h4, h5, h6 { font-size: 17px; margin: 1.2em 0 0.5em; }
    p { margin: 0.8em 0; }
    figure { margin: 1.5em 0; text-align: center; }
    img { max-width: 100%; height: auto; border-radius: 4px; }
    pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; font-size: 14px; line-height: 1.5; }
    code { font-family: "Fira Code", Consolas, monospace; }
    blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding: 0.5em 1em; color: #555; background: #fafafa; border-radius: 0 4px 4px 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    td, th { border: 1px solid #ddd; padding: 8px 12px; }
    th { background: #f5f5f5; font-weight: 600; }
    ul, ol { margin: 0.5em 0; padding-left: 2em; }
    li { margin: 0.3em 0; }
  </style>
</head>
<body>
${lines.join('\n')}
</body>
</html>`;
}

function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

(async () => {
  if (fs.existsSync(SIGNAL_FILE)) fs.unlinkSync(SIGNAL_FILE);

  console.log('正在启动浏览器...');
  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-web-security', '--no-sandbox'],
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN'
  });

  const page = browser.pages()[0] || await browser.newPage();
  console.log('正在打开页面...');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 120000 });

  const docTitle = await getDocumentTitle(page);
  console.log('YITANG_DOC_TITLE: ' + JSON.stringify(docTitle));

  let outputName = OUTPUT_NAME_ARG;
  if (OUTPUT_NAME_ARG === FROM_TITLE_SENTINEL) {
    outputName = sanitizeForDir(docTitle);
    if (!outputName) {
      console.error('无法从页面得到可用于目录名的标题，请关闭浏览器后改用显式输出目录名重新运行。');
      await browser.close();
      process.exit(1);
    }
  }

  const OUTPUT_DIR = path.join(process.cwd(), outputName);
  console.log('YITANG_OUTPUT_DIR: ' + JSON.stringify(OUTPUT_DIR));
  const IMG_DIR = path.join(OUTPUT_DIR, 'images');
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

  console.log('页面已打开。请确认内容与标题无误后，再触发保存（GO 信号）。\n');

  await waitForSignalFile();

  console.log('步骤 1/3: 逐屏滚动 + 提取内容块...');
  const { blocks, imageUrls } = await scrollAndExtract(page);

  console.log('\n步骤 2/3: 下载图片...');
  const imgMap = await downloadImages(page, imageUrls, IMG_DIR);

  console.log('\n步骤 3/4: 生成基础 HTML...');
  function stripTags(s) {
    return (s || '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\u200b/g, '')
      .trim();
  }
  const firstBlock = blocks[0];
  const firstHeadingText = firstBlock && firstBlock.type === 'heading' ? stripTags(firstBlock.content) : '';
  const docTitleBanner = docTitle && firstHeadingText !== docTitle
    ? `<header class="saved-doc-heading"><h1 class="saved-doc-title">${escapeHtml(docTitle)}</h1></header>\n`
    : '';

  let html = buildCleanHTML(blocks, imgMap, docTitle);

  // === Inline postprocess ===
  console.log('\n步骤 4/4: 后处理（目录 + Markdown）...');

  // Add IDs to headings and build TOC
  const toc = [];
  let hCounter = 0;
  html = html.replace(/<(h[1-6])>([\s\S]*?)<\/\1>/g, (match, tag, inner) => {
    hCounter++;
    const id = `section-${hCounter}`;
    const level = parseInt(tag[1]);
    const text = inner.replace(/<[^>]+>/g, '').replace(/\u200b/g, '').replace(/&#8203;/g, '').trim();
    if (text) toc.push({ id, level, text });
    return `<${tag} id="${id}">${inner}</${tag}>`;
  });
  console.log(`  标题: ${toc.length} 个`);

  // Build TOC HTML
  let tocHtml = '<nav id="sidebar-toc">\n<div class="toc-title">目录</div>\n<ul>\n';
  for (const t of toc) {
    const cls = t.level === 1 ? 'toc-h1' : t.level === 2 ? 'toc-h2' : 'toc-h3';
    tocHtml += `  <li class="${cls}"><a href="#${t.id}">${t.text.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</a></li>\n`;
  }
  tocHtml += '</ul>\n</nav>\n';

  // Replace style block
  const sidebarStyle = `
  <style>
    * { box-sizing: border-box; }
    html { scroll-behavior: auto; }
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.8; color: #333; background: #fff; display: flex; }
    #sidebar-toc { position: fixed; left: 0; top: 0; bottom: 0; width: 280px; padding: 20px 0; background: #f8f9fa; border-right: 1px solid #e5e7eb; overflow-y: auto; z-index: 100; }
    #sidebar-toc .toc-title { font-size: 18px; font-weight: 700; padding: 10px 20px 15px; color: #111; border-bottom: 1px solid #e5e7eb; margin-bottom: 8px; }
    #sidebar-toc ul { list-style: none; margin: 0; padding: 0; }
    #sidebar-toc li a { display: block; padding: 5px 20px; color: #555; text-decoration: none; font-size: 14px; line-height: 1.5; border-left: 3px solid transparent; transition: all 0.2s; }
    #sidebar-toc li a:hover { color: #1a73e8; background: #e8f0fe; border-left-color: #1a73e8; }
    #sidebar-toc li.toc-h1 a { font-weight: 600; padding-left: 20px; }
    #sidebar-toc li.toc-h2 a { padding-left: 36px; }
    #sidebar-toc li.toc-h3 a { padding-left: 52px; font-size: 13px; color: #777; }
    #sidebar-toc li.active a { color: #1a73e8; background: #e8f0fe; border-left-color: #1a73e8; font-weight: 600; }
    #main-content { margin-left: 340px; max-width: 800px; padding: 40px 60px; }
    .saved-doc-heading { margin: 0 0 2em; }
    .saved-doc-heading .saved-doc-title { font-size: 28px; margin: 0 0 0.5em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
    h1 { font-size: 28px; margin: 2em 0 0.5em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
    h2 { font-size: 22px; margin: 1.8em 0 0.5em; }
    h3 { font-size: 19px; margin: 1.5em 0 0.5em; }
    h4, h5, h6 { font-size: 17px; margin: 1.2em 0 0.5em; }
    p { margin: 0.8em 0; }
    figure { margin: 1.5em 0; text-align: center; }
    img { max-width: 100%; height: auto; border-radius: 4px; }
    pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; font-size: 14px; line-height: 1.5; }
    code { font-family: "Fira Code", Consolas, monospace; }
    blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding: 0.5em 1em; color: #555; background: #fafafa; border-radius: 0 4px 4px 0; }
    .table-wrapper { overflow-x: auto; margin: 1em 0; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ddd; padding: 8px 12px; word-wrap: break-word; overflow-wrap: anywhere; }
    th { background: #f5f5f5; font-weight: 600; }
    td img, th img { max-width: 100%; height: auto; vertical-align: top; }
    #main-content .table-wrapper td .yitang-td-img-row,
    #main-content .table-wrapper th .yitang-td-img-row {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: flex-start;
      justify-content: flex-start;
      gap: 8px;
      max-width: 100%;
      min-width: 0;
      vertical-align: top;
    }
    #main-content .table-wrapper td .yitang-td-img-row img,
    #main-content .table-wrapper th .yitang-td-img-row img {
      flex: 1 1 0;
      min-width: 0;
      width: auto;
      max-width: none;
      height: auto;
      object-fit: contain;
      box-sizing: border-box;
    }
    ul, ol { margin: 0.5em 0; padding-left: 2em; }
    li { margin: 0.3em 0; }
    @media (max-width: 900px) { #sidebar-toc { display: none; } #main-content { margin-left: 0; padding: 20px; } }
    /* 正文内图片点击放大预览（底部工具栏：分页 / 缩放 / 1:1 / 适应，舞台区滚轮滚动） */
    #main-content img { cursor: zoom-in; }
    #yitang-img-lightbox {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: none;
      flex-direction: column;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.88);
    }
    #yitang-img-lightbox.is-open { display: flex; }
    .yitang-lightbox-close {
      position: fixed;
      top: 12px;
      right: 16px;
      z-index: 10003;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      font-size: 26px;
      line-height: 44px;
      cursor: pointer;
    }
    .yitang-lightbox-close:hover { background: rgba(255, 255, 255, 0.28); }
    #yitang-lightbox-stage {
      position: relative;
      z-index: 1;
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 52px 16px 96px;
      -webkit-overflow-scrolling: touch;
    }
    #yitang-lightbox-inner {
      flex-shrink: 0;
      line-height: 0;
      transform-origin: center center;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.45);
      border-radius: 4px;
      overflow: hidden;
    }
    #yitang-img-lightbox-img {
      display: block;
      max-width: none;
      height: auto;
      vertical-align: top;
      cursor: default;
      user-select: none;
    }
    .yitang-lb-toolbar {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10002;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 8px 14px;
      max-width: calc(100vw - 32px);
      border-radius: 999px;
      background: rgba(36, 36, 38, 0.94);
      color: #fff;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
      pointer-events: auto;
    }
    .yitang-lb-toolbar button {
      margin: 0;
      padding: 6px 10px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #fff;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    .yitang-lb-toolbar button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
    .yitang-lb-toolbar button:disabled { opacity: 0.35; cursor: default; }
    .yitang-lb-toolbar .yitang-lb-counter { min-width: 4.5em; text-align: center; font-variant-numeric: tabular-nums; }
    .yitang-lb-toolbar .yitang-lb-zoom-pct { min-width: 3.2em; text-align: center; font-variant-numeric: tabular-nums; }
    .yitang-lb-toolbar .yitang-lb-sep {
      width: 1px;
      height: 18px;
      margin: 0 4px;
      background: rgba(255, 255, 255, 0.25);
    }
    .yitang-lb-toolbar .yitang-lb-label-btn {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 6px 12px;
    }
  </style>`;

  const scrollScript = [
    '<script>',
    '(function() {',
    '  var hs = document.querySelectorAll("#main-content h1, #main-content h2, #main-content h3");',
    '  var ls = document.querySelectorAll("#sidebar-toc li");',
    '  if (!hs.length || !ls.length) return;',
    '  function update() {',
    '    var cur = "";',
    '    for (var h of hs) { if (h.getBoundingClientRect().top <= 120) cur = h.id; }',
    '    ls.forEach(function(li) {',
    '      var a = li.querySelector("a");',
    '      if (a && a.getAttribute("href") === "#" + cur) { li.classList.add("active"); li.scrollIntoView({ block: "nearest" }); }',
    '      else { li.classList.remove("active"); }',
    '    });',
    '  }',
    '  window.addEventListener("scroll", update, { passive: true });',
    '  update();',
    '})();',
    '</script>'
  ].join('\n');

  const imageLightboxFragment = [
    '<div id="yitang-img-lightbox" role="dialog" aria-modal="true" aria-label="图片预览">',
    '  <button type="button" class="yitang-lightbox-close" aria-label="关闭">&times;</button>',
    '  <div id="yitang-lightbox-stage">',
    '    <div id="yitang-lightbox-inner"><img id="yitang-img-lightbox-img" alt="" draggable="false"></div>',
    '  </div>',
    '  <div class="yitang-lb-toolbar" id="yitang-lb-toolbar">',
    '    <button type="button" class="yitang-lb-prev" aria-label="上一张">&#8249;</button>',
    '    <span class="yitang-lb-counter" aria-live="polite">0 / 0</span>',
    '    <button type="button" class="yitang-lb-next" aria-label="下一张">&#8250;</button>',
    '    <span class="yitang-lb-sep" aria-hidden="true"></span>',
    '    <button type="button" class="yitang-lb-zoom-out" aria-label="缩小">&#8722;</button>',
    '    <span class="yitang-lb-zoom-pct">100%</span>',
    '    <button type="button" class="yitang-lb-zoom-in" aria-label="放大">+</button>',
    '    <span class="yitang-lb-sep" aria-hidden="true"></span>',
    '    <button type="button" class="yitang-lb-fit yitang-lb-label-btn" title="适应窗口">适应</button>',
    '    <button type="button" class="yitang-lb-actual yitang-lb-label-btn" title="实际像素 1:1">1:1</button>',
    '  </div>',
    '</div>',
    '<script>',
    '(function(){',
    '  var lb=document.getElementById("yitang-img-lightbox");',
    '  var stage=document.getElementById("yitang-lightbox-stage");',
    '  var inner=document.getElementById("yitang-lightbox-inner");',
    '  var lbi=document.getElementById("yitang-img-lightbox-img");',
    '  var tb=document.getElementById("yitang-lb-toolbar");',
    '  var mc=document.getElementById("main-content");',
    '  if(!lb||!stage||!inner||!lbi||!mc)return;',
    '  var imgs=[];',
    '  var idx=0;',
    '  var scale=1;',
    '  var rotation=0;',
    '  var minScale=0.05;',
    '  var maxScale=12;',
    '  function $(sel,root){return (root||document).querySelector(sel);}',
    '  function refreshImgList(){imgs=Array.prototype.slice.call(mc.querySelectorAll("img"));}',
    '  function fitScale(){',
    '    var nw=lbi.naturalWidth,nh=lbi.naturalHeight;',
    '    if(!nw||!nh)return 1;',
    '    var pad=32;',
    '    var aw=Math.max(120,stage.clientWidth-pad);',
    '    var ah=Math.max(120,stage.clientHeight-pad);',
    '    var s=Math.min(aw/nw,ah/nh);',
    '    return Math.max(minScale,Math.min(maxScale,s));',
    '  }',
    '  function applyView(){',
    '    var nw=lbi.naturalWidth,nh=lbi.naturalHeight;',
    '    if(!nw||!nh)return;',
    '    var w=nw*scale;',
    '    lbi.style.width=w+"px";',
    '    lbi.style.height="auto";',
    '    inner.style.transform="rotate("+rotation+"deg)";',
    '    var pct=$(".yitang-lb-zoom-pct",lb);',
    '    if(pct)pct.textContent=Math.round(scale*100)+"%";',
    '  }',
    '  function centerScroll(){',
    '    try{',
    '      var sl=(stage.scrollWidth-stage.clientWidth)/2;',
    '      if(sl>0)stage.scrollLeft=sl;',
    '    }catch(x){}',
    '  }',
    '  function runAfterLayout(fn){',
    '    requestAnimationFrame(function(){requestAnimationFrame(fn);});',
    '  }',
    '  function afterImageReady(){',
    '    applyView();',
    '    runAfterLayout(function(){',
    '      applyView();',
    '      stage.scrollTop=0;',
    '      centerScroll();',
    '    });',
    '  }',
    '  function setFromIndex(i){',
    '    refreshImgList();',
    '    if(!imgs.length)return;',
    '    idx=Math.max(0,Math.min(i,imgs.length-1));',
    '    rotation=0;',
    '    var img=imgs[idx];',
    '    var src=img.currentSrc||img.src;',
    '    var alt=img.getAttribute("alt")||"";',
    '    var readyDone=false;',
    '    function onReady(){',
    '      if(readyDone)return;',
    '      readyDone=true;',
    '      lbi.onload=null;',
    '      scale=fitScale();',
    '      afterImageReady();',
    '      updateNav();',
    '    }',
    '    lbi.onload=function(){onReady();};',
    '    lbi.onerror=function(){updateNav();};',
    '    lbi.src=src;',
    '    lbi.alt=alt;',
    '    if(lbi.complete&&lbi.naturalWidth)onReady();',
    '    else updateNav();',
    '  }',
    '  function updateNav(){',
    '    refreshImgList();',
    '    var c=$(".yitang-lb-counter",lb);',
    '    var prev=$(".yitang-lb-prev",lb);',
    '    var next=$(".yitang-lb-next",lb);',
    '    if(c)c.textContent=(idx+1)+" / "+imgs.length;',
    '    if(prev)prev.disabled=idx<=0;',
    '    if(next)next.disabled=idx>=imgs.length-1;',
    '  }',
    '  function openFromThumb(thumb){',
    '    refreshImgList();',
    '    var i=imgs.indexOf(thumb);',
    '    if(i<0)return;',
    '    lb.classList.add("is-open");',
    '    document.body.style.overflow="hidden";',
    '    setFromIndex(i);',
    '  }',
    '  function closeLb(){',
    '    lb.classList.remove("is-open");',
    '    lbi.removeAttribute("src");',
    '    lbi.onload=null;',
    '    lbi.onerror=null;',
    '    document.body.style.overflow="";',
    '  }',
    '  mc.addEventListener("click",function(e){',
    '    var t=e.target;',
    '    if(t.tagName!=="IMG")return;',
    '    e.preventDefault();',
    '    e.stopPropagation();',
    '    openFromThumb(t);',
    '  });',
    '  if(tb){',
    '    tb.addEventListener("click",function(e){e.stopPropagation();});',
    '    $(".yitang-lb-prev",lb).addEventListener("click",function(){if(idx>0)setFromIndex(idx-1);});',
    '    $(".yitang-lb-next",lb).addEventListener("click",function(){if(idx<imgs.length-1)setFromIndex(idx+1);});',
    '    $(".yitang-lb-zoom-out",lb).addEventListener("click",function(){',
    '      scale=Math.max(minScale,scale/1.12);applyView();',
    '    });',
    '    $(".yitang-lb-zoom-in",lb).addEventListener("click",function(){',
    '      scale=Math.min(maxScale,scale*1.12);applyView();',
    '    });',
    '    $(".yitang-lb-fit",lb).addEventListener("click",function(){rotation=0;scale=fitScale();applyView();runAfterLayout(function(){applyView();centerScroll();});});',
    '    $(".yitang-lb-actual",lb).addEventListener("click",function(){rotation=0;scale=1;applyView();centerScroll();});',
    '  }',
    '  stage.addEventListener("click",function(e){if(e.target===stage)closeLb();});',
    '  lb.addEventListener("click",function(e){if(e.target===lb)closeLb();});',
    '  $(".yitang-lightbox-close",lb).addEventListener("click",function(e){e.stopPropagation();closeLb();});',
    '  document.addEventListener("keydown",function(e){',
    '    if(!lb.classList.contains("is-open"))return;',
    '    if(e.key==="Escape"){e.preventDefault();closeLb();return;}',
    '    if(e.key==="ArrowLeft"&&idx>0){e.preventDefault();setFromIndex(idx-1);}',
    '    if(e.key==="ArrowRight"&&idx<imgs.length-1){e.preventDefault();setFromIndex(idx+1);}',
    '  });',
    '  window.addEventListener("resize",function(){',
    '    if(!lb.classList.contains("is-open")||!lbi.naturalWidth)return;',
    '    applyView();',
    '    centerScroll();',
    '  });',
    '  stage.addEventListener("wheel",function(e){',
    '    if(!lb.classList.contains("is-open"))return;',
    '    if(e.ctrlKey){',
    '      e.preventDefault();',
    '      var z=e.deltaY<0?1.08:1/1.08;',
    '      scale=Math.max(minScale,Math.min(maxScale,scale*z));applyView();',
    '    }',
    '  },{passive:false});',
    '})();',
    '</script>'
  ].join('\n');

  html = html.replace(/<style>[\s\S]*?<\/style>/, sidebarStyle);
  html = html.replace('<body>', '<body>\n' + tocHtml + '\n<div id="main-content">' + docTitleBanner);
  html = html.replace('</body>', '</div>\n' + scrollScript + '\n' + imageLightboxFragment + '\n</body>');

  // Merge consecutive lists
  html = html.replace(/<\/ol>\n<ol>/g, '');
  html = html.replace(/<\/ul>\n<ul>/g, '');

  // Wrap tables
  html = html.replace(/<table/g, '<div class="table-wrapper"><table');
  html = html.replace(/<\/table>/g, '</table></div>');

  const finalPath = path.join(OUTPUT_DIR, 'page_final.html');
  fs.writeFileSync(finalPath, html, 'utf-8');
  console.log(`  ✓ HTML: ${finalPath} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);

  // === Generate Markdown ===
  let md = '';
  if (docTitle && firstHeadingText !== docTitle) md += '# ' + docTitle + '\n\n';
  for (const block of blocks) {
    const plainText = (block.content || '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/?(strong|b)>/g, '**')
      .replace(/<\/?(em|i)>/g, '*')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g, '[$2]($1)')
      .replace(/<[^>]+>/g, '')
      .replace(/\u200b/g, '')
      .trim();

    switch (block.type) {
      case 'heading': {
        const prefix = '#'.repeat(Math.min(6, Math.max(1, block.level || 2)));
        md += '\n' + prefix + ' ' + plainText + '\n\n';
        break;
      }
      case 'image': {
        const src = imgMap[block.imgSrc] || block.imgSrc;
        md += '![](' + src + ')\n\n';
        break;
      }
      case 'images': {
        const srcMatches = (block.content || '').match(/src="([^"]+)"/g) || [];
        for (const m of srcMatches) {
          let url = m.replace('src="', '').replace('"', '');
          url = imgMap[url] || url;
          md += '![](' + url + ') ';
        }
        md += '\n\n';
        break;
      }
      case 'code':
        md += '```\n' + plainText + '\n```\n\n';
        break;
      case 'quote':
        md += plainText.split('\n').map(function(l) { return '> ' + l; }).join('\n') + '\n\n';
        break;
      case 'table':
        md += plainText + '\n\n';
        break;
      case 'ol':
        md += '1. ' + plainText + '\n';
        break;
      case 'ul':
        md += '- ' + plainText + '\n';
        break;
      default:
        if (plainText) md += plainText + '\n\n';
        break;
    }
  }
  const mdPath = path.join(OUTPUT_DIR, 'page.md');
  fs.writeFileSync(mdPath, md.trim(), 'utf-8');
  console.log('  ✓ Markdown: ' + mdPath + ' (' + (Buffer.byteLength(md) / 1024).toFixed(0) + ' KB)');

  console.log('\n===== 全部完成！=====');
  console.log('内容块: ' + blocks.length + ', 图片: ' + Object.keys(imgMap).length);

  console.log('\n（约 8 秒后自动关闭浏览器窗口；勿手动关，以免误以为保存失败。）');
  await page.waitForTimeout(8000);
  await browser.close();
})();
