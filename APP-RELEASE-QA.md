# App edition 0.1.0 verification

## Implementation

- Retain the existing liquid-glass identity. Mobile uses a photo-first workspace, five bottom tools, scrollable parameter sheets, and a Done action.
- Fix before/after canvas registration at intermediate and mobile widths using the stage container size.
- Skin target mapping preserves chroma direction at gamut boundaries, validates target statistics, and retains semantic gating.
- IndexedDB saves succeed only after transaction commit; quota aborts reject instead of reporting false success.
- Website download dialog has Escape, focus return and focus trapping. Links use a same-origin manifest populated after verifying published release assets. Live inspection caught GitHub anonymous API rate limiting, so the client no longer depends on that API.

## Verified 2026-09-07

- `npm run verify:all`: passed, including browser import, live adjustments, masks, crop, export, rapid switching and reduced motion.
- Five mobile sheets: no overflow/occlusion; original and graded canvas widths match exactly at 390px.
- 375 x 667 with enlarged root font: visible photo and unobstructed controls; landscape 844 x 390 passed.
- Preview P95 25.96ms; curve P95 1.47ms; 24MP export 2121ms on this machine.
- Packaged Windows executable: production page loaded, Node access absent, launch test passed.
- Android release: build and lint passed; APK v1/v2 signatures verified, package `top.colorslab.app`, minimum API 23. Public domain association matches the local release certificate.

## Boundaries

No Android device was connected. Native Android launch/import/export remains unverified. Windows launch is verified, not a full native account/import/export acceptance run. Windows installer is unsigned by a commercial publisher. These are connected test editions, not offline native editors. Synthetic skin regression is not proof of exact matching on every user photograph.

## Inline Impeccable finishing review

Independent reviewer could not run because of its usage limit; performed the supplied fallback review inline. This is an adaptation of an existing product, not a new comp-led concept. Evidence: `qa-private/mobile-tool-1.png`, `qa-private/mobile-tool-2.png`, `qa-private/batch-workflow-desktop.png` and `qa-private/desktop-app.png`.

disposition: ship

### persistence

Pass: the same brand, photo stage, comparison affordance and parameter organization persist across desktop and mobile. Main workflows are exercised by browser tests.

### fidelity

Brand/glass: match. Photo-first mobile and bottom sheets: authorized adaptation. Five tools and Done action: match to requested app-like operation. Download entry: authorized addition. Native offline operation: neither promised nor implemented.

### ceiling

Android device validation remains unused; this disposition covers the responsive web adaptation and packaged test distribution only.

### material_fixes

None for the verified web scope. Device validation limits are explicit in release notes and handoff.

### keep

Keep the large photo, registered comparison canvases, responsive sliders, semantic skin isolation and explicit test-edition disclosure.

The Impeccable detector's advisory palette/type findings were reviewed against the existing brand; no clean-detector claim is made. Its design sidecar is stale and was not silently regenerated.
