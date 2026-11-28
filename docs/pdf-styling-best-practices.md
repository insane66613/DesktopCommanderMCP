# PDF styling best practices

Desktop Commander's `write_pdf` accepts Markdown and supported embedded HTML/CSS.
Layout behavior depends on the underlying browser renderer, so inspect the final
PDF rather than assuming an input preview proves pagination.

## Page setup

Pass layout through the `options.pdf_options` object:

```json
{
  "pdf_options": {
    "format": "A4",
    "landscape": true,
    "margin": { "top": "0", "right": "0", "bottom": "0", "left": "0" },
    "printBackground": true
  }
}
```

Use `Letter` instead of `A4` for US letter paper. For ordinary reports,
provide realistic margins; zero margins are for deliberate full-bleed layouts.
## Page breaks and related content

An explicit break separates major sections and slide-like pages:

```html
<section style="page-break-inside: avoid;">
  <h2>Evidence summary</h2>
  <p>Keep this heading with its supporting content.</p>
</section>
<div style="page-break-before: always;"></div>
```

`page-break-inside: avoid` is a preference, not a guarantee that oversized
content can fit. Avoid negative margins around rounded headers: wrap them in
a padded container instead.

## Multi-column layouts

If a complex flex layout wraps unpredictably in the PDF renderer, use a
simple HTML table with explicit widths and top-aligned cells:

```html
<table style="width:100%; border-spacing:12px 0;">
  <tr><td style="width:50%; vertical-align:top;">Left</td>
      <td style="width:50%; vertical-align:top;">Right</td></tr>
</table>
```
## Full-page slide pattern

For page-filling colors, request zero margins and `printBackground:true`.
A container using `height:100vh; box-sizing:border-box` can serve as a
starting point for one slide; test its actual height at the chosen paper size.

```html
<div style="background:#223366; color:#fff; padding:48px;
            height:100vh; box-sizing:border-box;">
  <h1>Slide title</h1><p>Key point</p>
</div>
<div style="page-break-before:always;"></div>
```

## Acceptance checklist

- Verify the PDF opens and has the intended number of pages.
- Inspect rendered page images for clipping, cropped cards and missing backgrounds.
- Confirm tables and page breaks stay in the intended places.
- Compare against source for missing text, headers, footers and images.
- Check readable color contrast and reasonable font sizes.
- Preserve the original if editing an existing PDF, using a distinct output path.

The `get_prompts` tool exposes this guidance as `bp_pdf_styling`.
Renderer controls and filesystem permissions still govern the final output.
