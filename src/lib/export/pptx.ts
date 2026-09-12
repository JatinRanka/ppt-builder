/**
 * PPTX EXPORT — real, editable PowerPoint.
 *
 * This is where the flat block schema pays off: each block type maps directly
 * onto a PptxGenJS primitive (bullets -> text with bullet:true, table ->
 * addTable, chart -> addChart NATIVE chart, image -> addImage). Had the schema
 * stored HTML or markdown body content, this mapping would be intractable —
 * you cannot turn a <ul> string into PowerPoint shapes without writing a
 * parser.
 *
 * Charts export as NATIVE PowerPoint charts (editable in PowerPoint), not
 * images, because the schema kept series/categories as structured data.
 *
 * Coordinates are in inches on a 13.33x7.5 (16:9) canvas, mirroring the
 * 1280x720 logical slide so exported layout matches the editor.
 */
import PptxGenJS from 'pptxgenjs';
import { IMAGE_FETCH_TIMEOUT_MS } from '@/lib/agent/limits';
import { isAllowedImageUrl } from '@/lib/safeUrl';
import type { Block, Deck, Slide } from '@/lib/schema/deck';
import { getTheme } from '@/lib/themes';

/** Per-image ceiling; a huge response would bloat the file and memory. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const W = 13.333;
const H = 7.5;

export async function deckToPptx(deck: Deck): Promise<Buffer> {
  const pptx = new PptxGenJS();
  const theme = getTheme(deck.theme);

  // PRE-FETCH IMAGES OURSELVES.
  //
  // addImage({path}) makes PptxGenJS fetch the url during write() with NO
  // timeout — an unreachable host hangs the export indefinitely (reproduced:
  // a request to a dead port never returned, holding the route open past 30s).
  // Fetching here with an AbortController bounds it, and a failed image
  // degrades to a placeholder instead of taking the whole deck down.
  const imageData = await resolveImages(deck);

  pptx.defineLayout({ name: 'DECK16x9', width: W, height: H });
  pptx.layout = 'DECK16x9';
  pptx.title = deck.title;

  for (const slide of deck.slides) {
    addSlide(pptx, slide, theme, imageData);
  }

  // 'nodebuffer' returns a Buffer suitable for a Response body.
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

function addSlide(
  pptx: PptxGenJS,
  slide: Slide,
  theme: ReturnType<typeof getTheme>,
  imageData: Map<string, string>
) {
  const s = pptx.addSlide();
  s.background = { color: theme.pptx.bg };
  if (slide.speakerNotes) s.addNotes(slide.speakerNotes);

  const isTitleish = slide.kind === 'title' || slide.kind === 'section';
  const centered = slide.layout.align === 'center';
  const pad = 0.75;

  // Accent bar, matching the on-screen slide.
  if (!isTitleish) {
    s.addShape('rect', {
      x: 0, y: 0, w: 1.9, h: 0.07,
      fill: { color: theme.pptx.accent }, line: { color: theme.pptx.accent },
    });
  }

  // --- Title ---
  const titleY = isTitleish ? H / 2 - 1.1 : pad * 0.75;
  s.addText(slide.title, {
    x: pad, y: titleY, w: W - pad * 2, h: isTitleish ? 1.1 : 0.9,
    fontSize: isTitleish ? 40 : 30,
    bold: true,
    color: theme.pptx.title,
    align: centered ? 'center' : 'left',
    valign: 'middle',
  });

  if (slide.subtitle) {
    s.addText(slide.subtitle, {
      x: pad, y: titleY + (isTitleish ? 1.15 : 0.85), w: W - pad * 2, h: 0.6,
      fontSize: 17, color: theme.pptx.body,
      align: centered ? 'center' : 'left',
    });
  }

  // Title/section slides normally carry no body, but the model sometimes
  // attaches content. Dropping it here would make the export disagree with
  // what the user sees on screen, so render it in the lower half instead.
  if (isTitleish && slide.blocks.length === 0) return;

  // --- Body: split by slot, mirroring the on-screen two-column layouts ---
  const main = slide.blocks.filter((b) => b.slot === 'main');
  const aside = slide.blocks.filter((b) => b.slot === 'aside');
  const bodyY = isTitleish ? H / 2 + 0.35 : pad * 0.75 + 1.05;
  const bodyH = H - bodyY - pad * 0.7;
  const twoCol = aside.length > 0;
  const gutter = 0.4;
  const colW = twoCol ? (W - pad * 2 - gutter) / 2 : W - pad * 2;

  layoutColumn(s, main, pad, bodyY, colW, bodyH, theme, imageData);
  if (twoCol) layoutColumn(s, aside, pad + colW + gutter, bodyY, colW, bodyH, theme, imageData);
}

/** Stack blocks vertically in a column, giving each a share of the height. */
function layoutColumn(
  s: PptxGenJS.Slide,
  blocks: Block[],
  x: number,
  y: number,
  w: number,
  h: number,
  theme: ReturnType<typeof getTheme>,
  imageData: Map<string, string>
) {
  if (!blocks.length) return;
  // Charts, images, and tables want most of the space; text blocks are sized
  // by their content, so weight them differently.
  const weights = blocks.map((b) =>
    b.type === 'chart' || b.type === 'image' || b.type === 'table' ? 3 : 1
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const gap = 0.18;
  const available = h - gap * (blocks.length - 1);

  let cursor = y;
  blocks.forEach((block, i) => {
    const bh = (available * weights[i]) / totalWeight;
    addBlock(s, block, x, cursor, w, bh, theme, imageData);
    cursor += bh + gap;
  });
}

function addBlock(
  s: PptxGenJS.Slide,
  block: Block,
  x: number,
  y: number,
  w: number,
  h: number,
  theme: ReturnType<typeof getTheme>,
  imageData: Map<string, string>
) {
  switch (block.type) {
    case 'heading':
      s.addText(block.text, {
        x, y, w, h: Math.min(h, 0.5),
        fontSize: block.level === 2 ? 22 : 18, bold: true, color: theme.pptx.title,
      });
      break;

    case 'paragraph':
      s.addText(block.text, {
        x, y, w, h,
        fontSize: 15, color: theme.pptx.body, valign: 'top',
      });
      break;

    case 'bullets':
      // Native PowerPoint bullets, so they stay editable as a list.
      s.addText(
        block.items.map((t) => ({
          text: t,
          options: { bullet: block.ordered ? { type: 'number' as const } : true },
        })),
        { x, y, w, h, fontSize: 15, color: theme.pptx.body, valign: 'top', lineSpacingMultiple: 1.3 }
      );
      break;

    case 'quote':
      s.addText(
        [
          { text: block.text, options: { italic: true, fontSize: 19, color: theme.pptx.title } },
          ...(block.attribution
            ? [{ text: `\n— ${block.attribution}`, options: { fontSize: 13, color: theme.pptx.body } }]
            : []),
        ],
        { x: x + 0.15, y, w: w - 0.15, h, valign: 'middle' }
      );
      // Accent rule on the left, matching the on-screen blockquote.
      s.addShape('rect', {
        x, y, w: 0.05, h,
        fill: { color: theme.pptx.accent }, line: { color: theme.pptx.accent },
      });
      break;

    case 'metrics': {
      const n = block.items.length || 1;
      const cw = w / n;
      block.items.forEach((m, i) => {
        s.addText(m.value, {
          x: x + cw * i, y, w: cw, h: h * 0.55,
          fontSize: 34, bold: true, color: theme.pptx.accent, valign: 'bottom',
        });
        s.addText(m.label, {
          x: x + cw * i, y: y + h * 0.55, w: cw, h: h * 0.4,
          fontSize: 12, color: theme.pptx.body, valign: 'top',
        });
      });
      break;
    }

    case 'table':
      s.addTable(
        [
          block.columns.map((c) => ({
            text: c,
            options: { bold: true, color: theme.pptx.title, fill: { color: theme.pptx.bg } },
          })),
          ...block.rows.map((r) => r.map((cell) => ({ text: cell, options: { color: theme.pptx.body } }))),
        ],
        {
          x, y, w,
          fontSize: 12,
          border: { type: 'solid', pt: 0.5, color: theme.pptx.accent },
          autoPage: false,
        }
      );
      break;

    case 'chart': {
      // NATIVE PowerPoint chart — editable in PowerPoint, not a flat image.
      // Only possible because the schema stored structured series data.
      const typeMap = {
        bar: 'bar', line: 'line', pie: 'pie', area: 'area',
      } as const;
      s.addChart(
        typeMap[block.chartType] as Parameters<PptxGenJS.Slide['addChart']>[0],
        block.series.map((ser) => ({
          name: ser.name,
          labels: block.categories,
          values: ser.data,
        })),
        {
          x, y, w, h,
          chartColors: theme.chartColors.map((c) => c.replace('#', '')),
          showLegend: block.series.length > 1,
          legendPos: 'b',
          legendColor: theme.pptx.body,
          catAxisLabelColor: theme.pptx.body,
          valAxisLabelColor: theme.pptx.body,
          catAxisLineShow: false,
          valGridLine: { style: 'dash', color: theme.pptx.body },
          dataLabelColor: theme.pptx.body,
          showTitle: false,
        }
      );
      if (block.caption) {
        s.addText(block.caption, {
          x, y: y + h - 0.22, w, h: 0.22, fontSize: 9, color: theme.pptx.body,
        });
      }
      break;
    }

    case 'image': {
      const data = block.url ? imageData.get(block.url) : undefined;
      if (data) {
        // Base64 from our own bounded fetch — no network I/O inside write().
        s.addImage({ data, x, y, w, h, sizing: { type: 'cover', w, h } });
      } else {
        s.addShape('rect', {
          x, y, w, h,
          fill: { color: theme.pptx.body }, line: { color: theme.pptx.body },
        });
        s.addText(block.alt, { x, y, w, h, fontSize: 11, align: 'center', valign: 'middle', color: theme.pptx.bg });
      }
      break;
    }
  }
}


/**
 * Fetch every image in the deck to a base64 data URI, with hard bounds.
 *
 * Failures are swallowed per-image on purpose: one dead URL should cost that
 * one picture, not the entire export. Missing entries render as a labelled
 * placeholder, which is honest about what happened.
 */
async function resolveImages(deck: Deck): Promise<Map<string, string>> {
  const urls = new Set<string>();
  for (const slide of deck.slides) {
    for (const b of slide.blocks) {
      // SSRF GUARD. This url came from the request body, so it is untrusted:
      // an internal address here would make the server fetch its own metadata
      // endpoint and embed the result. Anything off the allowlist degrades to
      // the same placeholder as a dead link.
      if (b.type === 'image' && b.url && isAllowedImageUrl(b.url)) urls.add(b.url);
    }
  }
  if (!urls.size) return new Map();

  const entries = await Promise.all(
    [...urls].map(async (url): Promise<[string, string] | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      try {
        // redirect:'manual' — following redirects would undo the allowlist:
        // an allowlisted host (or an open redirect on one) could 302 the
        // request to 169.254.169.254 and the fetch would obediently go there.
        // Unsplash serves images directly, so a redirect is not a case we need.
        const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
        if (!res.ok) return null;

        const type = res.headers.get('content-type') ?? '';
        if (!type.startsWith('image/')) return null;

        // Enforce the size cap from the DECLARED length before buffering, so a
        // malicious or misconfigured host cannot make us allocate 500MB just to
        // measure it and throw it away.
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > MAX_IMAGE_BYTES) return null;

        const buf = Buffer.from(await res.arrayBuffer());
        // Cap per image: a 50MB response would blow up the .pptx and memory.
        // Re-checked post-read because content-length may be absent or lie.
        if (buf.byteLength > MAX_IMAGE_BYTES) return null;

        return [url, `data:${type};base64,${buf.toString('base64')}`];
      } catch {
        return null; // timeout, DNS failure, bad TLS — all degrade the same way
      } finally {
        clearTimeout(timer);
      }
    })
  );

  return new Map(entries.filter((e): e is [string, string] => e !== null));
}
